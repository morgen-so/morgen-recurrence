// Which cases of the corpus change when switching from an upstream rrule.js
// version to this fork, grouped by rule shape.
//
//   node tools/impact.mjs <path/to/node_modules/rrule> [fixtures.json ...]
//   node tools/impact.mjs <path/to/node_modules/rrule> rules.ndjson
//
// rules.ndjson: one {"dtstart": "YYYY-MM-DDTHH:MM:SS", "rrule": "FREQ=..."}
// per line, e.g. exported from production (rule strings only, no PII). Each
// rule is expanded over [now - 1 year, now + 2 years] (like the clients'
// expansion windows), expected values coming from this fork.
//
// Each case runs in a worker thread; a case that does not finish within 3 s
// counts as a hang (rrule.js loops forever on some sub-daily rules).
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, loadTs, evaluate, fmt } from './lib/common.mjs';

const [pkg, ...files] = process.argv.slice(2);
if (!pkg) {
  console.error('usage: node tools/impact.mjs <path/to/rrule> [fixtures.json ...]');
  process.exit(2);
}
const fixtureFiles = files.length ? files : fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => path.join(FIXTURES, f));

const workerSrc = `
const { parentPort, workerData } = require('node:worker_threads');
const lib = require(workerData.pkg);
const fmt = (d) => { const s = d.toISOString(); return s.endsWith('.000Z') ? s.slice(0, 19) : s.slice(0, 23); };
const P = (s) => new Date(s + 'Z');
parentPort.on('message', (c) => {
  let got;
  try {
    const o = lib.RRule.parseString(c.rrule); o.dtstart = P(c.dtstart);
    const r = new lib.RRule(o, true); const q = c.query; const limit = q.limit ?? Infinity; const cb = (_, n) => n < limit;
    if (q.method === 'all') got = r.all(cb).map(fmt);
    else if (q.method === 'between') got = r.between(P(q.after), P(q.before), !!q.inc, cb).map(fmt);
    else { const d = r[q.method](P(q.dt), !!q.inc); got = d ? fmt(d) : null; }
  } catch (e) { got = { error: true }; }
  parentPort.postMessage(got);
});`;

function shapes(rule) {
  const r = Object.fromEntries(rule.split(';').map((p) => p.split('=')));
  const s = [];
  const byday = r.BYDAY ? r.BYDAY.split(',') : [];
  if ((r.FREQ === 'MONTHLY' || r.FREQ === 'YEARLY') && byday.some((d) => /\d/.test(d)) && byday.some((d) => !/\d/.test(d))) s.push('mixed plain+nth BYDAY');
  if (r.BYSETPOS) s.push('BYSETPOS');
  for (const k of ['BYHOUR', 'BYMINUTE', 'BYSECOND']) {
    const v = r[k]?.split(',').map(Number);
    if (v && v.some((x, i) => i && x <= v[i - 1])) s.push(`unsorted/duplicate ${k}`);
  }
  if ((r.FREQ === 'MINUTELY' || r.FREQ === 'SECONDLY') && (r.BYHOUR || r.BYMINUTE)) s.push(`${r.FREQ} with BYHOUR/BYMINUTE`);
  if (r.BYWEEKNO) s.push('BYWEEKNO');
  if (r.FREQ === 'WEEKLY' && r.BYSETPOS) s.push('WEEKLY+BYSETPOS (first week)');
  if (r.SKIP) s.push('SKIP (rrule.js rejects it)');
  return s.length ? s : ['other'];
}

let worker;
const start = () => (worker = new Worker(workerSrc, { eval: true, workerData: { pkg: path.resolve(pkg) } }));
start();
function run(c) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { worker.terminate(); start(); resolve({ hang: true }); }, 3000);
    worker.once('message', (m) => { clearTimeout(timer); resolve(m); });
    worker.postMessage(c);
  });
}

const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
function loadCases(f) {
  if (!f.endsWith('.ndjson')) return JSON.parse(fs.readFileSync(f, 'utf8')).cases;
  const fork = loadTs();
  const now = Date.now();
  const query = { method: 'between', after: fmt(new Date(now - 365 * 86400000)), before: fmt(new Date(now + 730 * 86400000)), inc: true };
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    const { dtstart, rrule } = JSON.parse(line);
    const c = { id: `line-${i + 1}`, dtstart, rrule: rrule.replace(/^RRULE:/, ''), query };
    const got = evaluate(fork, c);
    return { ...c, expected: got && got.error ? { error: true } : got };
  });
}

let total = 0, changed = 0;
const byShape = {}, examples = {};
for (const f of fixtureFiles) {
  for (const c of loadCases(f)) {
    total++;
    const got = await run(c);
    if (JSON.stringify(got) === JSON.stringify(c.expected)) continue;
    changed++;
    const kind = got && got.hang ? 'hang' : c.expected && c.expected.error ? 'now rejected' : Array.isArray(got) && Array.isArray(c.expected) && got.length === 0 ? 'none -> some' : 'different';
    for (const s of shapes(c.rrule)) {
      const key = `${s} [${kind}]`;
      byShape[key] = (byShape[key] ?? 0) + 1;
      (examples[key] ??= []).push(`${c.id} ${c.rrule}`);
    }
  }
}
await worker.terminate();
console.log(`rrule.js ${version} vs fork: ${changed} of ${total} cases differ (${((100 * changed) / total).toFixed(1)}%)\n`);
for (const [k, n] of Object.entries(byShape).sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${k}   e.g. ${examples[k][0]}`);
}
