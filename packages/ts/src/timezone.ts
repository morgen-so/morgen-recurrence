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
let generation = 0

/**
 * Installs (or with `null` removes) the process-wide time zone adapter.
 * Results cached by existing rules are discarded (see getAdapterGeneration).
 */
export function setTimeZoneAdapter(a: TimeZoneAdapter | null) {
  adapter = a
  generation++
}

/** Changes whenever the adapter is installed, replaced or removed. */
export function getAdapterGeneration() {
  return generation
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

// -----------------------------------------------------------------------------
// Time domain of individual RDATE/EXDATE values.
//
// A set converts its RDATE/EXDATE values with the set's TZID, which is right
// for floating values. Values parsed from text can also be UTC instants
// ("20240102T080000Z", never converted) or carry their own TZID. rrulestr
// records that here, keyed by the Date object, so programmatic rdate() and
// exdate() keep their meaning.
// -----------------------------------------------------------------------------

/** Marker for a value that is already a UTC instant. */
export const UTC_INSTANT = '\u0000UTC'

const valueZones = new WeakMap<Date, string>()

export function setValueZone(date: Date, zone: string) {
  valueZones.set(date, zone)
  return date
}

/**
 * Recorded time domain of an RDATE/EXDATE value: UTC_INSTANT, its own TZID,
 * or undefined for a value that follows the set's TZID (floating values and
 * programmatic rdate()/exdate()).
 */
export function getValueZone(date: Date): string | undefined {
  return valueZones.get(date)
}

/** Copy of `date` keeping its recorded time domain. */
export function copyWithZone(date: Date) {
  const copy = new Date(date.getTime())
  const zone = valueZones.get(date)
  if (zone !== undefined) valueZones.set(copy, zone)
  return copy
}

/** Converts an RDATE/EXDATE value once, according to its time domain. */
export function rezoneValue(date: Date, setTzid: string | null | undefined): Date {
  const zone = valueZones.get(date)
  if (zone === UTC_INSTANT) return date
  return rezone(date, zone ?? setTzid)
}
