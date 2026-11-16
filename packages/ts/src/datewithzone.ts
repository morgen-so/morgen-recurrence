import { timeToUntilString } from './dateutil'
import { isUTC, rezone } from './timezone'

export class DateWithZone {
  public date: Date
  public tzid?: string | null

  constructor(date: Date, tzid?: string | null) {
    if (isNaN(date.getTime())) {
      throw new RangeError('Invalid date passed to DateWithZone')
    }
    this.date = date
    this.tzid = tzid
  }

  private get isUTC() {
    return isUTC(this.tzid)
  }

  public toString() {
    const datestr = timeToUntilString(this.date.getTime(), this.isUTC)
    if (!this.isUTC) {
      return `;TZID=${this.tzid}:${datestr}`
    }

    return `:${datestr}`
  }

  public getTime() {
    return this.date.getTime()
  }

  /**
   * The date as returned to callers: unchanged for floating/UTC rules,
   * otherwise converted by the installed TimeZoneAdapter (see timezone.ts).
   * rrule.js used Intl here; this fork has no built-in time zone support.
   */
  public rezonedDate() {
    return rezone(this.date, this.tzid)
  }
}
