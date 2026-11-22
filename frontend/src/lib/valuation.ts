// Rolling-horizon valuation: what a path is worth in TODAY's money (net present value, NPV), for every horizon.
// One discount rate for every path, person and economy: DEFAULT_DISCOUNT_PCT unless the user sets one (a labelled assumption).
// Amounts are constant 2025 francs, so the rate is a real rate. Used only to VALUE paths: the simulation never changes.
//
// For month t (0-based, as in the engine) and one simulated future:
//   DF[t]  = (1+d)^(−(t+1)/12)                          same monthly convention as the investment return (UBS FV = PV(1+r)^n)
//   NPV_t  = startCash + Σ_{s≤t} DF[s]·(cash_s − cash_{s−1}) + DF[t]·(netWorth_t − cash_t)
// Each franc that comes in or goes out counts in today's money when it happens; what you own minus what you owe
// (investments + home − debt) counts in today's money at the horizon. With d = 0 the NPV equals net worth; money
// invested at a return equal to d leaves it unchanged (contributions are end-of-month, as in the engine).
import type { Band } from './sim'

export const DEFAULT_DISCOUNT_PCT = 3

export function discountFactors(annualRate: number, H: number): Float64Array {
  const df = new Float64Array(H)
  const m = Math.pow(1 + Math.max(-0.99, annualRate), -1 / 12)
  let f = 1
  for (let t = 0; t < H; t++) {
    f *= m
    df[t] = f
  }
  return df
}

/** NPV at every month of one future (cash and net worth as written by the engine) */
export function npvSeries(startCash: number, cash: Float64Array, nw: Float64Array, df: Float64Array): Float64Array {
  const out = new Float64Array(cash.length)
  let s = 0
  let prev = startCash
  for (let t = 0; t < cash.length; t++) {
    s += df[t] * (cash[t] - prev)
    prev = cash[t]
    out[t] = startCash + s + df[t] * (nw[t] - cash[t])
  }
  return out
}

export type CatchUp = {
  /** which path ends ahead in today's money (median NPV at the horizon); 'tie' within max(1,000, 1%) */
  ahead: 'a' | 'b' | 'tie'
  /** age from which the path ending ahead stays ahead until the horizon; null = ahead at every year */
  fromAge: number | null
}

/** Rolling-horizon comparison: compare the median NPV of two paths at the end of every year (year 1..N). */
export function catchUp(a: Band[], b: Band[], startAge: number): CatchUp {
  const n = Math.min(Math.floor(a.length / 12), Math.floor(b.length / 12))
  if (!n) return { ahead: 'tie', fromAge: null }
  const ya = Array.from({ length: n }, (_, i) => a[i * 12 + 11].p50)
  const yb = Array.from({ length: n }, (_, i) => b[i * 12 + 11].p50)
  const endDiff = ya[n - 1] - yb[n - 1]
  if (Math.abs(endDiff) <= Math.max(1000, 0.01 * Math.max(Math.abs(ya[n - 1]), Math.abs(yb[n - 1])))) return { ahead: 'tie', fromAge: null }
  const [lead, other] = endDiff > 0 ? [ya, yb] : [yb, ya]
  let lastBehind = -1 // last year (0-based) at which the path ending ahead was still behind
  for (let i = 0; i < n; i++) if (lead[i] < other[i]) lastBehind = i
  return { ahead: endDiff > 0 ? 'a' : 'b', fromAge: lastBehind < 0 ? null : Math.floor(startAge) + lastBehind + 2 }
}
