// Hand-written cases: regressions for the rrule.js 2.8.0 bugs fixed in this
// fork, and the RFC 5545 section 3.8.5.3 examples.

const all = (limit) => (limit ? { method: 'all', limit } : { method: 'all' });
const between = (after, before, limit = 40) => ({ method: 'between', after, before, inc: true, limit });

// `expected` is verified by hand (calendar arithmetic noted per case) and
// asserted against the fixed TypeScript package by gen-fixtures.mjs.
export const REGRESSIONS = [
  // Bug 1: plain + nth BYDAY in MONTHLY/YEARLY were AND-ed (no occurrences).
  {
    bug: 'mixed-byday', note: 'Jan 2024: 2nd Wednesday = 10th; Saturdays 6, 13, 20, 27. rrule.js 2.8.0: []',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=2WE,SA;COUNT=6', query: all(),
    expected: ['2024-01-06T09:00:00', '2024-01-10T09:00:00', '2024-01-13T09:00:00', '2024-01-20T09:00:00', '2024-01-27T09:00:00', '2024-02-03T09:00:00'],
  },
  {
    bug: 'mixed-byday', note: 'March 2024: first Monday = 4th; Fridays 1, 8, 15, 22, 29. rrule.js 2.8.0: []',
    dtstart: '2024-01-01T08:00:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=1MO,FR;COUNT=6', query: all(),
    expected: ['2024-03-01T08:00:00', '2024-03-04T08:00:00', '2024-03-08T08:00:00', '2024-03-15T08:00:00', '2024-03-22T08:00:00', '2024-03-29T08:00:00'],
  },
  {
    bug: 'mixed-byday', note: 'Last Friday or any Monday; Feb 2025: Mondays 3, 10, 17, 24, last Friday 28. rrule.js 2.8.0: []',
    dtstart: '2025-02-01T10:00:00', rrule: 'FREQ=MONTHLY;BYDAY=-1FR,MO', query: between('2025-02-01T00:00:00', '2025-02-28T23:59:59'),
    expected: ['2025-02-03T10:00:00', '2025-02-10T10:00:00', '2025-02-17T10:00:00', '2025-02-24T10:00:00', '2025-02-28T10:00:00'],
  },
  // Bug 2: BYSETPOS out-of-range negative positions and duplicates.
  {
    bug: 'bysetpos', note: 'Mondays: Jan 1..29 (5), Feb 5..26 (4), Mar 4..25 (4), Apr 1..29 (5); -6 selects nothing, -1 and 5 coincide. rrule.js 2.8.0: Jan 1, Jan 29, Jan 29, Feb 5',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1,-6,5;COUNT=4', query: all(),
    expected: ['2024-01-29T09:00:00', '2024-02-26T09:00:00', '2024-03-25T09:00:00', '2024-04-29T09:00:00'],
  },
  {
    bug: 'bysetpos', note: 'One Sunday per week: positions 1 and -1 are the same day. rrule.js 2.8.0: every Sunday twice',
    dtstart: '2024-01-07T10:00:00', rrule: 'FREQ=WEEKLY;BYDAY=SU;BYSETPOS=1,-1;COUNT=3', query: all(),
    expected: ['2024-01-07T10:00:00', '2024-01-14T10:00:00', '2024-01-21T10:00:00'],
  },
  {
    bug: 'bysetpos', note: 'Fifth Monday only exists in Jan, Apr, Jul 2024 (positive overflow already worked)',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5;COUNT=3', query: all(),
    expected: ['2024-01-29T09:00:00', '2024-04-29T09:00:00', '2024-07-29T09:00:00'],
  },
  {
    bug: 'bysetpos', note: 'Sixth-to-last Monday never exists. rrule.js 2.8.0: the first Monday of every month',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-6', query: between('2024-01-01T00:00:00', '2024-12-31T23:59:59'),
    expected: [],
  },
  // Bug 3: unsorted BYHOUR/BYMINUTE.
  {
    bug: 'unsorted-byhour', note: 'rrule.js 2.8.0: 18:00 before 9:00 each day',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=DAILY;BYHOUR=18,9;BYMINUTE=0;COUNT=4', query: all(),
    expected: ['2024-01-01T09:00:00', '2024-01-01T18:00:00', '2024-01-02T09:00:00', '2024-01-02T18:00:00'],
  },
  {
    bug: 'unsorted-byhour', note: 'rrule.js 2.8.0 stops at 18:00 on Jan 3 (> UNTIL) before emitting 9:00 that day',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=DAILY;BYHOUR=18,9;BYMINUTE=0;UNTIL=20240103T120000', query: all(),
    expected: ['2024-01-01T09:00:00', '2024-01-01T18:00:00', '2024-01-02T09:00:00', '2024-01-02T18:00:00', '2024-01-03T09:00:00'],
  },
  {
    bug: 'unsorted-byhour', note: 'Duplicate and unsorted BYMINUTE. rrule.js 2.8.0: 9:30, 9:00, 9:30',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=DAILY;BYMINUTE=30,0,30;COUNT=2', query: all(),
    expected: ['2024-01-01T09:00:00', '2024-01-01T09:30:00'],
  },
  // Bug 4: runaway iteration.
  {
    bug: 'runaway', note: 'Each day has at most one of SA/MO, so position 2 never exists. rrule.js 2.8.0: iterates to year 9999 (~4 s)',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=DAILY;BYDAY=SA,MO;BYSETPOS=2', query: between('2024-01-01T00:00:00', '2026-01-01T00:00:00'),
    expected: [],
  },
  {
    bug: 'runaway', note: 'From 00:00 every 6 hours visits 0, 6, 12, 18 only. rrule.js 2.8.0: infinite loop',
    dtstart: '2024-01-01T00:00:00', rrule: 'FREQ=HOURLY;INTERVAL=6;BYHOUR=3', query: all(),
    expected: [],
  },
  {
    bug: 'runaway', note: 'From :00 every 20 minutes never reaches :10. rrule.js 2.8.0: infinite loop',
    dtstart: '2024-01-01T00:00:00', rrule: 'FREQ=MINUTELY;INTERVAL=20;BYMINUTE=10', query: between('2024-01-01T00:00:00', '2024-01-02T00:00:00'),
    expected: [],
  },
  {
    bug: 'runaway', note: 'February 30 does not exist. rrule.js 2.8.0: iterates to year 9999 for between()',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', query: between('2024-01-01T00:00:00', '2030-01-01T00:00:00'),
    expected: [],
  },
  {
    bug: 'runaway', note: 'before() of a never-matching rule',
    dtstart: '2024-01-01T09:00:00', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=4,6', query: { method: 'before', dt: '2030-01-01T00:00:00', inc: false },
    expected: null,
  },
  // The runaway safety net must not cut off productive rules: e.g. backend
  // workflow schedules call after(now) on rules anchored long ago.
  {
    bug: 'period-cap', note: 'MINUTELY rule anchored 17 months earlier (~760k periods): after() must still find the next run',
    dtstart: '2024-01-01T00:00:00', rrule: 'FREQ=MINUTELY;INTERVAL=30', query: { method: 'after', dt: '2025-06-01T00:10:00', inc: false },
    expected: '2025-06-01T00:30:00',
  },
  {
    bug: 'period-cap', note: 'HOURLY rule anchored 30 years earlier (~263k periods)',
    dtstart: '1995-01-01T08:00:00', rrule: 'FREQ=HOURLY;INTERVAL=2', query: { method: 'between', after: '2025-01-01T00:00:00', before: '2025-01-01T05:00:00', inc: true },
    expected: ['2025-01-01T00:00:00', '2025-01-01T02:00:00', '2025-01-01T04:00:00'],
  },
];

// RFC 5545 section 3.8.5.3. DTSTART is floating (the RFC uses
// TZID=America/New_York; the wall-clock results are the same). rfcExpected
// lists the first dates printed in the RFC, checked as a prefix.
export const RFC5545 = [
  { note: 'Daily for 10 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=DAILY;COUNT=10', query: all(),
    rfcExpected: ['02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].map((d) => `1997-09-${d}T09:00:00`) },
  { note: 'Daily until December 24, 1997', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=DAILY;UNTIL=19971224T000000Z', query: all() },
  { note: 'Every other day - forever', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=DAILY;INTERVAL=2', query: between('1997-09-01T00:00:00', '1997-12-31T23:59:59', 100),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-04T09:00:00', '1997-09-06T09:00:00'] },
  { note: 'Every 10 days, 5 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=DAILY;INTERVAL=10;COUNT=5', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-12T09:00:00', '1997-09-22T09:00:00', '1997-10-02T09:00:00', '1997-10-12T09:00:00'] },
  { note: 'Every day in January, for 3 years (yearly)', dtstart: '1998-01-01T09:00:00', rrule: 'FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA', query: all() },
  { note: 'Every day in January, for 3 years (daily)', dtstart: '1998-01-01T09:00:00', rrule: 'FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1', query: all() },
  { note: 'Weekly for 10 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;COUNT=10', query: all() },
  { note: 'Weekly until December 24, 1997', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;UNTIL=19971224T000000Z', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-09T09:00:00'] },
  { note: 'Every other week - forever', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;WKST=SU', query: between('1997-09-01T00:00:00', '1998-02-28T00:00:00') },
  { note: 'Weekly on Tuesday and Thursday for five weeks (UNTIL)', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH', query: all() },
  { note: 'Weekly on Tuesday and Thursday for five weeks (COUNT)', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-04T09:00:00', '1997-09-09T09:00:00', '1997-09-11T09:00:00'] },
  { note: 'Every other week on Monday, Wednesday, and Friday until December 24, 1997', dtstart: '1997-09-01T09:00:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR', query: all(),
    rfcExpected: ['1997-09-01T09:00:00', '1997-09-03T09:00:00', '1997-09-05T09:00:00', '1997-09-15T09:00:00'] },
  { note: 'Every other week on Tuesday and Thursday, for 8 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-04T09:00:00', '1997-09-16T09:00:00', '1997-09-18T09:00:00', '1997-09-30T09:00:00', '1997-10-02T09:00:00', '1997-10-14T09:00:00', '1997-10-16T09:00:00'] },
  { note: 'Monthly on the first Friday for 10 occurrences', dtstart: '1997-09-05T09:00:00', rrule: 'FREQ=MONTHLY;COUNT=10;BYDAY=1FR', query: all(),
    rfcExpected: ['1997-09-05T09:00:00', '1997-10-03T09:00:00', '1997-11-07T09:00:00', '1997-12-05T09:00:00', '1998-01-02T09:00:00', '1998-02-06T09:00:00'] },
  { note: 'Monthly on the first Friday until December 24, 1997', dtstart: '1997-09-05T09:00:00', rrule: 'FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR', query: all(),
    rfcExpected: ['1997-09-05T09:00:00', '1997-10-03T09:00:00', '1997-11-07T09:00:00', '1997-12-05T09:00:00'] },
  { note: 'Every other month on the first and last Sunday, 10 occurrences', dtstart: '1997-09-07T09:00:00', rrule: 'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU', query: all(),
    rfcExpected: ['1997-09-07T09:00:00', '1997-09-28T09:00:00', '1997-11-02T09:00:00', '1997-11-30T09:00:00', '1998-01-04T09:00:00', '1998-01-25T09:00:00'] },
  { note: 'Monthly on the second-to-last Monday for 6 months', dtstart: '1997-09-22T09:00:00', rrule: 'FREQ=MONTHLY;COUNT=6;BYDAY=-2MO', query: all(),
    rfcExpected: ['1997-09-22T09:00:00', '1997-10-20T09:00:00', '1997-11-17T09:00:00', '1997-12-22T09:00:00', '1998-01-19T09:00:00', '1998-02-16T09:00:00'] },
  { note: 'Monthly on the third-to-the-last day of the month, forever', dtstart: '1997-09-28T09:00:00', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-3', query: between('1997-09-01T00:00:00', '1998-03-01T00:00:00'),
    rfcExpected: ['1997-09-28T09:00:00', '1997-10-29T09:00:00', '1997-11-28T09:00:00', '1997-12-29T09:00:00', '1998-01-29T09:00:00', '1998-02-26T09:00:00'] },
  { note: 'Monthly on the 2nd and 15th of the month for 10 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-15T09:00:00', '1997-10-02T09:00:00', '1997-10-15T09:00:00'] },
  { note: 'Monthly on the first and last day of the month for 10 occurrences', dtstart: '1997-09-30T09:00:00', rrule: 'FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1', query: all(),
    rfcExpected: ['1997-09-30T09:00:00', '1997-10-01T09:00:00', '1997-10-31T09:00:00', '1997-11-01T09:00:00', '1997-11-30T09:00:00'] },
  { note: 'Every 18 months on the 10th thru 15th of the month for 10 occurrences', dtstart: '1997-09-10T09:00:00', rrule: 'FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15', query: all(),
    rfcExpected: ['1997-09-10T09:00:00', '1997-09-11T09:00:00', '1997-09-12T09:00:00', '1997-09-13T09:00:00', '1997-09-14T09:00:00', '1997-09-15T09:00:00', '1999-03-10T09:00:00'] },
  { note: 'Every Tuesday, every other month', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=TU', query: between('1997-09-01T00:00:00', '1998-04-01T00:00:00'),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-09T09:00:00', '1997-09-16T09:00:00', '1997-09-23T09:00:00', '1997-09-30T09:00:00', '1997-11-04T09:00:00'] },
  { note: 'Yearly in June and July for 10 occurrences', dtstart: '1997-06-10T09:00:00', rrule: 'FREQ=YEARLY;COUNT=10;BYMONTH=6,7', query: all(),
    rfcExpected: ['1997-06-10T09:00:00', '1997-07-10T09:00:00', '1998-06-10T09:00:00', '1998-07-10T09:00:00'] },
  { note: 'Every other year on January, February, and March for 10 occurrences', dtstart: '1997-03-10T09:00:00', rrule: 'FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3', query: all(),
    rfcExpected: ['1997-03-10T09:00:00', '1999-01-10T09:00:00', '1999-02-10T09:00:00', '1999-03-10T09:00:00'] },
  { note: 'Every third year on the 1st, 100th, and 200th day for 10 occurrences', dtstart: '1997-01-01T09:00:00', rrule: 'FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200', query: all(),
    rfcExpected: ['1997-01-01T09:00:00', '1997-04-10T09:00:00', '1997-07-19T09:00:00', '2000-01-01T09:00:00', '2000-04-09T09:00:00', '2000-07-18T09:00:00'] },
  { note: 'Every 20th Monday of the year, forever', dtstart: '1997-05-19T09:00:00', rrule: 'FREQ=YEARLY;BYDAY=20MO', query: between('1997-01-01T00:00:00', '2000-01-01T00:00:00'),
    rfcExpected: ['1997-05-19T09:00:00', '1998-05-18T09:00:00', '1999-05-17T09:00:00'] },
  { note: 'Monday of week number 20, forever', dtstart: '1997-05-12T09:00:00', rrule: 'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO', query: between('1997-01-01T00:00:00', '2000-01-01T00:00:00'),
    rfcExpected: ['1997-05-12T09:00:00', '1998-05-11T09:00:00', '1999-05-17T09:00:00'] },
  { note: 'Every Thursday in March, forever', dtstart: '1997-03-13T09:00:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=TH', query: between('1997-01-01T00:00:00', '2000-01-01T00:00:00'),
    rfcExpected: ['1997-03-13T09:00:00', '1997-03-20T09:00:00', '1997-03-27T09:00:00', '1998-03-05T09:00:00'] },
  { note: 'Every Thursday, but only during June, July, and August, forever', dtstart: '1997-06-05T09:00:00', rrule: 'FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8', query: between('1997-01-01T00:00:00', '1999-01-01T00:00:00', 100),
    rfcExpected: ['1997-06-05T09:00:00', '1997-06-12T09:00:00', '1997-06-19T09:00:00', '1997-06-26T09:00:00', '1997-07-03T09:00:00'] },
  { note: 'Every Friday the 13th, forever (RFC excludes DTSTART with EXDATE)', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', query: between('1997-01-01T00:00:00', '2001-01-01T00:00:00'),
    rfcExpected: ['1998-02-13T09:00:00', '1998-03-13T09:00:00', '1998-11-13T09:00:00', '1999-08-13T09:00:00', '2000-10-13T09:00:00'] },
  { note: 'The first Saturday that follows the first Sunday of the month, forever', dtstart: '1997-09-13T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13', query: between('1997-01-01T00:00:00', '1998-07-01T00:00:00'),
    rfcExpected: ['1997-09-13T09:00:00', '1997-10-11T09:00:00', '1997-11-08T09:00:00', '1997-12-13T09:00:00', '1998-01-10T09:00:00', '1998-02-07T09:00:00', '1998-03-07T09:00:00', '1998-04-11T09:00:00', '1998-05-09T09:00:00', '1998-06-13T09:00:00'] },
  { note: 'U.S. Presidential Election day, every 4 years', dtstart: '1996-11-05T09:00:00', rrule: 'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8', query: between('1996-01-01T00:00:00', '2005-01-01T00:00:00'),
    rfcExpected: ['1996-11-05T09:00:00', '2000-11-07T09:00:00', '2004-11-02T09:00:00'] },
  { note: 'The third instance into the month of one of Tuesday, Wednesday, or Thursday, for the next 3 months', dtstart: '1997-09-04T09:00:00', rrule: 'FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3', query: all(),
    rfcExpected: ['1997-09-04T09:00:00', '1997-10-07T09:00:00', '1997-11-06T09:00:00'] },
  { note: 'The second-to-last weekday of the month', dtstart: '1997-09-29T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2', query: between('1997-01-01T00:00:00', '1998-04-01T00:00:00'),
    rfcExpected: ['1997-09-29T09:00:00', '1997-10-30T09:00:00', '1997-11-27T09:00:00', '1997-12-30T09:00:00', '1998-01-29T09:00:00', '1998-02-26T09:00:00', '1998-03-30T09:00:00'] },
  { note: 'Every 3 hours from 9:00 AM to 5:00 PM on a specific day', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-02T12:00:00', '1997-09-02T15:00:00'] },
  { note: 'Every 15 minutes for 6 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MINUTELY;INTERVAL=15;COUNT=6', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-02T09:15:00', '1997-09-02T09:30:00', '1997-09-02T09:45:00', '1997-09-02T10:00:00', '1997-09-02T10:15:00'] },
  { note: 'Every hour and a half for 4 occurrences', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MINUTELY;INTERVAL=90;COUNT=4', query: all(),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-02T10:30:00', '1997-09-02T12:00:00', '1997-09-02T13:30:00'] },
  { note: 'Every 20 minutes from 9:00 AM to 4:40 PM every day (daily)', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40', query: between('1997-09-02T00:00:00', '1997-09-04T00:00:00', 100),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-02T09:20:00', '1997-09-02T09:40:00', '1997-09-02T10:00:00'] },
  { note: 'Every 20 minutes from 9:00 AM to 4:40 PM every day (minutely)', dtstart: '1997-09-02T09:00:00', rrule: 'FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16', query: between('1997-09-02T00:00:00', '1997-09-04T00:00:00', 100),
    rfcExpected: ['1997-09-02T09:00:00', '1997-09-02T09:20:00', '1997-09-02T09:40:00', '1997-09-02T10:00:00'] },
  { note: 'WKST changes the result: WKST=MO', dtstart: '1997-08-05T09:00:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', query: all(),
    rfcExpected: ['1997-08-05T09:00:00', '1997-08-10T09:00:00', '1997-08-19T09:00:00', '1997-08-24T09:00:00'] },
  { note: 'WKST changes the result: WKST=SU', dtstart: '1997-08-05T09:00:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', query: all(),
    rfcExpected: ['1997-08-05T09:00:00', '1997-08-17T09:00:00', '1997-08-19T09:00:00', '1997-08-31T09:00:00'] },
  { note: 'Invalid dates (February 30) are ignored', dtstart: '2007-01-15T09:00:00', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5', query: all(),
    rfcExpected: ['2007-01-15T09:00:00', '2007-01-30T09:00:00', '2007-02-15T09:00:00', '2007-03-15T09:00:00', '2007-03-30T09:00:00'] },
];
