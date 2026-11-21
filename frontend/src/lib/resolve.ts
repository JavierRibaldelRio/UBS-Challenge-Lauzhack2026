// Turns "profile + list of events" into a month-by-month PLAN.
// Every number used gets an Assumption record saying where it came from:
//   data       = read from the challenge CSVs (or a median of them)
//   learned    = fitted by ml/train.py from the 24-month ledger
//   you        = typed by the user (or stated in the chat)
//   assumption = not in the data, a labelled default (editable)
//   missing    = nobody knows; default is "no change" and the UI asks you to set it
import { BASE_MACRO, type Macro } from './macro'
import type { Assumption, Household, Params, Profile, Regression, ScenarioSpec, Source, Status, TwinEvent } from './types'

export type Plan = {
  months: number
  income: Float64Array
  rent: Float64Array
  otherMu: Float64Array // expected non-rent spending
  otherSd: Float64Array // month-to-month spending std-dev
  extra: Float64Array // recurring extra costs
  oneOff: Float64Array // single costs (>0) / money in (<0), incl. tuition
  contrib: Float64Array // cash -> investments transfers
  homeDown: Float64Array // own money paid into a home (down payment)
  homeValue: Float64Array // value of an owned home (counted in net worth, not in cash)
  macroRisk: number // yearly chance of a random recession (economy), drawn per simulated future
  status: Status[]
  household: Household[]
  city: string[]
  shocks: { month: number; drop: number }[]
  loans: { start: number; principal: number; annualRate: number; payment: number; isNew: boolean; toSeller?: boolean }[]
  startCash: number
  startInvest: number
  muSe: number // standard error of the personal spending level (parameter uncertainty)
  invReturn: number // expected real annual return
  invVol: number // annual volatility
  /** month from which the decision changes income (used for break-even) */
  changeMonth: number | null
  assumptions: Assumption[]
  warnings: string[]
}

export type Overrides = Record<string, number>

export const BAND = (age: number) => `${Math.floor(age / 5) * 5}-${Math.floor(age / 5) * 5 + 4}`

export function regPredict(reg: Regression, x: { income: number; rent: number; age: number; household: string; status: string }) {
  let y = 0
  reg.features.forEach((f, i) => {
    let v = 0
    if (f === 'intercept') v = 1
    else if (f === 'income') v = x.income
    else if (f === 'sqrt_income') v = Math.sqrt(Math.max(0, x.income))
    else if (f === 'rent') v = x.rent
    else if (f === 'age') v = x.age
    else if (f.startsWith('household=')) v = x.household === f.slice(10) ? 1 : 0
    else if (f.startsWith('status=')) v = x.status === f.slice(7) ? 1 : 0
    y += reg.coefficients[i] * v
  })
  return y
}

export function incomeAnchor(params: Params, status: Status, age: number) {
  const s = params.anchors.income_by_status[status]
  const b = s.by_age_band[BAND(Math.floor(age))]
  const m = b ?? s.all
  const range = m.p10 != null && m.p90 != null ? { lo: m.p10, hi: m.p90, good: 'higher' as const } : undefined
  if (b) return { value: b.median, range, note: `median of ${b.n} ${status} profiles aged ${BAND(Math.floor(age))} (synthetic-profiles.csv)` }
  return { value: s.all.median, range, note: `median of all ${s.all.n} ${status} profiles (synthetic-profiles.csv)` }
}

export function rentAnchor(params: Params, city: string, household: Household) {
  const c = params.anchors.rent_by_city[city]
  if (!c) return null
  const h = c.by_household[household]
  const m = h ?? c.all
  const range = m.p10 != null && m.p90 != null ? { lo: m.p10, hi: m.p90, good: 'lower' as const } : undefined
  if (h) return { value: h.median, range, note: `median rent of ${h.n} ${household} households in ${city} (synthetic-profiles.csv)` }
  return { value: c.all.median, range, note: `median rent of ${c.all.n} households in ${city} (synthetic-profiles.csv)` }
}

export const cities = (params: Params) => Object.keys(params.anchors.rent_by_city).sort()

export function medianLoanRate(profiles: Profile[]) {
  const r = profiles.flatMap((p) => p.loans.map((l) => l.annual_rate)).sort((a, b) => a - b)
  return r.length ? r[Math.floor(r.length / 2)] : 0.05
}

export function resolve(
  profile: Profile,
  params: Params,
  spec: ScenarioSpec,
  overrides: Overrides,
  horizonMonths: number,
  loanRateMedian: number,
  macro: Macro = BASE_MACRO, // the economy (shared by all paths); everything else here is the person's own (idiosyncratic)
): Plan {
  const shift = macro.rate_shift_pct / 100 // macro: added to default / existing loan and mortgage rates
  const H = horizonMonths
  const assumptions: Assumption[] = []
  const warnings: string[] = []
  let curMonth = 0 // month the current event starts (stored on its assumptions)
  const A = (key: string, label: string, value: number, unit: string, source: Source, note: string, range?: Assumption['range']) => {
    const o = overrides[key]
    const v = o ?? value
    assumptions.push({ key, label, value: v, unit, source: o != null ? 'you' : source, note, ...(o == null && source === 'data' && range ? { range } : {}), ...(key.startsWith('g.') ? {} : { month: curMonth }) })
    return v
  }
  const fill = <T>(v: T) => Array.from({ length: H }, () => v)

  const income = new Float64Array(H).fill(profile.income)
  const rent = new Float64Array(H).fill(profile.rent)
  const status: Status[] = fill(profile.status)
  const household: Household[] = fill(profile.household)
  const city: string[] = fill(profile.city)
  const extra = new Float64Array(H)
  const oneOff = new Float64Array(H)
  const contrib = new Float64Array(H)
  const homeDown = new Float64Array(H)
  const homeValue = new Float64Array(H)
  const shocks: Plan['shocks'] = []
  const loans: Plan['loans'] = []
  let changeMonth: number | null = null
  const ageAt = (t: number) => profile.age + t / 12
  const clampM = (m: number | null | undefined) => Math.max(0, Math.min(H - 1, Math.round(m ?? 0)))
  const endOf = (s: number, d: number | null) => (d == null ? H : Math.max(s + 1, Math.min(H, s + Math.round(d))))

  // ---- global, profile-level numbers
  const startCash = A('g.cash', 'Starting cash', profile.cash, 'CHF', 'data', `opening_cash_chf, ${profile.as_of} (synthetic-profiles.csv)`)
  const startInvest = A('g.invest', 'Starting investments', profile.investments, 'CHF', 'data', 'investment_portfolio (synthetic-assets.csv)')
  const otherBase = A('g.other', 'Usual spending, excl. rent', profile.calib.other_mu, 'CHF/mo', 'learned', `average of your ${profile.calib.months} ledger months, seasonality and bonus removed`)
  const sdBase = A('g.sd', 'Spending ups & downs (1 std-dev)', profile.calib.other_sd, 'CHF/mo', 'learned', `std-dev of your ${profile.calib.months} ledger months`)
  const invReturn = A('m.ret', 'Economy: investment return (real, per year)', macro.market_return_pct, '%', macro.market_return_pct ? 'macro' : 'assumption', macro.market_return_pct ? `set by the economy “${macro.name}”` : 'Not in the data (assets are a single snapshot). 0% = no growth. Choose an economy or edit.') / 100
  const invVol = A('m.vol', 'Economy: market ups & downs (per year)', macro.market_vol_pct, '%', macro.market_vol_pct ? 'macro' : 'assumption', macro.market_vol_pct ? `set by the economy “${macro.name}”` : 'Not in the data. 0% = no market noise.') / 100
  profile.loans.forEach((l, i) => {
    const rateNow = l.annual_rate + shift
    const interest = (l.principal * rateNow) / 12
    const pay = A(`g.loan${i}`, `Loan ${i + 1} monthly payment`, Math.round(interest), 'CHF/mo', 'assumption', `Data has principal ${Math.round(l.principal)} at ${(l.annual_rate * 100).toFixed(2)}%${shift ? ` (+${macro.rate_shift_pct} points: economy)` : ''} but payment 0 / not amortized. Default: interest only.`)
    loans.push({ start: 0, principal: l.principal, annualRate: rateNow, payment: pay, isNew: false })
  })

  // ---- events, in time order
  const events = [...spec.events].map((e, i) => ({ e, i })).sort((a, b) => (a.e.start_month ?? 0) - (b.e.start_month ?? 0))
  for (const { e, i } of events) {
    curMonth = clampM(e.start_month)
    applyEvent(e, `e${i}`, clampM(e.start_month))
  }

  function applyEvent(e: TwinEvent, k: string, s: number) {
    const tag: Source = e._source ? 'assumption' : 'you'
    const tagNote = e._source ?? 'from your request'
    switch (e.type) {
      case 'start_job': {
        const anc = incomeAnchor(params, 'employed', ageAt(s))
        const inc = A(`${k}.income`, `${e.label}: net salary`, e.monthly_net_income_chf ?? anc.value, 'CHF/mo', e.monthly_net_income_chf != null ? tag : 'data', e.monthly_net_income_chf != null ? tagNote : anc.note, anc.range)
        for (let t = s; t < H; t++) {
          status[t] = 'employed'
          income[t] = inc
        }
        changeMonth ??= s
        break
      }
      case 'study': {
        const sa = profile.study_assumption
        const durDefault = (sa?.study_duration_years ?? params.anchors.study.duration_years_median) * 12
        const tuiDefault = sa?.annual_tuition_chf ?? params.anchors.study.annual_tuition_chf_median
        const studyNote = sa ? `this profile's row in scenario-assumptions.csv (S001)` : `median of scenario-assumptions.csv (S001)`
        const dur = A(`${k}.dur`, `${e.label}: duration`, e.duration_months ?? durDefault, 'months', e.duration_months != null ? tag : 'data', e.duration_months != null ? tagNote : studyNote)
        const tuition = A(`${k}.tuition`, `${e.label}: tuition per year`, e.annual_tuition_chf ?? tuiDefault, 'CHF/yr', e.annual_tuition_chf != null ? tag : 'data', e.annual_tuition_chf != null ? tagNote : `${studyNote}; paid per semester`)
        const studInc = profile.status === 'student' ? { value: profile.income, note: 'your current student income (synthetic-profiles.csv)' } : incomeAnchor(params, 'student', ageAt(s))
        const incDuring = A(`${k}.incDuring`, `${e.label}: income while studying`, e.monthly_net_income_chf ?? studInc.value, 'CHF/mo', e.monthly_net_income_chf != null ? tag : 'data', e.monthly_net_income_chf != null ? tagNote : studInc.note)
        const end = Math.min(H, s + Math.round(dur))
        for (let t = s; t < end; t++) {
          status[t] = 'student'
          income[t] = incDuring
        }
        for (let t = s; t < end; t += 6) oneOff[t] += tuition / 2
        if (end < H) {
          curMonth = end // the salary after studying (and its unknown premium) only matters from here
          const anc = incomeAnchor(params, 'employed', ageAt(end))
          const after = A(`${k}.after`, `${e.label}: salary after (no premium)`, anc.value, 'CHF/mo', 'data', anc.note, anc.range)
          const premium = A(`${k}.premium`, `${e.label}: salary premium from degree`, e.income_change_pct ?? 0, '%', e.income_change_pct != null ? tag : 'missing', e.income_change_pct != null ? tagNote : 'The data has no education field, so the degree premium is unknown. 0% = same pay. See the break-even line.')
          for (let t = end; t < H; t++) {
            status[t] = 'employed'
            income[t] = after * (1 + premium / 100)
          }
          changeMonth ??= end
        }
        break
      }
      case 'relocate': {
        const target = (e.city ?? '').trim()
        const known = params.anchors.rent_by_city[target] ? target : null
        const label = known ?? (target || 'abroad')
        const where = known ? `in ${known}` : /^abroad$/i.test(label) ? 'abroad' : `in ${label.replace(/^abroad:\s*/i, '')}`
        const ra = known ? rentAnchor(params, known, household[s]) : null
        const rentV = A(`${k}.rent`, `${e.label}: rent ${where}`, e.monthly_amount_chf ?? ra?.value ?? rent[s], 'CHF/mo', e.monthly_amount_chf != null ? tag : ra ? 'data' : 'missing', e.monthly_amount_chf != null ? tagNote : ra ? ra.note : `No data for ${label}. Default keeps your current rent - please set it.`, ra?.range)
        const incV = A(`${k}.income`, `${e.label}: net income ${where}`, e.monthly_net_income_chf ?? income[s], 'CHF/mo', e.monthly_net_income_chf != null ? tag : known ? 'data' : 'missing', e.monthly_net_income_chf != null ? tagNote : known ? 'income kept: the synthetic data shows no reliable city effect on income' : `No data for ${label}. Default keeps your current income - please set it.`)
        const move = A(`${k}.move`, `${e.label}: moving cost`, e.amount_chf ?? 0, 'CHF', e.amount_chf != null ? tag : 'missing', e.amount_chf != null ? tagNote : 'Moving costs are not in the data. 0 by default.')
        // income only changes if someone actually set it (else later phases, e.g. post-study salary, are kept)
        const setIncome = e.monthly_net_income_chf != null || overrides[`${k}.income`] != null
        for (let t = s; t < H; t++) {
          city[t] = label
          rent[t] = rentV
          if (setIncome) {
            income[t] = incV
            if (status[t] === 'student' || status[t] === 'unemployed') status[t] = 'employed' // earning abroad = working
          }
        }
        oneOff[s] += move
        if (e.monthly_net_income_chf != null || !known) changeMonth ??= s
        break
      }
      case 'income_change': {
        const end = endOf(s, e.duration_months)
        const base = income[s]
        const byPct = e.monthly_net_income_chf == null
        const pctV = byPct ? A(`${k}.pct`, `${e.label}: income change`, e.income_change_pct ?? 0, '%', e.income_change_pct != null ? tag : 'missing', e.income_change_pct != null ? tagNote : 'Size of the change not given.') : 0
        const newInc = byPct ? base * (1 + pctV / 100) : A(`${k}.income`, `${e.label}: new income`, e.monthly_net_income_chf!, 'CHF/mo', tag, tagNote)
        for (let t = s; t < end; t++) {
          income[t] = byPct ? income[t] * (1 + pctV / 100) : newInc
          if (income[t] <= 0) status[t] = 'unemployed'
        }
        changeMonth ??= s
        break
      }
      case 'household_change': {
        const h = e.household_type ?? 'family'
        for (let t = s; t < H; t++) household[t] = h
        const ra = rentAnchor(params, city[s], h)
        const rentV = A(`${k}.rent`, `${e.label}: rent as ${h}`, e.monthly_amount_chf ?? ra?.value ?? rent[s], 'CHF/mo', e.monthly_amount_chf != null ? tag : ra ? 'data' : 'missing', e.monthly_amount_chf != null ? tagNote : ra?.note ?? 'no rent data for this city', ra?.range)
        for (let t = s; t < H; t++) rent[t] = rentV
        break
      }
      case 'recurring_expense': {
        const end = endOf(s, e.duration_months)
        const amt = A(`${k}.amt`, `${e.label}: monthly cost`, e.monthly_amount_chf ?? 0, 'CHF/mo', e.monthly_amount_chf != null ? tag : 'missing', e.monthly_amount_chf != null ? tagNote : 'Amount not given.')
        for (let t = s; t < end; t++) extra[t] += amt
        break
      }
      case 'one_off': {
        const amt = A(`${k}.amt`, `${e.label}: amount (+cost / -money in)`, e.amount_chf ?? 0, 'CHF', e.amount_chf != null ? tag : 'missing', e.amount_chf != null ? tagNote : 'Amount not given.')
        oneOff[s] += amt
        break
      }
      case 'invest': {
        const end = endOf(s, e.duration_months)
        if (e.monthly_amount_chf != null || e.amount_chf == null) {
          const m = A(`${k}.monthly`, `${e.label}: invested per month`, e.monthly_amount_chf ?? 0, 'CHF/mo', e.monthly_amount_chf != null ? tag : 'missing', e.monthly_amount_chf != null ? tagNote : 'Amount not given.')
          for (let t = s; t < end; t++) contrib[t] += m
        }
        if (e.amount_chf != null) contrib[s] += A(`${k}.lump`, `${e.label}: lump sum invested`, e.amount_chf, 'CHF', tag, tagNote)
        break
      }
      case 'market_shock': {
        const d = A(`${k}.drop`, `${e.label}: investment drop`, e.drop_pct ?? 30, '%', e.drop_pct != null ? tag : 'assumption', e.drop_pct != null ? tagNote : 'Illustrative size, not from data.')
        shocks.push({ month: s, drop: d / 100 })
        if (startInvest <= 0 && !spec.events.some((x) => x.type === 'invest')) warnings.push('A market shock only affects investments, and this profile has none.')
        break
      }
      case 'buy_home': {
        const price = A(`${k}.price`, `${e.label}: price`, e.amount_chf ?? 0, 'CHF', e.amount_chf != null ? tag : 'missing', e.amount_chf != null ? tagNote : 'House prices are not in the data. Please set the price.')
        if (price <= 0) {
          warnings.push('Buying a home has no effect until you set a price.')
          break
        }
        const downPct = A(`${k}.down`, `${e.label}: own money (down payment)`, e.down_payment_pct ?? 20, '%', e.down_payment_pct != null ? tag : 'assumption', e.down_payment_pct != null ? tagNote : 'Swiss lenders usually ask for at least 20% own money.')
        const rate = A(`${k}.rate`, `${e.label}: mortgage interest`, e.annual_rate_pct ?? 2 + macro.rate_shift_pct, '%/yr', e.annual_rate_pct != null ? tag : 'assumption', e.annual_rate_pct != null ? tagNote : `Mortgage rates are not in the data. Illustrative 2%${shift ? ` + ${macro.rate_shift_pct} points (economy)` : ''}.`) / 100
        const upkeep = A(`${k}.upkeep`, `${e.label}: upkeep per year`, 1, '% of price', 'assumption', 'Rule of thumb for maintenance. Not in the data.')
        const mortgage = price * (1 - downPct / 100)
        homeDown[s] += price - mortgage
        for (let t = s; t < H; t++) {
          homeValue[t] += price // real value kept constant (no price growth assumed)
          rent[t] = 0 // owners stop paying rent
          extra[t] += (price * upkeep) / 100 / 12
        }
        // interest-only mortgage (common in Switzerland); principal stays as debt
        loans.push({ start: s, principal: mortgage, annualRate: rate, payment: (mortgage * rate) / 12, isNew: true, toSeller: true })
        assumptions.push({ key: `${k}.info`, label: `${e.label}: mortgage`, value: Math.round(mortgage), unit: 'CHF', source: 'assumption', note: 'price − own money; interest only, rent stops, home value kept constant in 2025 francs' })
        break
      }
      case 'take_loan': {
        const principal = A(`${k}.principal`, `${e.label}: amount borrowed`, e.amount_chf ?? 0, 'CHF', e.amount_chf != null ? tag : 'missing', e.amount_chf != null ? tagNote : 'Amount not given.')
        const rate = A(`${k}.rate`, `${e.label}: interest rate`, e.annual_rate_pct ?? (loanRateMedian + shift) * 100, '%/yr', e.annual_rate_pct != null ? tag : 'data', e.annual_rate_pct != null ? tagNote : `median rate of the 283 loans in synthetic-liabilities.csv${shift ? ` + ${macro.rate_shift_pct} points (economy)` : ''}`) / 100
        const term = A(`${k}.term`, `${e.label}: repayment period`, e.duration_months ?? 60, 'months', e.duration_months != null ? tag : 'assumption', e.duration_months != null ? tagNote : 'Not in data; 5 years assumed.')
        const r = rate / 12
        const pay = r === 0 ? principal / term : (principal * r) / (1 - Math.pow(1 + r, -term))
        loans.push({ start: s, principal, annualRate: rate, payment: pay, isNew: true })
        break
      }
    }
  }

  // ---- learned spending response to a changed situation (regression delta, personal offset kept)
  const regO = params.regressions.other_spending
  const regV = params.regressions.spending_volatility
  const x0 = { income: profile.income, rent: profile.rent, age: profile.age, household: profile.household, status: profile.status }
  const f0 = regPredict(regO, x0)
  const v0 = Math.max(50, regPredict(regV, x0))
  const otherMu = new Float64Array(H)
  const otherSd = new Float64Array(H)
  for (let t = 0; t < H; t++) {
    const x = { income: income[t], rent: rent[t], age: ageAt(t), household: household[t], status: status[t] }
    otherMu[t] = Math.max(0, otherBase + regPredict(regO, x) - f0)
    otherSd[t] = sdBase * Math.min(4, Math.max(0.25, Math.max(50, regPredict(regV, x)) / v0))
  }
  const dEnd = otherMu[H - 1] - otherBase
  if (spec.events.length && Math.abs(dEnd) >= 1) {
    assumptions.push({ key: 'learned.delta', label: 'Spending response to the new situation', value: Math.round(dEnd), unit: 'CHF/mo', source: 'learned', note: `regression on 1,200 profiles (CV R² ${regO.selected_cv_r2.toFixed(2)}): how non-rent spending differs with income, status, household, age` })
  }

  // ---- the ECONOMY (macroeconomic, shared by every path). The person's own variables above are idiosyncratic.
  const macroNote = `economy “${macro.name}”${macro.catalog ? ` (UBS scenario ${macro.catalog})` : ''}: illustrative, not in the data`
  const gap = (macro.inflation_pct - macro.wage_growth_pct) / 100
  if (gap) {
    // in constant francs: prices outrunning pay = everyday costs grow by the gap each year
    for (let t = 0; t < H; t++) {
      const f = Math.pow(1 + gap, t / 12)
      rent[t] *= f
      otherMu[t] *= f
      otherSd[t] *= f
      extra[t] *= f
      if (oneOff[t] > 0) oneOff[t] *= f // costs like tuition rise too (UBS FAQ: never inflate some expenses but not others)
    }
    assumptions.push({ key: 'm.gap', label: 'Economy: prices rise faster than pay', value: Math.round(gap * 1000) / 10, unit: '%/yr', source: 'macro', note: `prices ${macro.inflation_pct}%/yr, pay ${macro.wage_growth_pct}%/yr · ${macroNote}` })
  }
  if (shift) assumptions.push({ key: 'm.rate', label: 'Economy: interest rates', value: macro.rate_shift_pct, unit: 'points', source: 'macro', note: `added to existing loans and default loan / mortgage rates (rates you set yourself stay) · ${macroNote}` })
  if (macro.recession) {
    const r = macro.recession
    const working = (st: Status) => st === 'employed' || st === 'self_employed' || st === 'part_time'
    for (let t = r.start_month; t < Math.min(H, r.start_month + r.months); t++) if (working(status[t])) income[t] *= 1 - r.income_drop_pct / 100
    assumptions.push({ key: 'm.rec', label: `Economy: recession at ${Math.floor(ageAt(r.start_month))} (${r.months} months)`, value: -r.income_drop_pct, unit: '% pay', source: 'macro', note: `pay of working people falls for the recession · ${macroNote}`, month: r.start_month })
  }
  if (macro.crash) {
    shocks.push({ month: Math.min(H - 1, macro.crash.month), drop: macro.crash.drop_pct / 100 })
    assumptions.push({ key: 'm.crash', label: `Economy: markets fall at ${Math.floor(ageAt(macro.crash.month))}`, value: -macro.crash.drop_pct, unit: '%', source: 'macro', note: `investments only · ${macroNote}`, month: macro.crash.month })
  }
  if (macro.housing_drop && macro.housing_drop.month < H) {
    const m0 = macro.housing_drop.month
    const loss = homeValue[m0] * (macro.housing_drop.drop_pct / 100) // homes owned at that moment lose value; you still owe the mortgage
    if (loss > 0) for (let t = m0; t < H; t++) homeValue[t] -= loss
    assumptions.push({ key: 'm.house', label: `Economy: home values fall at ${Math.floor(ageAt(m0))}`, value: -macro.housing_drop.drop_pct, unit: '%', source: 'macro', note: `${loss > 0 ? 'hits net worth, not cash' : 'no home owned at that time on this path'} · ${macroNote}`, month: m0 })
  }
  if (macro.recession_risk_per_year_pct) assumptions.push({ key: 'm.risk', label: 'Economy: chance of a recession each year', value: macro.recession_risk_per_year_pct, unit: '%', source: 'macro', note: `in each simulated future a recession can start (pay −10% for 12 months, markets −20%), the same for every path · ${macroNote}` })

  return {
    macroRisk: macro.recession_risk_per_year_pct / 100,
    months: H, income, rent, otherMu, otherSd, extra, oneOff, contrib, homeDown, homeValue, status, household, city, shocks, loans,
    startCash, startInvest, muSe: sdBase / Math.sqrt(Math.max(1, profile.calib.months)), invReturn, invVol, changeMonth, assumptions, warnings,
  }
}

// ---------------------------------------------------------------- presets (no LLM needed)
const ev = (p: Partial<TwinEvent> & Pick<TwinEvent, 'type' | 'label'>): TwinEvent => ({
  start_month: 0, duration_months: null, monthly_net_income_chf: null, income_change_pct: null, monthly_amount_chf: null,
  amount_chf: null, annual_tuition_chf: null, city: null, household_type: null, annual_rate_pct: null, drop_pct: null, down_payment_pct: null, ...p,
})

export type Preset = { id: string; label: string; desc: string; spec: ScenarioSpec }

export function presets(profile: Profile, params: Params): Preset[] {
  const out: Omit<Preset, 'desc'>[] = []
  const working = profile.status === 'employed' || profile.status === 'self_employed'
  const late = profile.status === 'retired' || profile.age >= 60
  if (!working && !late) out.push({ id: 'work', label: 'Start working', spec: { name: 'Start working', catalog_id: 'S001', events: [ev({ type: 'start_job', label: 'Start working' })] } })
  if (profile.age < 40) out.push({ id: 'master', label: "Master's degree", spec: { name: "Master's degree", catalog_id: 'S001', events: [ev({ type: 'study', label: "Master's" })] } })
  const dest = profile.city === 'Zurich' ? 'Geneva' : 'Zurich'
  if (params.anchors.rent_by_city[dest]) out.push({ id: 'move', label: `Move to ${dest}`, spec: { name: `Move to ${dest}`, catalog_id: null, events: [ev({ type: 'relocate', label: `Move to ${dest}`, city: dest, start_month: 12 }), ...(!working && !late ? [ev({ type: 'start_job', label: 'Job', start_month: 12 })] : [])] } })
  if (!late) out.push({
    id: 'abroad', label: 'Move abroad', spec: {
      name: 'Move abroad', catalog_id: null,
      events: [ev({ type: 'relocate', label: 'Move abroad', city: 'abroad', monthly_net_income_chf: 3700, amount_chf: 6500, _source: 'UBS starter-kit illustrative value (scenario_config.json)' })],
    },
  })
  if (profile.income > 0 && profile.status !== 'retired') out.push({ id: 'jobloss', label: 'Lose income 6 months', spec: { name: 'Income gap 6 months', catalog_id: null, events: [ev({ type: 'income_change', label: 'Income gap', start_month: 12, duration_months: 6, income_change_pct: -100, _source: 'preset: 6 months without income' })] } })
  out.push({ id: 'invest', label: 'Invest CHF 500/mo', spec: { name: 'Invest 500/mo', catalog_id: null, events: [ev({ type: 'invest', label: 'Invest', monthly_amount_chf: 500, _source: 'preset amount' })] } })
  if (profile.investments > 0) out.push({ id: 'crash', label: 'Market crash −30%', spec: { name: 'Market crash', catalog_id: null, events: [ev({ type: 'market_shock', label: 'Crash', start_month: 24, drop_pct: 30, _source: 'illustrative stress test' })] } })
  const studyYears = profile.study_assumption?.study_duration_years ?? params.anchors.study.duration_years_median
  const desc: Record<string, string> = {
    work: 'Start a full-time job now. Salary = median salary of employed people of the same age in the data.',
    master: `Study for ${studyYears} years (tuition from the data), keep the current student income, then start a job at the median salary. The extra salary a degree brings is unknown, so it starts at 0%.`,
    move: `In 12 months, move to ${dest}: rent becomes the median rent there (data)${profile.status !== 'employed' ? ', and start a job' : ''}.`,
    abroad: 'Move abroad now: income CHF 3,700 a month and a CHF 6,500 moving cost (numbers from the UBS starter kit). Rent abroad is unknown, so it stays the same.',
    jobloss: 'No income for 6 months, starting in 12 months. Everything else stays the same.',
    invest: 'Move CHF 500 a month from cash into investments. Growth is 0% unless you change it.',
    crash: 'Investments lose 30% of their value in 24 months (a stress test).',
  }
  return out.map((p) => ({ ...p, desc: desc[p.id] ?? p.spec.name }))
}

/** One short line describing what a path does, e.g. "study 24 months from 20, then a job · buy a home at 28". */
export function describeSpec(spec: ScenarioSpec, age0: number): string {
  if (!spec.events.length) return 'today’s numbers, nothing changes'
  const at = (m: number | null) => (m ? `at ${Math.floor(age0 + m / 12)}` : 'now')
  const k = (n: number) => (Math.abs(n) >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`)
  const until = (e: TwinEvent) => (e.duration_months ? ` (until ${Math.floor(age0 + ((e.start_month ?? 0) + e.duration_months) / 12)})` : '')
  const one = (e: TwinEvent) => {
    const d = e.duration_months
    switch (e.type) {
      case 'start_job': return `job ${at(e.start_month)}${e.monthly_net_income_chf ? ` (${k(e.monthly_net_income_chf)}/mo)` : ''}`
      case 'study': return `study ${d ? `${d} months` : ''} ${at(e.start_month)}, then a job`.replace('  ', ' ')
      case 'relocate': return `${!e.city || /^abroad$/i.test(e.city.trim()) ? 'move abroad' : `move to ${e.city.replace(/^abroad:\s*/i, '')}`} ${at(e.start_month)}`
      case 'income_change': return e.income_change_pct === -100 ? `no income ${d ? `for ${d} months ` : ''}${at(e.start_month)}` : e.monthly_net_income_chf != null ? `income ${k(e.monthly_net_income_chf)}/mo ${at(e.start_month)}${until(e)}` : `income ${e.income_change_pct != null ? `${e.income_change_pct > 0 ? '+' : ''}${e.income_change_pct}%` : 'changes'} ${at(e.start_month)}${until(e)}`
      case 'household_change': return `${e.household_type === 'family' ? 'a child' : e.household_type === 'couple' ? 'move in together' : (e.household_type ?? 'new household').replace('_', ' ')} ${at(e.start_month)}`
      case 'recurring_expense': return `${e.label.toLowerCase().replace(/\s*\d[\d'’,.]*\s*k?\s*(chf)?\s*(a|per|\/)\s*mo(nth)?/i, '')}${e.monthly_amount_chf ? ` ${k(e.monthly_amount_chf)}/mo` : ''} ${at(e.start_month)}${until(e)}`
      case 'one_off': return `${e.amount_chf != null && e.amount_chf < 0 ? 'receive' : 'pay'} ${e.amount_chf ? k(Math.abs(e.amount_chf)) : ''} (${e.label.toLowerCase()}) ${at(e.start_month)}`
      case 'invest': return `invest${e.monthly_amount_chf ? ` ${k(e.monthly_amount_chf)}/mo` : ''}${e.amount_chf ? ` ${k(e.amount_chf)}` : ''} ${at(e.start_month)}`
      case 'market_shock': return `markets −${e.drop_pct ?? 30}% ${at(e.start_month)}`
      case 'take_loan': return `borrow ${e.amount_chf ? k(e.amount_chf) : ''} ${at(e.start_month)}`
      case 'buy_home': return `buy a home${e.amount_chf ? ` for ${k(e.amount_chf)}` : ''} ${at(e.start_month)}`
    }
  }
  return [...spec.events].sort((a, b) => (a.start_month ?? 0) - (b.start_month ?? 0)).map(one).join(' · ')
}

export { ev as makeEvent }
