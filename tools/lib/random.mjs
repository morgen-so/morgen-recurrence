// Random rule generators. Adapted from morgen-mobile tool/rrule_diff
// (gen_fixtures.mjs, gen_fixtures_weekno.mjs), plus a sub-daily generator.
// Each returns {dtstart, rrule, jscal, features, query}; expected values are
// filled in by the caller from the fixed TypeScript package.
import { prng, pad, fmt, toRRuleString } from './common.mjs';

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const LIMIT = 40;
const YEAR_MS = 365 * 86400000;

function betweenQuery(start, years) {
  const bound = new Date(Date.parse(`${start}Z`) + years * YEAR_MS);
  return { method: 'between', after: start, before: fmt(bound), inc: true, limit: LIMIT };
}

function finish(start, rule, features, query) {
  return { dtstart: start, rrule: toRRuleString(rule), jscal: { '@type': 'RecurrenceRule', ...rule }, features: [...new Set(features)], query };
}

/** General DAILY..YEARLY rules biased towards edge cases. */
export function* randomCases(count, seed) {
  const { int, pick, chance, sample } = prng(seed);
  for (let i = 0; i < count; i++) {
    const features = [];
    let y = int(2000, 2030), m = int(1, 12), d = int(1, 28);
    if (chance(0.15)) { d = pick([29, 30, 31]); features.push('monthEndStart'); }
    if (chance(0.05)) { y = pick([2000, 2004, 2024, 2028]); m = 2; d = 29; features.push('leapDayStart'); }
    else if (chance(0.04)) { m = pick([1, 12]); d = m === 1 ? 1 : 31; features.push('yearEdgeStart'); }
    d = Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate());
    const h = chance(0.2) ? 0 : int(6, 22), mi = pick([0, 0, 0, 15, 30, 45]);
    const start = `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`;

    const frequency = pick(['yearly', 'monthly', 'monthly', 'weekly', 'weekly', 'weekly', 'daily', 'daily']);
    const rule = { frequency };
    features.push(frequency);
    if (chance(0.35)) { rule.interval = int(2, 4); features.push('interval'); }
    if (frequency === 'weekly' && chance(0.2)) {
      rule.interval = int(2, 3);
      rule.firstDayOfWeek = pick(['su', 'su', 'sa', 'we']);
      features.push('interval', 'weeklyWkst');
    }
    const nthAllowed = frequency === 'monthly' || frequency === 'yearly';
    if (chance(frequency === 'weekly' ? 0.7 : 0.35)) {
      const days = sample(DAYS, int(1, frequency === 'weekly' ? 4 : 2));
      rule.byDay = days.map((day) => {
        const nd = { '@type': 'NDay', day };
        if (nthAllowed && chance(0.6)) nd.nthOfPeriod = pick([1, 2, 3, 4, -1, -2]);
        return nd;
      });
      const nth = rule.byDay.filter((x) => x.nthOfPeriod).length;
      features.push(nth === 0 ? 'byDay' : nth === rule.byDay.length ? 'byDayNth' : 'byDayMixed');
    }
    if (frequency !== 'weekly' && chance(0.25)) {
      rule.byMonthDay = sample([1, 2, 10, 15, 28, 29, 30, 31, -1, -2], int(1, 2));
      features.push('byMonthDay');
    }
    if ((frequency === 'yearly' || chance(0.1)) && chance(0.5)) {
      rule.byMonth = sample(['1', '2', '3', '6', '9', '12'], int(1, 2));
      features.push('byMonth');
    }
    if (frequency === 'yearly' && chance(0.08)) { rule.byYearDay = [pick([1, 100, 200, 365, -1])]; features.push('byYearDay'); }
    if (frequency === 'yearly' && !rule.byDay?.some((x) => x.nthOfPeriod) && chance(0.08)) {
      rule.byWeekNo = [pick([1, 10, 20, 52, 53, -1])]; features.push('byWeekNo');
    }
    if ((frequency === 'daily' || frequency === 'weekly') && chance(0.2)) {
      rule.byHour = sample([0, 6, 9, 12, 13, 18, 23], int(1, 3));
      if (chance(0.6)) rule.byHour.sort((a, b) => a - b);
      features.push('byHour');
      if (rule.byHour.some((v, k) => k && v < rule.byHour[k - 1])) features.push('byHourUnsorted');
      if (chance(0.5)) {
        rule.byMinute = sample([0, 15, 30, 45], int(1, 2));
        if (chance(0.6)) rule.byMinute.sort((a, b) => a - b);
        features.push('byMinute');
      }
    } else if (frequency !== 'daily' && frequency !== 'weekly' && chance(0.04)) {
      rule.byHour = sample([8, 17], int(1, 2));
      features.push('byHour');
    }
    const hasBy = rule.byDay || rule.byMonthDay || rule.byMonth || rule.byYearDay || rule.byWeekNo || rule.byHour;
    if (hasBy && chance(0.25)) {
      rule.bySetPosition = pick([[1], [2], [-1], [-1], [-2], [1, -1], [-1, -2], [-3, -1], [2, 3, -1], [-2, 4], [-1, -6, 5], [-7]]);
      features.push(rule.bySetPosition.length > 1 ? 'bySetPosMulti' : 'bySetPosition');
    }
    if (!rule.firstDayOfWeek && chance(0.3)) { rule.firstDayOfWeek = 'su'; features.push('wkstSunday'); }

    const end = chance(0.35) ? 'count' : chance(0.55) ? 'until' : 'none';
    if (end === 'count') { rule.count = int(1, 30); features.push('count'); }
    else if (end === 'until') {
      rule.until = fmt(new Date(Date.parse(`${start}Z`) + int(1, 900) * 86400000 + int(-3, 3) * 3600000));
      features.push('until');
    }
    yield finish(start, rule, features, betweenQuery(start, 10));
  }
}

/** BYWEEKNO / BYYEARDAY with every week start and frequency. */
export function* weeknoCases(count, seed) {
  const { int, pick, chance, sample } = prng(seed);
  for (let i = 0; i < count; i++) {
    const y = int(1995, 2035), m = pick([1, 1, 6, 12, 12]);
    const d = Math.min(pick([1, 2, 15, 28, 29, 30, 31]), new Date(Date.UTC(y, m, 0)).getUTCDate());
    const start = `${y}-${pad(m)}-${pad(d)}T${pad(int(0, 23))}:00:00`;
    const frequency = pick(['yearly', 'yearly', 'yearly', 'monthly', 'weekly', 'daily']);
    const rule = { frequency }, features = [frequency];
    if (chance(0.3)) rule.interval = int(2, 3);
    if (chance(0.6)) { rule.byWeekNo = sample([1, 2, 26, 51, 52, 53, -1, -2, -52, -53], int(1, 2)); features.push('byWeekNo'); }
    else { rule.byYearDay = sample([1, 2, 60, 100, 365, 366, -1, -2, -365, -366], int(1, 2)); features.push('byYearDay'); }
    if (chance(0.6)) { rule.byDay = sample(DAYS, int(1, 3)).map((day) => ({ '@type': 'NDay', day })); features.push('byDay'); }
    if (chance(0.15)) { rule.byMonth = [String(pick([1, 12]))]; features.push('byMonth'); }
    if (chance(0.7)) { rule.firstDayOfWeek = pick(DAYS); features.push(`wkst-${rule.firstDayOfWeek}`); }
    if (chance(0.3)) rule.count = int(1, 20);
    else if (chance(0.4)) rule.until = fmt(new Date(Date.parse(`${start}Z`) + int(30, 3000) * 86400000));
    yield finish(start, rule, features, betweenQuery(start, 10));
  }
}

/** HOURLY / MINUTELY / SECONDLY rules, including unreachable BY* parts. */
export function* subdailyCases(count, seed) {
  const { int, pick, chance, sample } = prng(seed);
  for (let i = 0; i < count; i++) {
    const y = int(2000, 2030), m = int(1, 12), d = int(1, 28);
    const start = `${y}-${pad(m)}-${pad(d)}T${pad(int(0, 23))}:${pad(pick([0, 0, 15, 30, 45, 59]))}:${pad(pick([0, 0, 0, 30]))}`;
    const frequency = pick(['hourly', 'hourly', 'minutely', 'minutely', 'secondly']);
    const rule = { frequency }, features = [frequency];
    if (chance(0.6)) { rule.interval = pick([2, 3, 5, 6, 7, 15, 20, 45, 90]); features.push('interval'); }
    if (chance(0.4)) {
      rule.byHour = sample([0, 3, 8, 9, 12, 17, 18, 23], int(1, 3));
      features.push('byHour');
      if (rule.byHour.some((v, k) => k && v < rule.byHour[k - 1])) features.push('byHourUnsorted');
    }
    if (frequency !== 'hourly' || chance(0.3)) {
      if (chance(0.4)) { rule.byMinute = sample([0, 10, 15, 30, 45, 59], int(1, 3)); features.push('byMinute'); }
    }
    if (frequency === 'secondly' && chance(0.4)) { rule.bySecond = sample([0, 15, 30, 59], int(1, 2)); features.push('bySecond'); }
    if (chance(0.25)) { rule.byDay = sample(DAYS, int(1, 3)).map((day) => ({ '@type': 'NDay', day })); features.push('byDay'); }
    if (chance(0.1)) { rule.byMonthDay = [pick([1, 15, 31, -1])]; features.push('byMonthDay'); }
    if (chance(0.15)) { rule.bySetPosition = [pick([1, 2, -1])]; features.push('bySetPosition'); }
    if (chance(0.4)) rule.count = int(1, 30);
    else if (chance(0.5)) rule.until = fmt(new Date(Date.parse(`${start}Z`) + int(1, 72) * 3600000));
    const query = chance(0.5) ? { method: 'all', limit: LIMIT } : betweenQuery(start, 0.05);
    yield finish(start, rule, features, query);
  }
}
