/**
 * Pluggable time zone support.
 *
 * The library contains no time zone data and never calls `Intl`: rules are
 * expanded on floating times (a `Date` whose UTC fields hold the wall-clock
 * time). Only when a rule or set has a TZID other than UTC is the adapter
 * asked to turn such a wall-clock time into the `Date` to return.
 *
 * Without an adapter (the default) wall-clock times are returned as they are,
 * which is what `DTSTART;TZID=UTC:...` callers get from rrule.js too.
 *
 * Example with moment-timezone:
 *
 *   setTimeZoneAdapter({
 *     fromWallTime: (wall, tzid) =>
 *       moment.tz(wall.toISOString().slice(0, 23), tzid).toDate(),
 *   })
 */
export interface TimeZoneAdapter {
  /**
   * Converts a floating wall-clock time (UTC fields of `wallTime`) in time
   * zone `tzid` to the instant to return to the caller.
   */
  fromWallTime(wallTime: Date, tzid: string): Date
}

let adapter: TimeZoneAdapter | null = null

/** Installs (or with `null` removes) the process-wide time zone adapter. */
export function setTimeZoneAdapter(a: TimeZoneAdapter | null) {
  adapter = a
}

export function getTimeZoneAdapter(): TimeZoneAdapter | null {
  return adapter
}

export function isUTC(tzid: string | null | undefined) {
  return !tzid || tzid.toUpperCase() === 'UTC'
}

/** Whether results with this TZID go through the adapter. */
export function needsRezone(tzid: string | null | undefined) {
  return adapter !== null && !isUTC(tzid)
}

export function rezone(date: Date, tzid: string | null | undefined): Date {
  if (adapter === null || isUTC(tzid)) return date
  return adapter.fromWallTime(date, tzid as string)
}
