// JSCalendar (RFC 8984) RecurrenceRule -> RFC 5545 RRULE string with the same
// meaning. Unlike the plain mapping in common.mjs (toRRuleString), this adds
// the properties RFC 8984 section 4.3.3.1 (step 3) implicitly adds, and the
// skip property (RFC 7529). Written independently of the Dart converter
// (RRuleOptions.fromJsCalendar) so the corpus can check it.
import { toRRuleString } from './common.mjs';

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

/** @param start floating "YYYY-MM-DDTHH:MM:SS" */
export function jscalToRRule(rule, start) {
  const d = new Date(`${start}Z`);
  const r = { ...rule };
  const startDay = DAYS[(d.getUTCDay() + 6) % 7];
  const has = (k) => Array.isArray(r[k]) && r[k].length > 0;
  const hadByDay = has('byDay'), hadByMonthDay = has('byMonthDay');
  switch (r.frequency) {
    case 'weekly':
      if (!hadByDay) r.byDay = [{ day: startDay }];
      break;
    case 'monthly':
      if (!hadByDay && !hadByMonthDay) r.byMonthDay = [d.getUTCDate()];
      break;
    case 'yearly':
      if (!has('byYearDay')) {
        if (!has('byMonth') && !has('byWeekNo') && (hadByMonthDay || !hadByDay)) r.byMonth = [String(d.getUTCMonth() + 1)];
        if (!hadByMonthDay && !has('byWeekNo') && !hadByDay) r.byMonthDay = [d.getUTCDate()];
        if (has('byWeekNo') && !hadByMonthDay && !hadByDay) r.byDay = [{ day: startDay }];
      }
      break;
  }
  let s = toRRuleString(r);
  if (r.skip && r.skip !== 'omit') s += `;RSCALE=GREGORIAN;SKIP=${r.skip.toUpperCase()}`;
  return s;
}
