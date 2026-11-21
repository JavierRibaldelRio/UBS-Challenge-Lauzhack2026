// The ECONOMY (macroeconomic variables, "w_t" in the challenge's definition x_{t+1} = F(x_t, a_t, w_t; θ)).
// Shared by EVERY path and every person: inflation vs wages, interest rates, market returns, recessions, house prices.
// The person's own variables (income, rent, spending habit, life decisions, personal luck) are IDIOSYNCRATIC and live in the paths.
//
// The synthetic data covers 24 calm months, so it cannot calibrate the economy. Base = "today's economy unchanged".
// The other presets are labelled stress tests modelled on UBS's scenario catalog (S101–S110). Every number is editable.

export type Macro = {
  id: string
  name: string
  catalog: string | null // closest UBS scenario id
  desc: string
  inflation_pct: number // prices per year
  wage_growth_pct: number // pay per year; prices outrunning pay squeezes the budget
  rate_shift_pct: number // added to every loan / mortgage rate
  market_return_pct: number // real, per year
  market_vol_pct: number // per year
  recession: { start_month: number; months: number; income_drop_pct: number } | null
  crash: { month: number; drop_pct: number } | null // investments fall
  housing_drop: { month: number; drop_pct: number } | null // home values fall
  recession_risk_per_year_pct: number // random recessions in the Monte Carlo (same for all paths in one future)
}

const BASE: Macro = {
  id: 'base', name: 'Today’s economy', catalog: null, desc: 'Prices and pay move together, rates as today, no market growth assumed, no recession.',
  inflation_pct: 0, wage_growth_pct: 0, rate_shift_pct: 0, market_return_pct: 0, market_vol_pct: 0, recession: null, crash: null, housing_drop: null, recession_risk_per_year_pct: 0,
}

export const MACRO_PRESETS: Macro[] = [
  BASE,
  { ...BASE, id: 'uncertain', name: 'Uncertain economy', desc: 'Each simulated future can hit a recession: about 1 year in 10 (Switzerland had two in ~20 years: 2009, 2020). A recession cuts pay 10% for a year and markets 20%. Illustrative.', recession_risk_per_year_pct: 10, market_return_pct: 3, market_vol_pct: 12 },
  { ...BASE, id: 'inflation', name: 'High inflation', catalog: 'S101', desc: 'Prices rise 4% a year, pay only 1.5%: everyday life gets 2.5% more expensive every year. Illustrative stress test.', inflation_pct: 4, wage_growth_pct: 1.5 },
  { ...BASE, id: 'rates', name: 'Rate hike', catalog: 'S103', desc: 'Every loan and mortgage costs 2 percentage points more. Illustrative stress test.', rate_shift_pct: 2 },
  { ...BASE, id: 'recession', name: 'Recession', catalog: 'S104', desc: 'In 2 years: pay down 15% for 12 months, markets down 20%. Illustrative stress test.', recession: { start_month: 24, months: 12, income_drop_pct: 15 }, crash: { month: 24, drop_pct: 20 } },
  { ...BASE, id: 'housing', name: 'Housing downturn', catalog: 'S108', desc: 'In 3 years: home values fall 20% (you still owe the full mortgage). Illustrative stress test.', housing_drop: { month: 36, drop_pct: 20 } },
  { ...BASE, id: 'crisis', name: 'Compound crisis', catalog: 'S110', desc: 'In 2 years: recession (pay −15% for a year), markets −30%, homes −15%, rates +2 points. Illustrative stress test.', rate_shift_pct: 2, recession: { start_month: 24, months: 12, income_drop_pct: 15 }, crash: { month: 24, drop_pct: 30 }, housing_drop: { month: 24, drop_pct: 15 } },
]
export const BASE_MACRO = BASE

/** Short lines describing what this economy changes (for chips, the AI's context, and the facts). */
export function describeMacro(m: Macro, age0: number): string[] {
  const at = (mo: number) => `at ${Math.floor(age0 + mo / 12)}`
  const out: string[] = []
  const gap = m.inflation_pct - m.wage_growth_pct
  if (gap) out.push(`prices ${m.inflation_pct}%/yr vs pay ${m.wage_growth_pct}%/yr (${gap > 0 ? 'life gets' : 'life gets'} ${Math.abs(gap).toFixed(1)}% ${gap > 0 ? 'more expensive' : 'cheaper'} per year)`)
  if (m.rate_shift_pct) out.push(`loan & mortgage rates ${m.rate_shift_pct > 0 ? '+' : ''}${m.rate_shift_pct} points`)
  if (m.market_return_pct || m.market_vol_pct) out.push(`investments ${m.market_return_pct}%/yr real (ups & downs ${m.market_vol_pct}%)`)
  if (m.recession) out.push(`recession ${at(m.recession.start_month)} for ${m.recession.months} months: pay −${m.recession.income_drop_pct}%`)
  if (m.crash) out.push(`markets −${m.crash.drop_pct}% ${at(m.crash.month)}`)
  if (m.housing_drop) out.push(`home values −${m.housing_drop.drop_pct}% ${at(m.housing_drop.month)}`)
  if (m.recession_risk_per_year_pct) out.push(`random recessions: ${m.recession_risk_per_year_pct}% chance per year`)
  return out
}

/** The economy-related part of a chat turn (from the AI). Null fields = keep. */
export type MacroUpdate = {
  preset: string | null
  inflation_pct: number | null
  wage_growth_pct: number | null
  rate_shift_pct: number | null
  market_return_pct: number | null
  market_vol_pct: number | null
  recession_start_month: number | null
  recession_months: number | null
  recession_income_drop_pct: number | null
  crash_month: number | null
  crash_drop_pct: number | null
  housing_drop_month: number | null
  housing_drop_pct: number | null
  recession_risk_per_year_pct: number | null
}

export function applyMacroUpdate(current: Macro, u: MacroUpdate): Macro {
  const base = (u.preset && MACRO_PRESETS.find((p) => p.id === u.preset)) || current
  const m: Macro = { ...base, id: 'custom', name: u.preset && !hasNumbers(u) ? base.name : 'Custom economy', catalog: base.catalog }
  if (u.preset && !hasNumbers(u)) return { ...base }
  const set = <K extends keyof Macro>(k: K, v: Macro[K] | null) => v != null && (m[k] = v)
  set('inflation_pct', u.inflation_pct)
  set('wage_growth_pct', u.wage_growth_pct)
  set('rate_shift_pct', u.rate_shift_pct)
  set('market_return_pct', u.market_return_pct)
  set('market_vol_pct', u.market_vol_pct)
  set('recession_risk_per_year_pct', u.recession_risk_per_year_pct)
  if (u.recession_start_month != null || u.recession_income_drop_pct != null || u.recession_months != null)
    m.recession = { start_month: u.recession_start_month ?? m.recession?.start_month ?? 0, months: u.recession_months ?? m.recession?.months ?? 12, income_drop_pct: u.recession_income_drop_pct ?? m.recession?.income_drop_pct ?? 10 }
  if (u.crash_month != null || u.crash_drop_pct != null) m.crash = { month: u.crash_month ?? m.crash?.month ?? 0, drop_pct: u.crash_drop_pct ?? m.crash?.drop_pct ?? 30 }
  if (u.housing_drop_month != null || u.housing_drop_pct != null) m.housing_drop = { month: u.housing_drop_month ?? m.housing_drop?.month ?? 0, drop_pct: u.housing_drop_pct ?? m.housing_drop?.drop_pct ?? 20 }
  return m
}
const hasNumbers = (u: MacroUpdate) => Object.entries(u).some(([k, v]) => k !== 'preset' && v != null)
