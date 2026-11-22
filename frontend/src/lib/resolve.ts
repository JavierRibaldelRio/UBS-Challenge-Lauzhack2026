// Turns "profile + list of events" into a month-by-month PLAN.
// Every number used gets an Assumption record saying where it came from:
//   data       = read from the challenge CSVs (or a median of them)
//   learned    = estimated in R (R/eda.R) from the 24-month ledgers of the 1,200 people
//   you        = typed by the user (or stated in the chat)
//   assumption = not in the data, a labelled default (editable)
//   missing    = nobody knows; default is "no change" and the UI asks you to set it
//   macro      = the economy (shared by every path)
import { chf } from './fmt'
import { BASE_MACRO, type Macro } from './macro'
import { DEFAULT_DISCOUNT_PCT, discountFactors } from './valuation'
import type { Assumption, Household, MacroModel, Params, Profile, ScenarioSpec, Source, Status, TwinEvent } from './types'

/** The "Forecast (Swiss data)" economy: inflation and unemployment drawn per simulated future (R/macro.R). */
export type MacroPlan = {
  model: MacroModel
  findRate: number // chance per month of finding a job again (1 / average duration)
  realWageGrowth: number // pay growth above last year's inflation (share per year)
  exposed: Uint8Array // 1 = an employee this month (can lose the job; the self-employed are not insured)
  replacement: Float64Array // benefit as a share of pay, if the job is lost this month
  maxBenefitMonths: Int32Array // how long the benefit is paid, if the job is lost this month
  benefitCap: number // CHF/month: insured earnings cap
  afterIncome: Float64Array // income once benefits run out (typical income of unemployed people of that age, data)
}

export type Plan = {
  months: number
  income: Float64Array
  rent: Float64Array
  otherMu: Float64Array // expected non-rent spending this calendar month (R model)
  otherSd: Float64Array // month-to-month spending std-dev this calendar month
  unempMu: Float64Array // the same if unemployed this month (only used by the forecast economy)
  unempSd: Float64Array
  extra: Float64Array // recurring extra costs
  oneOff: Float64Array // single costs (>0) / money in (<0), incl. tuition
  contrib: Float64Array // cash -> investments transfers
  homeDown: Float64Array // own money paid into a home (down payment)
  homeValue: Float64Array // value of everything owned besides cash & investments: home, car… (counted in net worth, not in cash)
  revalue: Float64Array // value changes with no money moving (depreciation, house-price drops): part of the net-worth check
  purchases: { month: number; price: number; down: number; loan: number; label: string; kind: 'home' | 'asset' }[]
  macroRisk: number // yearly chance of a random recession (economy), drawn per simulated future
  macro: MacroPlan | null // inflation + unemployment forecast (economy "Forecast (Swiss data)")
  status: Status[]
  household: Household[]
  city: string[]
  shocks: { month: number; drop: number }[]
  loans: { start: number; principal: number; annualRate: number; payment: number; isNew: boolean; toSeller?: boolean; amort?: { perMonth: number; months: number } }[]
  startCash: number
  startInvest: number
  /** a home owned from the start (told in the chat) */
  startHome: number
  muSe: number // uncertainty (SD) of the personal spending offset u (parameter uncertainty)
  invReturn: number // expected real annual return
  invVol: number // annual volatility
  /** real discount rate for today's-money values (NPV), the same for every path; df[t] = (1+d)^(−(t+1)/12) */
  discountRate: number
  df: Float64Array
  /** month from which the decision changes income (used for break-even) */
  changeMonth: number | null
  assumptions: Assumption[]
  warnings: string[]
}

export type Overrides = Record<string, number>

export const BAND = (age: number) => `${Math.floor(age / 5) * 5}-${Math.floor(age / 5) * 5 + 4}`
const chf0 = (x: number) => `${x < 0 ? '−' : '+'}CHF ${Math.round(Math.abs(x))}/mo`

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
  discountPct: number | null = null, // discount rate for NPV, shared by all paths; null = the default (DEFAULT_DISCOUNT_PCT)
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
  const revalue = new Float64Array(H)
  const inStudy = new Uint8Array(H) // months inside a study event (its tuition is explicit)
  const purchases: Plan['purchases'] = []
  const shocks: Plan['shocks'] = []
  const loans: Plan['loans'] = []
  let changeMonth: number | null = null
  const ageAt = (t: number) => profile.age + t / 12
  const clampM = (m: number | null | undefined) => Math.max(0, Math.min(H - 1, Math.round(m ?? 0)))
  const endOf = (s: number, d: number | null) => (d == null ? H : Math.max(s + 1, Math.min(H, s + Math.round(d))))

  // ---- global, profile-level numbers
  const startCash = A('g.cash', 'Starting cash', profile.cash, 'CHF', 'data', `opening_cash_chf, ${profile.as_of} (synthetic-profiles.csv)`)
  const startInvest = A('g.invest', 'Starting investments', profile.investments, 'CHF', 'data', 'investment_portfolio (synthetic-assets.csv)')
  // a home they already own (told in the chat, not in the data): part of net worth from day one, never cash
  const startHome = profile.home ? A('g.home', 'Home you already own', profile.home, 'CHF', 'you', 'you told the twin (a fact about today); value kept constant in 2025 francs') : 0
  if (startHome) homeValue.fill(startHome)
  const otherBase = A('g.other', 'Usual spending, excl. rent', profile.calib.other_mu, 'CHF/mo', 'learned', `in a regular month (not Feb / Aug / Dec): typical for a ${profile.status.replace('_', '-')} person in ${profile.city} + your own offset (${chf0(profile.calib.u)}); R model on 1,200 people × ${profile.calib.months} months`)
  const sdBase = A('g.sd', 'Spending ups & downs (1 std-dev)', profile.calib.other_sd, 'CHF/mo', 'learned', `in a regular month: your own spread over ${profile.calib.months} months, pulled toward people like you (R model); larger in Feb / Aug / Dec`)
  const invReturn = A('m.ret', 'Economy: investment return (per year, 2025 francs)', macro.market_return_pct, '%', macro.id === 'base' ? 'assumption' : 'macro', macro.id === 'base' ? 'Not in the data (assets are a single snapshot). 4% = UBS’s illustrative rate (financial-concepts.md §6: 10,000 at 4% for 5 years ≈ 12,167). A modelling assumption, not a forecast; shared by every path. Edit it or pick an economy.' : `set by the economy “${macro.name}”; shared by every path`) / 100
  // valuation only (never changes the simulation): one rate for every path; set globally, so per-path overrides are ignored
  const discPct = discountPct ?? DEFAULT_DISCOUNT_PCT
  assumptions.push({
    key: 'v.disc',
    label: 'Discount rate for today’s-money values (NPV, per year)',
    value: discPct,
    unit: '%',
    source: discountPct == null ? 'assumption' : 'you',
    note:
      discountPct == null
        ? `Not in the data. Default ${DEFAULT_DISCOUNT_PCT}% a year (real, 2025 francs) for every path, person and economy. Used only to value paths in today’s money (NPV); it never changes the simulation. Edit it or say “use a 5% discount rate”.`
        : 'you set it; shared by every path. Used only to value paths in today’s money (NPV).',
    month: 0,
  })
  const discountRate = discPct / 100
  const invVol = A('m.vol','Economy: market ups & downs (per year)', macro.market_vol_pct, '%', macro.market_vol_pct ? 'macro' : 'assumption', macro.market_vol_pct ? `set by the economy “${macro.name}”` : 'Not in the data. 0% = no market noise.') / 100
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
          inStudy[t] = 1
        }
        for (let t = s; t < end; t += 6) oneOff[t] += tuition / 2
        // students in the data spend more in Feb and Sep (tuition-like): here the tuition above is paid explicitly
        let peaks = 0
        for (let t = s; t < end; t++) peaks += params.spending.student_month_excess[t % 12]
        if (peaks > 0) assumptions.push({ key: `${k}.info`, label: `${e.label}: students’ Feb / Sep peaks left out`, value: Math.round((peaks / (end - s)) * 12), unit: 'CHF/yr', source: 'learned', note: `students in the data spend about ${chf(params.spending.student_month_excess[1])} more in February and ${chf(params.spending.student_month_excess[8])} more in September (tuition-like); the tuition above is paid explicitly, so these are not counted twice (R model)`, month: s })
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
        const every = e.repeat_every_months && e.repeat_every_months > 0 && byPct ? Math.round(e.repeat_every_months) : 0
        if (every) {
          // a recurring raise (e.g. +2% every 12 months for 10 years): each step applies to the income BEFORE it, so it
          // compounds; a raise is kept afterwards. Income growth is an assumption UBS lists (scenario-modelling §11).
          let steps = 0
          for (let r = s; r < end; r += every) {
            for (let t = r; t < H; t++) income[t] *= 1 + pctV / 100
            steps++
          }
          assumptions.push({ key: `${k}.info`, label: `${e.label}: after ${steps} step${steps === 1 ? '' : 's'}`, value: Math.round((Math.pow(1 + pctV / 100, steps) - 1) * 1000) / 10, unit: '% in total (compounded)', source: 'you', note: `${pctV}% every ${every} months, each on top of the last`, month: s })
        } else {
          for (let t = s; t < end; t++) {
            income[t] = byPct ? income[t] * (1 + pctV / 100) : newInc
            if (income[t] <= 0) status[t] = 'unemployed'
          }
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
        // a negative lump sum = selling (money goes back to cash; the engine never sells more than is held)
        if (e.amount_chf != null) contrib[s] += A(`${k}.lump`, `${e.label}: ${e.amount_chf < 0 ? 'sold (back to cash)' : 'lump sum invested'}`, e.amount_chf, 'CHF', tag, tagNote)
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
        // Swiss practice: the part of the mortgage above 2/3 of the price ("second mortgage") is paid off within 15 years;
        // the rest is interest-only. So the debt slopes down for 15 years, then stays.
        const second = Math.max(0, mortgage - (2 / 3) * price)
        const amortYears = A(`${k}.amort`, `${e.label}: pay off the part above 2/3 of the price within`, 15, 'years', 'assumption', 'Swiss bank practice for the “second mortgage” (assumed; not in the data).')
        loans.push({ start: s, principal: mortgage, annualRate: rate, payment: (mortgage * rate) / 12, isNew: true, toSeller: true, amort: second > 0 ? { perMonth: second / (amortYears * 12), months: amortYears * 12 } : undefined })
        purchases.push({ month: s, price, down: price - mortgage, loan: mortgage, label: e.label, kind: 'home' })
        assumptions.push({ key: `${k}.info`, label: `${e.label}: mortgage`, value: Math.round(mortgage), unit: 'CHF', source: 'assumption', note: `price − own money; ${second > 0 ? `${Math.round(second).toLocaleString('de-CH')} of it paid off over the years, the rest interest-only` : 'interest-only'}; rent stops; home value kept constant in 2025 francs` })
        break
      }
      case 'buy_asset': {
        // anything you own that is not a home: car, motorbike, boat, equipment… counted as an asset that loses value
        const price = A(`${k}.price`, `${e.label}: price`, e.amount_chf ?? 0, 'CHF', e.amount_chf != null ? tag : 'missing', e.amount_chf != null ? tagNote : 'Price not given.')
        if (price <= 0) {
          warnings.push(`“${e.label}” has no effect until you set a price.`)
          break
        }
        const ownPct = A(`${k}.own`, `${e.label}: paid with own money`, e.down_payment_pct ?? 100, '%', e.down_payment_pct != null ? tag : 'assumption', e.down_payment_pct != null ? tagNote : 'Paid in full unless you say it is financed.')
        const dep = A(`${k}.dep`, `${e.label}: loses value per year`, e.depreciation_pct ?? 15, '%', e.depreciation_pct != null ? tag : 'assumption', e.depreciation_pct != null ? tagNote : 'Typical for a car; not in the data. Edit for other things.')
        const running = A(`${k}.run`, `${e.label}: running costs`, e.monthly_amount_chf ?? 0, 'CHF/mo', e.monthly_amount_chf != null ? tag : 'missing', e.monthly_amount_chf != null ? tagNote : 'Insurance, fuel, upkeep: not given.')
        const own = (price * ownPct) / 100
        const loan = price - own
        homeDown[s] += own
        let prev = 0
        for (let t = s; t < H; t++) {
          const val = price * Math.pow(1 - dep / 100, (t - s) / 12)
          homeValue[t] += val
          if (t > s) revalue[t] += val - prev
          prev = val
          extra[t] += running
        }
        if (loan > 0) {
          const r = (loanRateMedian + shift) / 12
          const term = A(`${k}.term`, `${e.label}: loan repaid over`, e.duration_months ?? 48, 'months', e.duration_months != null ? tag : 'assumption', e.duration_months != null ? tagNote : '4 years assumed; rate = median of the 283 loans in the data.')
          loans.push({ start: s, principal: loan, annualRate: r * 12, payment: r === 0 ? loan / term : (loan * r) / (1 - Math.pow(1 + r, -term)), isNew: true, toSeller: true })
        }
        purchases.push({ month: s, price, down: own, loan, label: e.label, kind: 'asset' })
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

  // ---- decisions that cannot work as written (shown on the path and in the chat, never silently ignored)
  for (const e of spec.events) {
    const m = Math.round(e.start_month ?? 0)
    if (m >= H) warnings.push(`“${e.label}” starts at ${Math.floor(ageAt(m))}, after the end of the simulation (${Math.floor(ageAt(H))}): it has no effect. Show more years to include it.`)
  }
  const studies = spec.events.filter((e) => e.type === 'study').map((e) => {
    const s0 = clampM(e.start_month)
    const sa = profile.study_assumption
    const d = e.duration_months ?? (sa?.study_duration_years ?? params.anchors.study.duration_years_median) * 12
    return { s0, end: s0 + Math.round(d), label: e.label }
  })
  for (const j of spec.events.filter((e) => e.type === 'start_job')) {
    const m = clampM(j.start_month)
    const st = studies.find((x) => m >= x.s0 && m < x.end)
    if (st) warnings.push(`“${j.label}” starts while studying (“${st.label}” runs until ${Math.floor(ageAt(st.end))}): its salary replaces the student income during the degree. For a salary AFTER the degree, start the job at ${Math.floor(ageAt(st.end))}.`)
  }

  // ---- monthly non-rent spending: the model estimated in R (R/eda.R -> model_parameters.csv), month by month
  //   otherMu[t] = base[status, calendar month] + city offset + your offset u (+ your correction, if you gave one)
  //                − students' Feb / Sep peaks inside a study event (its tuition is explicit)
  //   otherSd[t] = your regular-month spread × how the spread changes with status and income × month multiplier k
  // Income, household and age do not move the level: in the data they add nothing once status and city are known.
  const S = params.spending
  const cityOff = (c: string) => S.city_offset[c] ?? 0 // abroad / unknown city: the average Swiss city
  const shiftMu = otherBase - profile.calib.model_mu // 0 unless the person told the twin their usual spending
  const level = (st: Status, c: string) => S.base_regular[st] + cityOff(c) + profile.calib.u + shiftMu // regular month
  const logSig = (st: Status, inc: number) => S.log_sigma.status[st] + S.log_sigma.log_income * Math.log(Math.max(1, inc))
  const sig0 = logSig(profile.status, profile.income)
  const sdRatio = (st: Status, inc: number) => Math.min(4, Math.max(0.25, Math.exp(logSig(st, inc) - sig0)))
  const muAt = (t: number, st: Status) => Math.max(0, S.base[st][t % 12] + cityOff(city[t]) + profile.calib.u + shiftMu - (inStudy[t] ? S.student_month_excess[t % 12] : 0))
  // unemployment benefit as a share of pay if the job were lost this month (Swiss law, AVIG Art. 22; forecast economy)
  const L = params.macro_model.labour
  const replAt = (t: number) => (household[t] === 'family' || income[t] <= L.low_salary_threshold_month ? L.replacement_higher : L.replacement)
  const otherMu = new Float64Array(H)
  const otherSd = new Float64Array(H)
  const unempMu = new Float64Array(H) // if this month were spent unemployed (forecast economy)
  const unempSd = new Float64Array(H)
  for (let t = 0; t < H; t++) {
    otherMu[t] = muAt(t, status[t])
    otherSd[t] = sdBase * sdRatio(status[t], income[t]) * S.k[status[t]][t % 12]
    unempMu[t] = muAt(t, 'unemployed')
    unempSd[t] = sdBase * sdRatio('unemployed', income[t] * replAt(t)) * S.k.unemployed[t % 12]
  }
  const dEnd = level(status[H - 1], city[H - 1]) - level(profile.status, profile.city)
  if (spec.events.length && Math.abs(dEnd) >= 1) {
    assumptions.push({ key: 'learned.delta', label: 'Spending response to the new situation', value: Math.round(dEnd), unit: 'CHF/mo', source: 'learned', note: `a regular month at the end (${status[H - 1].replace('_', '-')}${city[H - 1] !== profile.city ? `, ${city[H - 1]}` : ''}) vs today: how non-rent spending differs by status and city in the data (R model on 1,200 people × 24 months); your own offset is kept` })
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
      unempMu[t] *= f
      unempSd[t] *= f
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
    if (loss > 0) {
      for (let t = m0; t < H; t++) homeValue[t] -= loss
      revalue[m0] -= loss
    }
    assumptions.push({ key: 'm.house', label: `Economy: home values fall at ${Math.floor(ageAt(m0))}`, value: -macro.housing_drop.drop_pct, unit: '%', source: 'macro', note: `${loss > 0 ? 'hits net worth, not cash' : 'no home owned at that time on this path'} · ${macroNote}`, month: m0 })
  }
  if (macro.recession_risk_per_year_pct) assumptions.push({ key: 'm.risk', label: 'Economy: chance of a recession each year', value: macro.recession_risk_per_year_pct, unit: '%', source: 'macro', note: `in each simulated future a recession can start (pay −10% for 12 months, markets −20%), the same for every path · ${macroNote}` })

  // ---- the economy FORECAST (R/macro.R): inflation and unemployment drawn per simulated future in sim.ts
  let macroPlan: MacroPlan | null = null
  if (macro.forecast) {
    curMonth = 0
    const M = params.macro_model
    const bt1 = (v: string) => M.backtest.find((b) => b.variable === v && b.horizon === 1)
    const cov = (v: string) => Math.round((bt1(v)?.coverage80 ?? NaN) * 100)
    const fc1 = (v: string) => M.forecast.find((f) => f.variable === v && f.year === M.start.year + 1)
    const r1 = (x: number | undefined) => (x == null ? '?' : (Math.round(x * 10) / 10).toFixed(1))
    assumptions.push({
      key: 'm.fc.info', label: 'Economy: inflation & unemployment forecast', value: Math.round(M.start.unemployment_pct * 10) / 10, unit: `% unemployed in ${M.start.year}`, source: 'macro',
      note: `model of Swiss data 1991–${M.start.year} (World Bank; ILO unemployment). ${M.start.year} = observed (inflation ${r1(M.start.inflation_pct)}%); after that each simulated future draws its own year by year. ${M.start.year + 1}: inflation ${r1(fc1('inflation_pct')?.p50)}% (80% range ${r1(fc1('inflation_pct')?.p10)} to ${r1(fc1('inflation_pct')?.p90)}), unemployment ${r1(fc1('unemployment_pct')?.p50)}% (${r1(fc1('unemployment_pct')?.p10)} to ${r1(fc1('unemployment_pct')?.p90)}). Tested on 2005–2024, one year ahead: the 80% range held ${cov('inflation_pct')}% of the time for inflation, ${cov('unemployment_pct')}% for unemployment`,
    })
    const dur = A('m.dur', 'Economy: months to find a new job (average)', macro.forecast.job_search_months ?? L.duration_months, 'months', macro.forecast.job_search_months != null ? 'you' : 'assumption', `${M.labour_sources.duration_months}. The national unemployment rate sets the chance of losing a job (the same for every employee): an aggregate figure, not your personal risk`)
    const g = A('m.wage', 'Economy: pay growth above inflation', macro.forecast.real_wage_growth_pct ?? L.real_wage_growth * 100, '%/yr', macro.forecast.real_wage_growth_pct != null ? 'you' : 'assumption', 'Pay follows LAST year’s inflation (Swiss wage rounds) plus this; prices follow the forecast, so costs run ahead of pay while inflation is rising. Cash keeps its value in today’s francs, as in every economy') / 100
    assumptions.push({
      key: 'm.ui.info', label: 'Economy: unemployment benefit', value: L.replacement * 100, unit: '% of pay', source: 'macro',
      note: `${L.replacement_higher * 100}% with children or pay ≤ ${chf(L.low_salary_threshold_month)}/month; paid up to ${L.max_months_standard} months (${L.max_months_young} under 25 without children, ${L.max_months_55plus} from 55); insured pay up to ${chf(L.insured_salary_cap_year)}/yr; afterwards the typical income of unemployed people in the data. Employees only: the self-employed are not insured (Swiss law, AVIG Art. 22 and 27; applied to net pay as an approximation)`,
    })
    const exposed = new Uint8Array(H)
    const replacement = new Float64Array(H)
    const maxBenefitMonths = new Int32Array(H)
    const afterIncome = new Float64Array(H)
    for (let t = 0; t < H; t++) {
      exposed[t] = status[t] === 'employed' || status[t] === 'part_time' ? 1 : 0
      replacement[t] = replAt(t)
      const age = ageAt(t)
      maxBenefitMonths[t] = Math.round(age >= 55 ? L.max_months_55plus : age < 25 && household[t] !== 'family' ? L.max_months_young : L.max_months_standard)
      afterIncome[t] = incomeAnchor(params, 'unemployed', age).value
    }
    macroPlan = { model: M, findRate: 1 / Math.max(1, dur), realWageGrowth: g, exposed, replacement, maxBenefitMonths, benefitCap: L.insured_salary_cap_year / 12, afterIncome }
  }

  return {
    macroRisk: macro.recession_risk_per_year_pct / 100,
    macro: macroPlan,
    unempMu,
    unempSd,
    revalue,
    purchases,
    months: H, income, rent, otherMu, otherSd, extra, oneOff, contrib, homeDown, homeValue, status, household, city, shocks, loans,
    startCash, startInvest, startHome, muSe: profile.calib.u_sd, invReturn, invVol, changeMonth, assumptions, warnings,
    discountRate, df: discountFactors(discountRate, H),
  }
}

// ---------------------------------------------------------------- presets (no LLM needed)
const ev = (p: Partial<TwinEvent> & Pick<TwinEvent, 'type' | 'label'>): TwinEvent => ({
  start_month: 0, duration_months: null, monthly_net_income_chf: null, income_change_pct: null, monthly_amount_chf: null,
  amount_chf: null, annual_tuition_chf: null, city: null, household_type: null, annual_rate_pct: null, drop_pct: null, down_payment_pct: null, depreciation_pct: null, ...p,
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
    invest: 'Move CHF 500 a month from cash into investments. They grow at the economy’s return (4% a year by default, UBS’s illustrative rate).',
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
      case 'income_change': return e.repeat_every_months && e.income_change_pct != null ? `income ${e.income_change_pct > 0 ? '+' : ''}${e.income_change_pct}% every ${e.repeat_every_months === 12 ? 'year' : `${e.repeat_every_months} months`} ${at(e.start_month)}${until(e)}` : e.income_change_pct === -100 ? `no income ${d ? `for ${d} months ` : ''}${at(e.start_month)}` : e.monthly_net_income_chf != null ? `income ${k(e.monthly_net_income_chf)}/mo ${at(e.start_month)}${until(e)}` : `income ${e.income_change_pct != null ? `${e.income_change_pct > 0 ? '+' : ''}${e.income_change_pct}%` : 'changes'} ${at(e.start_month)}${until(e)}`
      case 'household_change': return `${e.household_type === 'family' ? 'a child' : e.household_type === 'couple' ? 'move in together' : (e.household_type ?? 'new household').replace('_', ' ')} ${at(e.start_month)}`
      case 'recurring_expense': return `${e.label.toLowerCase().replace(/\s*\d[\d'’,.]*\s*k?\s*(chf)?\s*(a|per|\/)\s*mo(nth)?/i, '')}${e.monthly_amount_chf ? ` ${k(e.monthly_amount_chf)}/mo` : ''} ${at(e.start_month)}${until(e)}`
      case 'one_off': return `${e.amount_chf != null && e.amount_chf < 0 ? 'receive' : 'pay'} ${e.amount_chf ? k(Math.abs(e.amount_chf)) : ''} (${e.label.toLowerCase()}) ${at(e.start_month)}`
      case 'invest': return e.amount_chf != null && e.amount_chf < 0 && !e.monthly_amount_chf ? `sell ${k(-e.amount_chf)} of investments ${at(e.start_month)}` : `invest${e.monthly_amount_chf ? ` ${k(e.monthly_amount_chf)}/mo` : ''}${e.amount_chf ? ` ${k(e.amount_chf)}` : ''} ${at(e.start_month)}`
      case 'market_shock': return `markets −${e.drop_pct ?? 30}% ${at(e.start_month)}`
      case 'take_loan': return `borrow ${e.amount_chf ? k(e.amount_chf) : ''} ${at(e.start_month)}`
      case 'buy_home': return `buy a home${e.amount_chf ? ` for ${k(e.amount_chf)}` : ''} ${at(e.start_month)}`
      case 'buy_asset': return `buy ${e.label.toLowerCase()}${e.amount_chf ? ` for ${k(e.amount_chf)}` : ''} ${at(e.start_month)}`
    }
  }
  return [...spec.events].sort((a, b) => (a.start_month ?? 0) - (b.start_month ?? 0)).map(one).join(' · ')
}

export { ev as makeEvent }
