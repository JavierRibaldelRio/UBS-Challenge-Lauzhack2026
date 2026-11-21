// Shapes of the model artifacts (built by ml/train.py) and of the LLM scenario contract
// (mirrors backend/schema.ts — keep in sync).

export type Status = 'employed' | 'self_employed' | 'part_time' | 'student' | 'unemployed' | 'retired'
export type Household = 'single' | 'couple' | 'family' | 'shared_housing'

export type EventType =
  | 'start_job'
  | 'study'
  | 'relocate'
  | 'income_change'
  | 'household_change'
  | 'recurring_expense'
  | 'one_off'
  | 'invest'
  | 'market_shock'
  | 'take_loan'

export type TwinEvent = {
  type: EventType
  label: string
  start_month: number | null
  duration_months: number | null
  monthly_net_income_chf: number | null
  income_change_pct: number | null
  monthly_amount_chf: number | null
  amount_chf: number | null
  annual_tuition_chf: number | null
  city: string | null
  household_type: Household | null
  annual_rate_pct: number | null
  drop_pct: number | null
  /** set by presets only: where the preset's numbers come from */
  _source?: string
}

export type ScenarioSpec = { name: string; catalog_id: string | null; events: TwinEvent[] }
export type ParseResult = { scenarios: ScenarioSpec[]; horizon_years: number | null; unsupported: string[]; note: string | null }
export type ExplainResult = { headline: string; explanation: string; caveat: string }

export type Profile = {
  id: string
  name: string
  age: number
  city: string
  canton: string
  status: Status
  household: Household
  as_of: string
  income: number
  rent: number
  cash: number
  investments: number
  loans: { principal: number; annual_rate: number; type: string }[]
  goals: { name: string; target: number; date: string; priority: string }[]
  study_assumption: { study_duration_years?: number; annual_tuition_chf?: number } | null
  calib: { other_mu: number; other_sd: number; months: number }
  ledger_closing_cash: number[]
}

export type Regression = {
  target: string
  form: string
  features: string[]
  coefficients: number[]
  cv_r2: Record<string, number>
  selected_cv_r2: number
  n_profiles: number
}

type Median = { median: number; n: number }

export type Params = {
  version: number
  seed: number
  units: string
  source: { files: string[]; profile_months: number; profiles: number; period: string; income_convention: string }
  data_checks: { rows: number; identity_violations: number; continuity_violations: number; negative_months: number; negative_flag_mismatch: number }
  season: Record<Status, number[]>
  bonus: Partial<Record<Status, { probability: number; size_quantiles: number[]; n_decembers: number }>>
  shock_quantiles: number[]
  shock_autocorr_lag1: number
  regressions: { other_spending: Regression; spending_volatility: Regression }
  anchors: {
    income_by_status: Record<Status, { all: Median; by_age_band: Record<string, Median> }>
    rent_by_city: Record<string, { all: Median; by_household: Partial<Record<Household, Median>> }>
    city_canton: Record<string, string>
    study: { annual_tuition_chf_values: number[]; annual_tuition_chf_median: number; duration_years_median: number; source: string }
  }
  backtest: {
    method: string
    profiles: number
    paths_per_profile: number
    coverage_80_year_end: number
    coverage_50_year_end: number
    coverage_80_all_months: number
    median_abs_error_year_end_chf: number
    median_abs_error_naive_chf: number
    brier_negative_cash_model: number
    brier_negative_cash_naive: number
    naive_definition: string
  }
  catalog: { id: string; category: string; name: string; baseline: string; intervention: string }[]
}

/** Where a number comes from. Shown as a coloured tag on every assumption. */
export type Source = 'data' | 'learned' | 'you' | 'assumption' | 'missing'

export type Assumption = {
  key: string
  label: string
  value: number
  unit: string
  source: Source
  note: string
}
