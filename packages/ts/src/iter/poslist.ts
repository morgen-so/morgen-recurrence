import { pymod } from '../helpers'
import { ONE_DAY } from '../dateutil'

/**
 * Applies BYSETPOS to one period.
 *
 * `days` holds the `n` day-of-year indices left after filtering, `timeset` the
 * times of day in ms, `base` the epoch ms of the first day of the year.
 * Returns sorted, unique epoch ms.
 *
 * Fixes over rrule.js 2.8.0: a position past either end of the set selects
 * nothing (rrule.js mapped a too-large negative position to the first
 * element via `slice(daypos)[0]`), and equal results are emitted once
 * (rrule.js compared Date objects by identity, so BYSETPOS=1,-1 on a
 * one-element set emitted it twice).
 */
export function buildPoslist(
  bysetpos: number[],
  timeset: number[],
  days: Int32Array,
  n: number,
  base: number
): number[] {
  const tlen = timeset.length
  if (tlen === 0 || n === 0) return []

  const poslist: number[] = []
  for (let j = 0; j < bysetpos.length; j++) {
    const pos = bysetpos[j]
    let daypos: number
    let timepos: number
    if (pos < 0) {
      daypos = Math.floor(pos / tlen)
      timepos = pymod(pos, tlen)
    } else {
      daypos = Math.floor((pos - 1) / tlen)
      timepos = pymod(pos - 1, tlen)
    }
    const idx = daypos < 0 ? n + daypos : daypos
    if (idx < 0 || idx >= n) continue

    const res = base + days[idx] * ONE_DAY + timeset[timepos]
    if (poslist.indexOf(res) === -1) poslist.push(res)
  }

  poslist.sort((a, b) => a - b)
  return poslist
}
