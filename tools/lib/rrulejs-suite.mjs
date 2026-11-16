// Extracts the `testRecurring` cases of rrule.js's own test suite
// (packages/ts/test/rrule.test.ts, itself converted from python-dateutil's
// tests) as fixture cases. The test file is transpiled and run with stubbed
// jest globals; every testRecurring() call is recorded with its rule, query
// and the expected dates written in the test.
//
// Out of scope (skipped): TZID (time zones are pluggable, not part of the
// core), BYEASTER (not in the Dart package) and RRuleSet.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, fmt } from './common.mjs';

const require = createRequire(import.meta.url);

export function rrulejsSuiteCases(lib) {
  const ts = require(path.join(ROOT, 'packages/ts/node_modules/typescript'));
  const testFile = path.join(ROOT, 'packages/ts/test/rrule.test.ts');
  const { RRule, RRuleSet } = lib;

  const datetime = (y, m, d, h = 0, i = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, i, s));
  const parse = (str) => {
    const [, y, m, d, h, i, s] = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/).map(Number);
    return datetime(y, m, d, h, i, s);
  };

  const cases = [];
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  function testRecurring(msg, testObj, expected) {
    if (typeof testObj === 'function') testObj = testObj();
    let rule = testObj, method = 'all', args = [];
    if (!(testObj instanceof RRule || testObj instanceof RRuleSet)) ({ rrule: rule, method, args = [] } = testObj);
    if (!(rule instanceof RRule)) return skip('RRuleSet');
    const o = rule.origOptions;
    if (o.tzid) return skip('tzid');
    if (o.byeaster != null) return skip('byeaster');
    if (!o.dtstart) return skip('no dtstart');
    const body = RRule.optionsToString({ ...o, dtstart: undefined, tzid: undefined }).replace(/^RRULE:/, '');
    let query;
    if (method === 'all') query = { method: 'all' };
    else if (method === 'between') query = { method, after: fmt(args[0]), before: fmt(args[1]), inc: !!args[2] };
    else if (method === 'before' || method === 'after') query = { method, dt: fmt(args[0]), inc: !!args[1] };
    else return skip(method);
    const exp = Array.isArray(expected) ? expected.map(fmt) : expected ? fmt(expected) : null;
    cases.push({
      note: msg,
      dtstart: fmt(o.dtstart),
      rrule: body,
      query,
      upstreamExpected: method === 'before' || method === 'after' ? (Array.isArray(exp) ? exp[0] ?? null : exp) : [exp].flat().filter((x) => x != null),
    });
  }
  testRecurring.skip = () => skip('skipped upstream');
  testRecurring.only = testRecurring;

  const noop = () => {};
  const it = noop;
  it.skip = noop;
  it.only = noop;
  const sandbox = {
    require: (m) =>
      m.includes('lib/utils')
        ? { parse, datetime, testRecurring, expectedDate: noop, TEST_CTX: {} }
        : m.includes('src') ? lib : { set: noop, reset: noop },
    exports: {},
    describe: (_, fn) => fn(),
    it,
    beforeAll: noop, afterAll: noop, beforeEach: noop, afterEach: noop,
    expect: () => new Proxy({}, { get: () => noop }),
    Date,
    console,
  };
  const js = ts.transpileModule(fs.readFileSync(testFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  vm.runInNewContext(js, sandbox);
  return { cases, skipped };
}
