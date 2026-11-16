import IterResult from './iterresult'
import { RRule } from './rrule'
import { rezoneValue } from './timezone'
import { iter } from './iter'
import { sort } from './dateutil'
import { QueryMethodTypes, IterResultType } from './types'

export function iterSet<M extends QueryMethodTypes>(
  iterResult: IterResult<M>,
  _rrule: RRule[],
  _exrule: RRule[],
  _rdate: Date[],
  _exdate: Date[],
  tzid: string | undefined
) {
  const _exdateHash: { [k: number]: boolean } = {}
  const _accept = iterResult.accept

  function evalExdate(after: Date, before: Date) {
    _exrule.forEach(function (rrule) {
      rrule.between(after, before, true).forEach(function (date) {
        _exdateHash[Number(date)] = true
      })
    })
  }

  _exdate.forEach(function (date) {
    const zonedDate = rezoneValue(date, tzid)
    _exdateHash[Number(zonedDate)] = true
  })

  iterResult.accept = function (date) {
    const dt = Number(date)
    if (isNaN(dt)) return _accept.call(this, date)
    if (!_exdateHash[dt]) {
      evalExdate(new Date(dt - 1), new Date(dt + 1))
      if (!_exdateHash[dt]) {
        _exdateHash[dt] = true
        return _accept.call(this, date)
      }
    }
    return true
  }

  if (iterResult.method === 'between') {
    evalExdate(iterResult.args.after, iterResult.args.before)
    iterResult.accept = function (date) {
      const dt = Number(date)
      if (!_exdateHash[dt]) {
        _exdateHash[dt] = true
        return _accept.call(this, date)
      }
      return true
    }
  }

  // RDATE values are converted (each in its own time domain) and sorted as
  // instants before they meet the query bounds: values in different domains
  // can be in a different order as instants than as raw wall-clock fields,
  // and accept() stops at the first value past a bound.
  const rdateMs = new Array<number>(_rdate.length)
  for (let i = 0; i < _rdate.length; i++) {
    rdateMs[i] = rezoneValue(_rdate[i], tzid).getTime()
  }
  rdateMs.sort((a, b) => a - b)
  for (let i = 0; i < rdateMs.length; i++) {
    if (!iterResult.accept(new Date(rdateMs[i]))) break
  }

  _rrule.forEach(function (rrule) {
    iter(iterResult, rrule.options, rrule.maxPeriods)
  })

  const res = iterResult._result
  sort(res)
  switch (iterResult.method) {
    case 'all':
    case 'between':
      return res as IterResultType<M>
    case 'before':
      return ((res.length && res[res.length - 1]) || null) as IterResultType<M>
    case 'after':
    default:
      return ((res.length && res[0]) || null) as IterResultType<M>
  }
}
