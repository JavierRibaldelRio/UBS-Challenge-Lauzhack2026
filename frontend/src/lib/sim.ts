// Monte Carlo engine. Accounting is exact (formulas); randomness comes ONLY from what ml/train.py
// learned from the ledger: monthly spending surprises, December bonus, uncertainty of the personal
// spending level (+ investment noise if the user sets a volatility).
//
// Per month t, per path:
//   cash[t+1] = cash[t] + income + bonus + loan_in - spending - extra - one_off - invest_transfer - loan_payment
//   invest[t+1] = (invest[t] + invest_transfer) * (1 + r_t) * (1 - shock)
//   debt[t+1] = debt[t] + interest - loan_payment      (never below 0)
//   net_worth = cash + invest - debt
// All branches use the SAME random numbers (common random numbers), so differences between
// branches come from the decision, not from luck.
import { fromQuantiles, mulberry32, normal, quantile } from './rng'
import type { Params, Profile } from './types'
import type { Plan } from './resolve'
import { monthIndex } from './fmt'

export type Knobs = {
  income: number
  rent: number
  other: number
  oneOff: number
  retShift: number // added to annual return
  incomeFrom?: { month: number; scale: number } // scale income from this month (break-even search)
}
export const NO_KNOBS: Knobs = { income: 1, rent: 1, other: 1, oneOff: 1, retShift: 0 }

export type Band = { p10: number; p50: number; p90: number }
export type GoalResult = { name: string; target: number; date: string; month: number; prob: number | null; medianLiquid: number | null }
export type SimResult = {
  nw: Band[]
  cash: Band[]
  endNW: Band
  endCash: Band
  minCash: Band
  probNegCash: number
  firstNegMonth: number | null // median month cash first goes negative (if >= 50% of paths do)
  goals: GoalResult[]
  meanPath: { cash: number[]; nw: number[] }
}

type PathOut = { cash: Float64Array; nw: Float64Array; liquid: Float64Array }

/** One path. deterministic=true -> expected values, no noise (used for drivers, break-even, checks). */
export function runPath(plan: Plan, params: Params, rand: (() => number) | null, knobs: Knobs = NO_KNOBS, ledger?: LedgerRow[]): PathOut {
  const H = plan.months
  const cash = new Float64Array(H)
  const nw = new Float64Array(H)
  const liquid = new Float64Array(H)
  let c = plan.startCash
  let v = plan.startInvest
  const debt = plan.loans.map((l) => (l.isNew ? 0 : l.principal))
  const muShift = rand ? plan.muSe * normal(rand) : 0
  const retM = (plan.invReturn + knobs.retShift) / 12
  const volM = plan.invVol / Math.sqrt(12)

  for (let t = 0; t < H; t++) {
    // always draw the same 4 numbers per month (keeps paths aligned across branches)
    const uShock = rand ? rand() : 0.5
    const uBonus = rand ? rand() : 0
    const uSize = rand ? rand() : 0.5
    const zRet = rand ? normal(rand) : 0

    const moy = t % 12
    const st = plan.status[t]
    let inc = plan.income[t] * knobs.income
    if (knobs.incomeFrom && t >= knobs.incomeFrom.month) inc *= knobs.incomeFrom.scale
    let bonus = 0
    const b = params.bonus[st]
    if (b && moy === 11) {
      const size = rand ? fromQuantiles(b.size_quantiles, uSize) : mean(b.size_quantiles)
      bonus = rand ? (uBonus < b.probability ? size * inc : 0) : b.probability * size * inc
    }
    const base = plan.rent[t] * knobs.rent + (plan.otherMu[t] + muShift) * knobs.other
    const surprise = rand ? plan.otherSd[t] * fromQuantiles(params.shock_quantiles, uShock) : 0
    const spend = Math.max(0, base * (1 + params.season[st][moy]) + surprise)
    const oneOff = plan.oneOff[t] * (plan.oneOff[t] > 0 ? knobs.oneOff : 1)

    let loanIn = 0
    let pay = 0
    let interest = 0
    plan.loans.forEach((l, i) => {
      if (l.isNew && t === l.start) {
        debt[i] += l.principal
        loanIn += l.principal
      }
      if (t < l.start || debt[i] <= 0) return
      const it = (debt[i] * l.annualRate) / 12
      const p = Math.min(l.payment, debt[i] + it)
      debt[i] += it - p
      interest += it
      pay += p
    })

    const contrib = plan.contrib[t]
    const cashBefore = c
    c = c + inc + bonus + loanIn - spend - plan.extra[t] - oneOff - contrib - pay
    const vBefore = v
    const r = retM + (rand ? volM * zRet : 0)
    v = (v + contrib) * (1 + r)
    const shock = plan.shocks.find((s) => s.month === t)
    if (shock) v *= 1 - shock.drop
    const d = debt.reduce((a, x) => a + x, 0)
    cash[t] = c
    nw[t] = c + v - d
    liquid[t] = c + v
    ledger?.push({ t, cashBefore, cashAfter: c, inflow: inc + bonus + loanIn, outflow: spend + plan.extra[t] + oneOff + contrib + pay, contrib, interest, investGain: v - vBefore - contrib, debt: d, nw: nw[t], spend })
  }
  return { cash, nw, liquid }
}

export type LedgerRow = { t: number; cashBefore: number; cashAfter: number; inflow: number; outflow: number; contrib: number; interest: number; investGain: number; debt: number; nw: number; spend: number }

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length

export function simulate(plan: Plan, params: Params, profile: Profile, paths = 500, seed = params.seed, knobs: Knobs = NO_KNOBS): SimResult {
  const H = plan.months
  const rand = mulberry32(seed)
  const nwAll = Array.from({ length: H }, () => new Float64Array(paths))
  const cashAll = Array.from({ length: H }, () => new Float64Array(paths))
  const endNW = new Float64Array(paths)
  const endCash = new Float64Array(paths)
  const minCash = new Float64Array(paths)
  const firstNeg: number[] = []
  const goalMonths = profile.goals.map((g) => monthIndex(profile.as_of, g.date))
  const goalHits = goalMonths.map(() => 0)
  const goalLiquid = goalMonths.map(() => new Float64Array(paths))
  let neg = 0

  for (let p = 0; p < paths; p++) {
    const o = runPath(plan, params, rand, knobs)
    let mn = Infinity
    let fn = -1
    for (let t = 0; t < H; t++) {
      nwAll[t][p] = o.nw[t]
      cashAll[t][p] = o.cash[t]
      if (o.cash[t] < mn) mn = o.cash[t]
      if (fn < 0 && o.cash[t] < 0) fn = t
    }
    endNW[p] = o.nw[H - 1]
    endCash[p] = o.cash[H - 1]
    minCash[p] = mn
    if (fn >= 0) {
      neg++
      firstNeg.push(fn)
    }
    goalMonths.forEach((m, i) => {
      if (m >= 0 && m < H) {
        goalLiquid[i][p] = o.liquid[m]
        if (o.liquid[m] >= profile.goals[i].target) goalHits[i]++
      }
    })
  }
  const band = (a: Float64Array): Band => {
    const s = Float64Array.from(a).sort()
    return { p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9) }
  }
  firstNeg.sort((a, b) => a - b)
  const det = runPath(plan, params, null, knobs)
  return {
    nw: nwAll.map(band),
    cash: cashAll.map(band),
    endNW: band(endNW),
    endCash: band(endCash),
    minCash: band(minCash),
    probNegCash: neg / paths,
    // median over all paths, counting "never negative" as +infinity
    firstNegMonth: Math.floor(paths / 2) < neg ? firstNeg[Math.floor(paths / 2)] : null,
    goals: profile.goals.map((g, i) => {
      const m = goalMonths[i]
      const inside = m >= 0 && m < H
      return { name: g.name, target: g.target, date: g.date, month: m, prob: inside ? goalHits[i] / paths : null, medianLiquid: inside ? band(goalLiquid[i]).p50 : null }
    }),
    meanPath: { cash: Array.from(det.cash), nw: Array.from(det.nw) },
  }
}

// ---------------------------------------------------------------- accounting checks (run live in the UI)
export type Check = { name: string; ok: boolean; detail: string }

export function checks(plan: Plan, params: Params, profile: Profile): Check[] {
  const rows: LedgerRow[] = []
  const rand = mulberry32(params.seed)
  runPath(plan, params, rand, NO_KNOBS, rows)
  const out: Check[] = []

  let maxCashErr = 0
  for (const r of rows) maxCashErr = Math.max(maxCashErr, Math.abs(r.cashBefore + r.inflow - r.outflow - r.cashAfter))
  out.push({ name: 'Cash identity', ok: maxCashErr < 1e-6, detail: `opening + inflows − outflows = closing, every month (max error CHF ${maxCashErr.toExponential(1)})` })

  // net worth moves only by income - spending - costs - interest + investment gains (transfers & loan principal cancel)
  let maxNwErr = 0
  let prevNw = plan.startCash + plan.startInvest - plan.loans.filter((l) => !l.isNew).reduce((a, l) => a + l.principal, 0)
  for (const r of rows) {
    const loanIn = plan.loans.filter((l) => l.isNew && l.start === r.t).reduce((a, l) => a + l.principal, 0)
    const expected = prevNw + (r.inflow - loanIn) - r.spend - plan.extra[r.t] - plan.oneOff[r.t] - r.interest + r.investGain
    maxNwErr = Math.max(maxNwErr, Math.abs(expected - r.nw))
    prevNw = r.nw
  }
  out.push({ name: 'Net worth = assets − debts', ok: maxNwErr < 1e-6, detail: `moving cash into investments or repaying principal does not change net worth (max error CHF ${maxNwErr.toExponential(1)})` })

  const minDebt = Math.min(...rows.map((r) => r.debt))
  out.push({ name: 'Debt never negative', ok: minDebt >= -1e-9, detail: `lowest debt balance CHF ${Math.round(minDebt)}` })

  const a = simulate(plan, params, profile, 50)
  const b = simulate(plan, params, profile, 50)
  const same = a.nw.every((x, i) => x.p50 === b.nw[i].p50) && a.endNW.p10 === b.endNW.p10
  out.push({ name: 'Reproducible', ok: same, detail: `same seed (${params.seed}) → identical results` })

  const negMonths = rows.filter((r) => r.cashAfter < 0).length
  out.push({ name: 'Negative cash flagged', ok: true, detail: negMonths ? `${negMonths} month(s) below zero on the sample path → shown as "needs financing"` : 'no negative months on the sample path' })
  return out
}
