// The backtest itself (run by backtest.test.ts, see there). Same metrics and definitions as the former
// ml/train.py backtest(), but the simulation is the app's own engine (resolve + runPath).
import { BASE_MACRO } from '../lib/macro'
import { resolve } from '../lib/resolve'
import { mulberry32, quantile } from '../lib/rng'
import { runPath } from '../lib/sim'
import type { Backtest, Params, Profile } from '../lib/types'

const r = (x: number, n = 4) => Math.round(x * 10 ** n) / 10 ** n
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const median = (a: number[]) => quantile(Float64Array.from(a).sort(), 0.5)

export function runBacktest(params: Params, profiles: Profile[], nPaths = 1000): Backtest {
  const rand = mulberry32(params.seed)
  let inside80 = 0
  let inside50 = 0
  let monthInside80 = 0
  let monthTotal = 0
  const pit: number[] = []
  const gains: Float64Array[] = []
  const realGain: number[] = []
  const negPred: number[] = []
  const negReal: number[] = []
  const errModel: number[] = []
  const errNaive: number[] = []
  const brierModel: number[] = []
  const brierNaive: number[] = []
  const empty = { name: 'today', catalog_id: null, events: [] }
  for (const p of profiles) {
    const real = p.ledger_closing_cash
    if (real.length !== 24) throw new Error(`${p.id}: expected 24 ledger months`)
    const start = real[11] // closing cash of December 2025
    // 2026 only: real Dec-2025 cash, no loans or investments (the ledger has no loan payments), 12 months from January
    const plan = resolve({ ...p, age: p.age + 1, cash: start, investments: 0, loans: [], home: 0 }, params, empty, {}, 12, 0, BASE_MACRO)
    const paths = Array.from({ length: 12 }, () => new Float64Array(nPaths))
    const end = new Float64Array(nPaths)
    let anyNeg = 0
    for (let k = 0; k < nPaths; k++) {
      const o = runPath(plan, params, rand)
      let neg = false
      for (let t = 0; t < 12; t++) {
        paths[t][k] = o.cash[t]
        if (o.cash[t] < 0) neg = true
      }
      end[k] = o.cash[11]
      if (neg) anyNeg++
    }
    const actual = real.slice(12)
    const sorted = paths.map((x) => Float64Array.from(x).sort())
    const q = (t: number, lv: number) => quantile(sorted[t], lv)
    for (let t = 0; t < 12; t++) if (q(t, 0.1) <= actual[t] && actual[t] <= q(t, 0.9)) monthInside80++
    monthTotal += 12
    const a = actual[11]
    if (q(11, 0.1) <= a && a <= q(11, 0.9)) inside80++
    if (q(11, 0.25) <= a && a <= q(11, 0.75)) inside50++
    pit.push(end.reduce((n, x) => n + (x <= a ? 1 : 0), 0) / nPaths)
    gains.push(end.map((x) => x - start))
    realGain.push(a - start)
    errModel.push(Math.abs(q(11, 0.5) - a))
    const naive = start + (start - p.cash) // Dec-2025 cash + 12 × average 2025 monthly net flow
    errNaive.push(Math.abs(naive - a))
    const wentNeg = actual.some((x) => x < 0) ? 1 : 0
    const pNeg = anyNeg / nPaths
    brierModel.push((pNeg - wentNeg) ** 2)
    negPred.push(pNeg)
    negReal.push(wentNeg)
    const naiveNeg = Array.from({ length: 12 }, (_, t) => start + ((t + 1) * (naive - start)) / 12).some((x) => x < 0) ? 1 : 0
    brierNaive.push((naiveNeg - wentNeg) ** 2)
  }

  // "A ends higher than B": random pairs of people, the model's probability vs what really happened in 2026
  const prand = mulberry32(params.seed + 1)
  const n = profiles.length
  const said: number[] = []
  const happened: number[] = []
  const perm = new Float64Array(nPaths)
  for (let pair = 0; pair < 20000; pair++) {
    const i = Math.floor(prand() * n)
    const j = Math.floor(prand() * n)
    if (i === j) continue
    perm.set(gains[j])
    for (let k = nPaths - 1; k > 0; k--) {
      const s = Math.floor(prand() * (k + 1))
      const tmp = perm[k]
      perm[k] = perm[s]
      perm[s] = tmp
    }
    let wins = 0
    for (let k = 0; k < nPaths; k++) if (gains[i][k] > perm[k]) wins++
    said.push(wins / nPaths)
    happened.push(realGain[i] > realGain[j] ? 1 : 0)
  }
  const bins: [number, number][] = [[0, 0.05], [0.05, 0.2], [0.2, 0.5], [0.5, 0.8], [0.8, 0.95], [0.95, 1.01]]
  const endsHigher = bins.flatMap(([lo, hi]) => {
    const idx = said.flatMap((x, k) => (x >= lo && x < hi ? [k] : []))
    return idx.length ? [{ said: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, pairs: idx.length, avg_said: r(mean(idx.map((k) => said[k])), 3), real: r(mean(idx.map((k) => happened[k])), 3) }] : []
  })
  const negBins: [string, number, number][] = [['under 5%', 0, 0.05], ['5-50%', 0.05, 0.5], ['50-95%', 0.5, 0.95], ['over 95%', 0.95, 1.01]]

  return {
    method: 'parameters estimated on 2025 only (R, model_parameters_fit2025.csv); the app engine simulates 2026 from real Dec-2025 cash (today’s economy); compared with the real 2026 ledger',
    profiles: n,
    paths_per_profile: nPaths,
    coverage_80_year_end: r(inside80 / n),
    coverage_50_year_end: r(inside50 / n),
    coverage_80_all_months: r(monthInside80 / monthTotal),
    // calibration curve: "we said X% of results fall in this range" vs what really happened
    calibration_central: [10, 20, 30, 40, 50, 60, 70, 80, 90].map((lv) => ({ said: lv, real: r(mean(pit.map((u) => (Math.abs(u - 0.5) <= lv / 200 ? 1 : 0))), 3) })),
    calibration_ends_higher: endsHigher,
    // probability check: grouped by how likely we said "cash goes below zero in 2026" was
    calibration_negative_cash: negBins.flatMap(([said, lo, hi]) => {
      const idx = negPred.flatMap((x, k) => (x >= lo && x < hi ? [k] : []))
      return idx.length ? [{ said, profiles: idx.length, avg_said: r(mean(idx.map((k) => negPred[k])), 3), real: r(mean(idx.map((k) => negReal[k])), 3) }] : []
    }),
    median_abs_error_year_end_chf: r(median(errModel), 2),
    median_abs_error_naive_chf: r(median(errNaive), 2),
    brier_negative_cash_model: r(mean(brierModel)),
    brier_negative_cash_naive: r(mean(brierNaive)),
    naive_definition: 'Dec-2025 cash + 12 x average 2025 monthly net flow, no uncertainty',
  }
}
