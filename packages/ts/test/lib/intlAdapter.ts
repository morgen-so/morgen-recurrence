// TEST ONLY. Reproduces rrule.js 2.8.0's built-in Intl time zone conversion
// (src/dateutil.ts dateInTimeZone, removed from the library) as a
// TimeZoneAdapter, so that rrule.js's own TZID tests keep checking that the
// adapter is called exactly where rrule.js converted. Applications must plug
// in their own adapter (e.g. moment-timezone), never this one.
import { TimeZoneAdapter } from '../../src/timezone'

const dateTZtoISO8601 = function (date: Date, timeZone: string) {
  // date format for sv-SE is almost ISO8601
  const dateStr = date.toLocaleString('sv-SE', { timeZone })
  return dateStr.replace(' ', 'T') + 'Z'
}

export const dateInTimeZone = function (date: Date, timeZone: string) {
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const dateInLocalTZ = new Date(dateTZtoISO8601(date, localTimeZone))
  const dateInTargetTZ = new Date(dateTZtoISO8601(date, timeZone ?? 'UTC'))
  const tzOffset = dateInTargetTZ.getTime() - dateInLocalTZ.getTime()
  return new Date(date.getTime() - tzOffset)
}

export const rrulejsIntlAdapter: TimeZoneAdapter = {
  fromWallTime: (date, tzid) => dateInTimeZone(date, tzid),
}
