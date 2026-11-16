import { RRule } from './rrule'
import { sort, timeToUntilString, isValidDate } from './dateutil'
import { copyWithZone, getValueZone, isUTC, rezoneValue, UTC_INSTANT } from './timezone'
import { includes } from './helpers'
import IterResult from './iterresult'
import { iterSet } from './iterset'
import { QueryMethodTypes, IterResultType } from './types'
import { iter } from './iter'
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

    result.push(...rdatesToString('RDATE', this._rdate, this.tzid()))
    result.push(...rdatesToString('EXDATE', this._exdate, this.tzid()))

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
   * earliest ones.
   *
   * Expansion is bounded by demand, not by time: each RRULE, EXRULE and the
   * RDATEs are streams merged lazily. A rule stream is refilled in batches
   * that stop after a number of results (doubling at each refill up to
   * MAX_BATCH), resuming after the last instant fetched. An EXRULE stream
   * seeks to the candidate it is tested against, so the exclusions between
   * two candidates are skipped, never stored. Memory therefore stays within
   * a few batches per rule plus the returned dates, however dense the rules
   * (a SECONDLY rule after a year-old RDATE, a SECONDLY EXRULE). Each refill
   * re-runs the rule from its DTSTART, like rrule.js's own exclusion checks.
   */
  private _chronological(
    method: 'all' | 'between',
    args: { after?: Date; before?: Date; inc?: boolean },
    iterator: (d: Date, len: number) => boolean
  ): Date[] {
    const result: Date[] = []
    let lo = -Infinity
    let hi = Infinity
    if (method === 'between') {
      lo = args.inc ? args.after.getTime() : args.after.getTime() + 1
      hi = args.inc ? args.before.getTime() : args.before.getTime() - 1
      if (hi < lo) return result
    }
    const tzid = this.tzid()

    const rdates = this._rdate
      .map((d) => rezoneValue(d, tzid).getTime())
      .filter((t) => t >= lo && t <= hi)
      .sort((a, b) => a - b)
    const sources: Stream[] = this._rrule.map((r) => new RuleStream(r, lo, hi))
    if (rdates.length) sources.push(new ArrayStream(rdates))
    const exdates = new Set(this._exdate.map((d) => rezoneValue(d, tzid).getTime()))
    const exrules = this._exrule.map((r) => new RuleStream(r, lo, hi))

    let last = NaN
    for (;;) {
      let best: Stream | null = null
      let bestT = Infinity
      for (let i = 0; i < sources.length; i++) {
        const t = sources[i].peek()
        if (t < bestT) {
          bestT = t
          best = sources[i]
        }
      }
      if (best === null) return result
      best.next()
      if (bestT === last) continue
      last = bestT
      if (exdates.has(bestT)) continue
      let excluded = false
      for (let i = 0; i < exrules.length && !excluded; i++) {
        excluded = exrules[i].seek(bestT) === bestT
      }
      if (excluded) continue
      const date = new Date(bestT)
      if (!iterator(date, result.length)) return result
      result.push(date)
    }
  }
}

/** Ascending epoch-ms source; peek() is Infinity once exhausted. */
interface Stream {
  peek(): number
  next(): void
}

class ArrayStream implements Stream {
  private i = 0
  constructor(private readonly values: number[]) {}
  peek() {
    return this.i < this.values.length ? this.values[this.i] : Infinity
  }
  next() {
    this.i++
  }
}

/** Collects up to `budget` occurrences after `from` (exclusive) and <= `hi`. */
class BatchResult extends IterResult<'between'> {
  public readonly out: number[] = []
  constructor(
    private readonly from: number,
    private readonly hi: number,
    private readonly budget: number
  ) {
    // 'between' only so that iter() stops at the period after `hi`.
    super('between', {
      after: new Date(0),
      before: new Date(Number.isFinite(hi) ? hi : 8.64e15),
      inc: true,
    })
  }
  accept(date: Date) {
    const t = date.getTime()
    if (t <= this.from) return true
    if (t > this.hi) return false
    this.out.push(t)
    return this.out.length < this.budget
  }
}

/** Largest batch a rule stream holds (dates as numbers: 512 KB). */
const MAX_BATCH = 65536

class RuleStream implements Stream {
  private buf: number[] = []
  private i = 0
  private done = false
  private budget = 8
  private from: number

  constructor(private readonly rule: RRule, lo: number, private readonly hi: number) {
    this.from = lo - 1
  }

  /**
   * First date >= t (Infinity if none), dropping the earlier ones. When the
   * batch runs out, the next one starts at t instead of after the last date
   * fetched.
   */
  seek(t: number) {
    while (this.i < this.buf.length && this.buf[this.i] < t) this.i++
    if (this.i >= this.buf.length && !this.done) {
      if (t - 1 > this.from) this.from = t - 1
      this.refill()
    }
    return this.peek()
  }

  peek() {
    if (this.i >= this.buf.length) {
      if (this.done) return Infinity
      this.refill()
      if (this.i >= this.buf.length) return Infinity
    }
    return this.buf[this.i]
  }

  next() {
    this.i++
  }

  private refill() {
    const batch = new BatchResult(this.from, this.hi, this.budget)
    iter(batch, this.rule.options, this.rule.maxPeriods)
    this.buf = batch.out
    this.i = 0
    if (batch.out.length < this.budget) this.done = true
    else this.from = batch.out[batch.out.length - 1]
    if (this.budget < MAX_BATCH) this.budget *= 2
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

/**
 * Morgen fix: a value is a duplicate only if both its raw fields and its
 * time domain (see timezone.ts) are equal. rrule.js compared raw
 * milliseconds, so `RDATE:20240101T090000Z` and
 * `RDATE;TZID=Europe/Zurich:20240101T090000` (different instants) collapsed
 * into one. Values that one adapter maps to the same instant are kept apart
 * too, since another adapter may not; equal instants are emitted once.
 */
function _addDate(date: Date, collection: Date[]) {
  if (!(date instanceof Date)) {
    throw new TypeError(String(date) + ' is not Date instance')
  }
  const ms = date.getTime()
  const zone = getValueZone(date)
  for (let i = 0; i < collection.length; i++) {
    if (collection[i].getTime() === ms && getValueZone(collection[i]) === zone) return
  }
  collection.push(date)
  sort(collection)
}

/**
 * Morgen fix: one property line per time domain, so every value keeps its
 * meaning when the text is parsed again. rrule.js wrote every value with the
 * set's TZID, so `EXDATE:20240102T080000Z` in a Europe/Zurich set came back
 * as `EXDATE;TZID=Europe/Zurich:20240102T080000`, a different instant.
 */
function rdatesToString(
  param: string,
  rdates: Date[],
  tzid: string | undefined
): string[] {
  const groups = new Map<string, string[]>()
  for (const rdate of rdates) {
    const zone = getValueZone(rdate)
    let header: string
    let utc: boolean
    if (zone === UTC_INSTANT) {
      header = `${param}:`
      utc = true
    } else {
      // Own TZID, or the set's for values that follow it.
      const z = zone ?? tzid
      utc = zone === undefined && isUTC(z)
      header = utc ? `${param}:` : `${param};TZID=${z}:`
    }
    // A header without TZID always holds UTC values.
    if (!groups.has(header)) groups.set(header, [])
    groups.get(header).push(timeToUntilString(rdate.getTime(), utc))
  }
  const lines: string[] = []
  groups.forEach((values, header) => lines.push(header + values.join(',')))
  return lines
}
