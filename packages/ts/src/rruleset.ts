import { RRule } from './rrule'
import { sort, timeToUntilString, isValidDate } from './dateutil'
import { copyWithZone, rezoneValue } from './timezone'
import { includes } from './helpers'
import IterResult from './iterresult'
import { iterSet } from './iterset'
import { QueryMethodTypes, IterResultType } from './types'
import { rrulestr } from './rrulestr'
import { optionsToString } from './optionstostring'

function createGetterSetter<T>(fieldName: string) {
  return (field?: T) => {
    if (field !== undefined) {
      this[`_${fieldName}`] = field
      this._invalidateCache()
    }

    if (this[`_${fieldName}`] !== undefined) {
      return this[`_${fieldName}`]
    }

    for (let i = 0; i < this._rrule.length; i++) {
      const field: T = this._rrule[i].origOptions[fieldName]
      if (field) {
        return field
      }
    }
  }
}

export class RRuleSet extends RRule {
  public readonly _rrule: RRule[]
  public readonly _rdate: Date[]
  public readonly _exrule: RRule[]
  public readonly _exdate: Date[]

  public _dtstart?: Date | null | undefined
  public _tzid?: string

  /**
   *
   * @param {Boolean?} noCache
   * The same stratagy as RRule on cache, default to false
   * @constructor
   */
  constructor(noCache = false) {
    super({}, noCache)

    this._rrule = []
    this._rdate = []
    this._exrule = []
    this._exdate = []
  }

  dtstart = createGetterSetter.apply(this, ['dtstart'])
  tzid = createGetterSetter.apply(this, ['tzid'])

  _iter<M extends QueryMethodTypes>(
    iterResult: IterResult<M>
  ): IterResultType<M> {
    return iterSet(
      iterResult,
      this._rrule,
      this._exrule,
      this._rdate,
      this._exdate,
      this.tzid()
    )
  }

  /**
   * Adds an RRule to the set
   *
   * @param {RRule}
   */
  rrule(rrule: RRule) {
    _addRule(rrule, this._rrule)
    this._invalidateCache()
  }

  /**
   * Adds an EXRULE to the set
   *
   * @param {RRule}
   */
  exrule(rrule: RRule) {
    _addRule(rrule, this._exrule)
    this._invalidateCache()
  }

  /**
   * Adds an RDate to the set
   *
   * @param {Date}
   */
  rdate(date: Date) {
    _addDate(date, this._rdate)
    this._invalidateCache()
  }

  /**
   * Adds an EXDATE to the set
   *
   * @param {Date}
   */
  exdate(date: Date) {
    _addDate(date, this._exdate)
    this._invalidateCache()
  }

  /**
   * Get list of included rrules in this recurrence set.
   *
   * @return List of rrules
   */
  rrules() {
    return this._rrule.map((e) => rrulestr(e.toString()))
  }

  /**
   * Get list of excluded rrules in this recurrence set.
   *
   * @return List of exrules
   */
  exrules() {
    return this._exrule.map((e) => rrulestr(e.toString()))
  }

  /**
   * Get list of included datetimes in this recurrence set.
   *
   * @return List of rdates
   */
  rdates() {
    return this._rdate.map(copyWithZone)
  }

  /**
   * Get list of included datetimes in this recurrence set.
   *
   * @return List of exdates
   */
  exdates() {
    return this._exdate.map(copyWithZone)
  }

  valueOf() {
    let result: string[] = []

    if (!this._rrule.length && this._dtstart) {
      result = result.concat(optionsToString({ dtstart: this._dtstart }))
    }

    this._rrule.forEach(function (rrule) {
      result = result.concat(rrule.toString().split('\n'))
    })

    this._exrule.forEach(function (exrule) {
      result = result.concat(
        exrule
          .toString()
          .split('\n')
          .map((line) => line.replace(/^RRULE:/, 'EXRULE:'))
          .filter((line) => !/^DTSTART/.test(line))
      )
    })

    if (this._rdate.length) {
      result.push(rdatesToString('RDATE', this._rdate, this.tzid()))
    }

    if (this._exdate.length) {
      result.push(rdatesToString('EXDATE', this._exdate, this.tzid()))
    }

    return result
  }

  /**
   * to generate recurrence field such as:
   * DTSTART:19970902T010000Z
   * RRULE:FREQ=YEARLY;COUNT=2;BYDAY=TU
   * RRULE:FREQ=YEARLY;COUNT=1;BYDAY=TH
   */
  toString() {
    return this.valueOf().join('\n')
  }

  /**
   * Create a new RRuleSet Object completely base on current instance
   */
  clone(): RRuleSet {
    // Morgen fix: rrule.js passed `!!this._cache` as `noCache` (inverting
    // it) and lost an explicitly set DTSTART/TZID and maxPeriods.
    const rrs = new RRuleSet(!this._cache)
    rrs._dtstart = this._dtstart
    rrs._tzid = this._tzid
    rrs.maxPeriods = this.maxPeriods

    this._rrule.forEach((rule) => rrs.rrule(rule.clone()))
    this._exrule.forEach((rule) => rrs.exrule(rule.clone()))
    this._rdate.forEach((date) => rrs.rdate(copyWithZone(date)))
    this._exdate.forEach((date) => rrs.exdate(copyWithZone(date)))

    return rrs
  }

  all(iterator?: (d: Date, len: number) => boolean): Date[] {
    if (iterator) return this._chronological('all', {}, iterator)
    return super.all()
  }

  between(
    after: Date,
    before: Date,
    inc = false,
    iterator?: (d: Date, len: number) => boolean
  ): Date[] {
    if (iterator) {
      if (!isValidDate(after) || !isValidDate(before)) {
        throw new Error('Invalid date passed in to RRuleSet.between')
      }
      return this._chronological('between', { after, before, inc }, iterator)
    }
    return super.between(after, before, inc)
  }

  /**
   * Morgen fix: calls `iterator` on the set's dates in chronological order.
   * rrule.js ran it on each RRULE (and the RDATEs) separately, in insertion
   * order, so a callback limit kept the first rule's dates instead of the
   * earliest ones. The set is expanded window by window (doubling the
   * window), so unbounded rules are never expanded eagerly.
   */
  private _chronological(
    method: 'all' | 'between',
    args: { after?: Date; before?: Date; inc?: boolean },
    iterator: (d: Date, len: number) => boolean
  ): Date[] {
    const result: Date[] = []
    const upper = method === 'between' ? args.before.getTime() : Infinity
    let from: number
    let inclusive: boolean
    if (method === 'between') {
      from = args.after.getTime()
      inclusive = !!args.inc
    } else {
      // Earliest possible date: the earliest DTSTART or RDATE, widened by
      // the largest offset a time zone adapter can apply.
      const starts = this._rrule.map((r) => r.options.dtstart.getTime())
      this._rdate.forEach((d) => starts.push(rezoneValue(d, this.tzid()).getTime()))
      if (!starts.length) return result
      from = Math.min(...starts) - 2 * 86400000
      inclusive = true
    }
    if (method === 'between' && upper < from) return result

    // Start with one hour and double: a callback that stops early never
    // expands much more than it consumes, even for SECONDLY rules.
    for (let span = 3600000; ; span *= 2) {
      const to = Math.min(from + span, upper)
      const lowerInc = inclusive
      const upperInc = to === upper ? method === 'all' || !!args.inc : true
      const chunk = this._iter(
        new IterResult('between', {
          after: new Date(lowerInc ? from : from + 1),
          before: new Date(upperInc ? to : to - 1),
          inc: true,
        })
      ) as Date[]
      for (const date of chunk) {
        if (!iterator(date, result.length)) return result
        result.push(date)
      }
      if (to >= upper) return result
      // Stop once nothing is left after this window.
      if (this._iter(new IterResult('after', { dt: new Date(to), inc: false })) === null) {
        return result
      }
      from = to
      inclusive = false
    }
  }
}

function _addRule(rrule: RRule, collection: RRule[]) {
  if (!(rrule instanceof RRule)) {
    throw new TypeError(String(rrule) + ' is not RRule instance')
  }

  if (!includes(collection.map(String), String(rrule))) {
    collection.push(rrule)
  }
}

function _addDate(date: Date, collection: Date[]) {
  if (!(date instanceof Date)) {
    throw new TypeError(String(date) + ' is not Date instance')
  }
  if (!includes(collection.map(Number), Number(date))) {
    collection.push(date)
    sort(collection)
  }
}

function rdatesToString(
  param: string,
  rdates: Date[],
  tzid: string | undefined
) {
  const isUTC = !tzid || tzid.toUpperCase() === 'UTC'
  const header = isUTC ? `${param}:` : `${param};TZID=${tzid}:`

  const dateString = rdates
    .map((rdate) => timeToUntilString(rdate.valueOf(), isUTC))
    .join(',')

  return `${header}${dateString}`
}
