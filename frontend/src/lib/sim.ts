// Monte Carlo engine. Accounting is exact (formulas); randomness comes from the models estimated in R:
// monthly spending surprises, December bonus, uncertainty of the personal spending offset (R/eda.R),
// + the economy forecast if chosen (R/macro.R: inflation, unemployment) + investment noise if the user sets a volatility.
//
// Per month t, per path:
//   spending  = (rent + otherMu[t] + offset error + otherSd[t]·z) · cost multiplier,   z ~ N(0, 1)
//   bonus     = December only: Bernoulli(p[status]) · size[status] · income
//   cash[t+1] = cash[t] + income + bonus + loan_in - spending - extra - one_off - invest_transfer - loan_payment
//   invest[t+1] = (invest[t] + invest_transfer) * (1 + r_t) * (1 - shock)
//   debt[t+1] = debt[t] + interest - loan_payment      (never below 0)
//   home      = value of a bought home (bought with own money + a mortgage paid to the seller)
//   net_worth = cash + invest + home - debt
//   NPV_t     = startCash + Σ DF·(change of cash) + DF[t]·(net_worth − cash)   worth in today's money (valuation.ts; never feeds back)
// All branches use the SAME random numbers (common random numbers), so differences between
// branches come from the decision, not from luck.
import { invNorm, mulberry32, normal, pickUniform, quantile } from './rng'
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
  /** end net worth of every simulated future (same seed for every path -> futures can be compared one by one) */
  endNWPaths: Float64Array
  /** worth in today's money (NPV at plan.discountRate) for every horizon month, and at the end (rolling-horizon valuation) */
  npv: Band[]
  endNPV: Band
  endNPVPaths: Float64Array
  /** lowest cash of every simulated future (to test any liquidity floor, e.g. "never below 20k") */
  minCashPaths: Float64Array
  /** planned investing that could not happen because the money was not there: share of futures, typical amount */
  investCut: { share: number; p50: number }
  /** a few single futures (bumpy), drawn behind the smooth median line */
  samples: { nw: Float64Array; cash: Float64Array }[]
  /** home purchases: can the down payment actually be paid from cash in each future? */
  homeBuys: { month: number; down: number; cashBeforeP50: number; shortShare: number; label: string; kind: 'home' | 'asset'; price: number; loan: number }[]
}

export type PathOut = { cash: Float64Array; nw: Float64Array; liquid: Float64Array; invest: Float64Array; home: Float64Array; debt: Float64Array; investCut: number }

/** One path. deterministic=true -> expected values, no noise (used for drivers, break-even, checks). */
export function runPath(plan: Plan, params: Params, rand: (() => number) | null, knobs: Knobs = NO_KNOBS, ledger?: LedgerRow[]): PathOut {
  const H = plan.months
  const cash = new Float64Array(H)
  const nw = new Float64Array(H)
  const liquid = new Float64Array(H)
  const investA = new Float64Array(H)
  const homeA = new Float64Array(H)
  const debtA = new Float64Array(H)
  let c = plan.startCash
  let v = plan.startInvest
  const debt = plan.loans.map((l) => (l.isNew ? 0 : l.principal))
  const muShift = rand ? plan.muSe * normal(rand) : 0
  // effective monthly rate: 12 months compound to exactly the annual rate (UBS scenario-modelling §5: FV = PV(1+r)^n)
  const retM = Math.pow(1 + Math.max(-0.99, plan.invReturn + knobs.retShift), 1 / 12) - 1
  const volM = plan.invVol / Math.sqrt(12)
  let recUntil = -1 // random recession (economy) running until this month
  let cut = 0 // planned investing that could not happen (no money available)

  // economy forecast (one simulated future): yearly inflation pi (%) and log unemployment lu (log %), VAR(1) from R
  const M = plan.macro
  let pi = M ? M.model.start.inflation_pct : 0
  let lu = M ? Math.log(M.model.start.unemployment_pct) : 0
  let cm = 1 // cost multiplier: prices vs pay (pay follows last year's inflation)
  let lossChance = 0 // chance per month that an employee loses the job, this year
  let pU = 0 // expected-value mode: chance of being unemployed this month
  let lostAt = -1 // month the job was lost (-1 = not unemployed)
  let lostPay = 0 // pay when the job was lost (the benefit is a share of it)
  const yearFlows = (m: NonNullable<Plan['macro']>) => {
    // steady-state flows: job-finding f = 1/duration, job-loss s = f·u/(1−u), u = registered unemployment rate
    const u = Math.min(0.5, (Math.exp(lu) / 100) * m.model.labour.registered_share)
    lossChance = (m.findRate * u) / (1 - u)
  }
  if (M) yearFlows(M)

  for (let t = 0; t < H; t++) {
    // always draw the same 4 numbers per month (keeps paths aligned across branches)
    const uShock = rand ? rand() : 0.5
    const uBonus = rand ? rand() : 0
    const uSize = rand ? rand() : 0.5
    const zRet = rand ? normal(rand) : 0

    // economy luck: only drawn when the economy is uncertain, so today's-economy results stay identical
    let recStarts = false
    if (rand && plan.macroRisk > 0) {
      const uMacro = rand()
      if (t % 12 === 0 && t >= recUntil && uMacro < plan.macroRisk) {
        recUntil = t + 12
        recStarts = true
      }
    }
    const moy = t % 12
    const st = plan.status[t]
    let inc = plan.income[t] * knobs.income
    if (t < recUntil && (st === 'employed' || st === 'self_employed' || st === 'part_time')) inc *= 0.9
    if (knobs.incomeFrom && t >= knobs.incomeFrom.month) inc *= knobs.incomeFrom.scale

    // economy forecast: only drawn in that economy, so every other economy's results stay identical.
    // Always the same draws (2 normals per year, 2 uniforms per month), so paths stay aligned across branches.
    let jobless = 0 // 1 = unemployed this month (expected-value mode: the chance)
    if (M) {
      if (t % 12 === 0 && t > 0) {
        const e1 = rand ? invNorm(rand()) : 0
        const e2 = rand ? invNorm(rand()) : 0
        // x_y = c + A x_{y-1} + L e,  x = (inflation, log unemployment),  L L' = Sigma
        const { c, A, chol } = M.model
        const piNext = c[0] + A[0][0] * pi + A[0][1] * lu + chol[0][0] * e1
        const luNext = c[1] + A[1][0] * pi + A[1][1] * lu + chol[1][0] * e1 + chol[1][1] * e2
        cm *= (1 + piNext / 100) / (1 + pi / 100 + M.realWageGrowth)
        pi = piNext
        lu = luNext
        yearFlows(M)
      }
      const uLose = rand ? rand() : 0
      const uFind = rand ? rand() : 0
      if (!M.exposed[t]) {
        lostAt = -1
        pU = 0
      } else if (rand) {
        if (lostAt >= 0 && uFind < M.findRate) lostAt = -1
        else if (lostAt < 0 && uLose < lossChance) {
          lostAt = t
          lostPay = inc
        }
        jobless = lostAt >= 0 ? 1 : 0
      } else {
        pU = pU * (1 - M.findRate) + (1 - pU) * lossChance
        jobless = pU
      }
    }

    let bonus = 0
    const b = params.spending.bonus[st]
    if (b && moy === 11) {
      const size = rand ? pickUniform(b.size_quantiles, uSize) : mean(b.size_quantiles)
      bonus = (rand ? (uBonus < b.probability ? size * inc : 0) : b.probability * size * inc) * (1 - jobless)
    }
    if (M && jobless > 0) {
      // benefit: a share of the pay at job loss (capped) while it lasts, then the typical income of unemployed people.
      // Expected-value mode uses this month's pay and ignores the end of benefits (few stay unemployed that long).
      const since = rand ? lostAt : t
      const benefit = M.replacement[since] * Math.min(rand ? lostPay : inc, M.benefitCap)
      const incU = rand && t - lostAt >= M.maxBenefitMonths[lostAt] ? Math.min(benefit, M.afterIncome[t]) : benefit
      inc = (1 - jobless) * inc + jobless * incU
    }
    const mu = jobless ? (1 - jobless) * plan.otherMu[t] + jobless * plan.unempMu[t] : plan.otherMu[t]
    const sd = jobless === 1 ? plan.unempSd[t] : plan.otherSd[t]
    const surprise = rand ? sd * invNorm(uShock) : 0
    const spend = Math.max(0, (plan.rent[t] * knobs.rent + (mu + muShift) * knobs.other + surprise) * cm)
    const extra = plan.extra[t] * cm
    const oneOff = plan.oneOff[t] > 0 ? plan.oneOff[t] * knobs.oneOff * cm : plan.oneOff[t]

    let loanIn = 0
    let pay = 0
    let interest = 0
    plan.loans.forEach((l, i) => {
      if (l.isNew && t === l.start) {
        debt[i] += l.principal
        if (!l.toSeller) loanIn += l.principal // a mortgage goes straight to the seller, not into cash
      }
      if (t < l.start || debt[i] <= 0) return
      const it = (debt[i] * l.annualRate) / 12
      // amortizing mortgages: interest + a fixed slice of principal while the amortization runs
      const due = l.amort ? it + (t - l.start < l.amort.months ? l.amort.perMonth : 0) : l.payment
      const p = Math.min(due, debt[i] + it)
      debt[i] += it - p
      interest += it
      pay += p
    })

    // investments: last month's value grows first, then this month's money moves in (end of period, as in UBS's
    // annuity formula FV = PV(1+r)^n + A((1+r)^n-1)/r). A negative amount = selling: never more than what is held.
    const vBefore = v
    const r = retM + (rand ? volM * zRet : 0)
    v = v * (1 + r)
    const cashBefore = c
    const down = plan.homeDown[t] // own money put into a home (cash -> home, net worth unchanged)
    const available = c + inc + bonus + loanIn - spend - extra - oneOff - pay - down
    // UBS budget constraint (scenario-modelling §14): investment contributions only from money that is actually there.
    // Selling: never more than is held.
    const planned = plan.contrib[t]
    const contrib = planned < 0 ? Math.max(planned, -Math.max(0, v)) : Math.min(planned, Math.max(0, available))
    if (planned > 0 && contrib < planned - 1e-9) cut += planned - contrib
    v += contrib
    c = available - contrib
    const shock = plan.shocks.find((s) => s.month === t)
    if (shock) v *= 1 - shock.drop
    if (recStarts) v *= 0.8 // markets fall when a random recession starts
    const d = debt.reduce((a, x) => a + x, 0)
    cash[t] = c
    nw[t] = c + v + plan.homeValue[t] - d
    liquid[t] = c + v
    investA[t] = v
    homeA[t] = plan.homeValue[t]
    debtA[t] = d
    ledger?.push({ t, cashBefore, cashAfter: c, inflow: inc + bonus + loanIn, outflow: spend + extra + oneOff + contrib + pay + down, contrib, interest, investGain: v - vBefore - contrib, debt: d, nw: nw[t], spend, extra, oneOff, revalue: plan.revalue[t] })
  }
  return { cash, nw, liquid, invest: investA, home: homeA, debt: debtA, investCut: cut }
}

/** extra / oneOff = what was actually paid that month (after the economy's cost multiplier and knobs) */
export type LedgerRow = { t: number; cashBefore: number; cashAfter: number; inflow: number; outflow: number; contrib: number; interest: number; investGain: number; debt: number; nw: number; spend: number; extra: number; oneOff: number; revalue: number }

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length

export function simulate(plan: Plan, params: Params, profile: Profile, paths = 500, seed = params.seed, knobs: Knobs = NO_KNOBS): SimResult {
  const H = plan.months
  const rand = mulberry32(seed)
  const nwAll = Array.from({ length: H }, () => new Float64Array(paths))
  const samples: SimResult['samples'] = []
  const cashAll = Array.from({ length: H }, () => new Float64Array(paths))
  const npvAll = Array.from({ length: H }, () => new Float64Array(paths))
  const df = plan.df
  const endNW = new Float64Array(paths)
  const endCash = new Float64Array(paths)
  const minCash = new Float64Array(paths)
  const firstNeg: number[] = []
  const goalMonths = profile.goals.map((g) => monthIndex(profile.as_of, g.date))
  const goalHits = goalMonths.map(() => 0)
  const goalLiquid = goalMonths.map(() => new Float64Array(paths))
  let neg = 0
  let cutN = 0
  const cutAmt = new Float64Array(paths)

  for (let p = 0; p < paths; p++) {
    const o = runPath(plan, params, rand, knobs)
    if (p < 6) samples.push({ nw: o.nw, cash: o.cash })
    let mn = Infinity
    let fn = -1
    let disc = 0 // Σ DF·(change of cash): see valuation.ts
    let prev = plan.startCash
    for (let t = 0; t < H; t++) {
      nwAll[t][p] = o.nw[t]
      cashAll[t][p] = o.cash[t]
      disc += df[t] * (o.cash[t] - prev)
      prev = o.cash[t]
      npvAll[t][p] = plan.startCash + disc + df[t] * (o.nw[t] - o.cash[t])
      if (o.cash[t] < mn) mn = o.cash[t]
      if (fn < 0 && o.cash[t] < 0) fn = t
    }
    if (o.investCut > 0) cutN++
    cutAmt[p] = o.investCut
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
  // a down payment must come from money you HAVE (banks require own funds): check cash just before the purchase
  const homeBuys: SimResult['homeBuys'] = []
  plan.purchases.forEach((pu) => {
    const m = pu.month
    const down = pu.down
    if (down <= 0) return
    let short = 0
    const before = new Float64Array(paths)
    for (let p = 0; p < paths; p++) {
      before[p] = m === 0 ? plan.startCash : cashAll[m - 1][p]
      if (before[p] < down) short++
    }
    homeBuys.push({ month: m, down, cashBeforeP50: quantile(before.sort(), 0.5), shortShare: short / paths, label: pu.label, kind: pu.kind, price: pu.price, loan: pu.loan })
  })
  const det = runPath(plan, params, null, knobs)
  return {
    nw: nwAll.map(band),
    cash: cashAll.map(band),
    endNW: band(endNW),
    npv: npvAll.map(band),
    endNPV: band(npvAll[H - 1]),
    endNPVPaths: npvAll[H - 1],
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
    endNWPaths: endNW,
    minCashPaths: minCash,
    investCut: { share: cutN / paths, p50: band(cutAmt).p50 },
    samples,
    homeBuys,
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
  let prevNw = plan.startCash + plan.startInvest + plan.startHome - plan.loans.filter((l) => !l.isNew).reduce((a, l) => a + l.principal, 0)
  for (const r of rows) {
    const loanIn = plan.loans.filter((l) => l.isNew && !l.toSeller && l.start === r.t).reduce((a, l) => a + l.principal, 0)
    const expected = prevNw + (r.inflow - loanIn) - r.spend - r.extra - r.oneOff - r.interest + r.investGain + r.revalue
    maxNwErr = Math.max(maxNwErr, Math.abs(expected - r.nw))
    prevNw = r.nw
  }
  out.push({ name: 'Net worth = assets − debts', ok: maxNwErr < 1e-6, detail: `buying something or moving cash into investments only moves money between pockets; only income, spending, interest and value changes move net worth (max error CHF ${maxNwErr.toExponential(1)})` })

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
