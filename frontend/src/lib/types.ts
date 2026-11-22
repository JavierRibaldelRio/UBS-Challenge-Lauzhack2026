// Shapes of the model artifacts and of the LLM scenario contract (mirrors backend/schema.ts — keep in sync).
// Artifacts: params.json + profiles.json (ml/train.py: data, defaults, people), spending.json + macro.json
// (scripts/import-r-model.ts: the models estimated in R), backtest.json (src/test/backtest.test.ts).

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
  | 'buy_home'
  | 'buy_asset'

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
  down_payment_pct: number | null
  depreciation_pct: number | null
  /** income_change only: repeat the % change every N months (12 = a yearly raise), compounding */
  repeat_every_months?: number | null
  /** set by presets only: where the preset's numbers come from */
  _source?: string
}

export type ScenarioSpec = { name: string; catalog_id: string | null; events: TwinEvent[] }
export type ProfileUpdate = {
  monthly_net_income_chf: number | null
  monthly_rent_chf: number | null
  cash_chf: number | null
  investments_chf: number | null
  monthly_spending_chf: number | null
  /** value of a home they ALREADY own today (gifted, inherited, bought earlier) */
  home_value_chf?: number | null
  /** the least cash they ever want to have: a liquidity floor (constraint) */
  min_cash_chf?: number | null
  summary: string
}
export type ParseResult = { profile_update?: ProfileUpdate | null; scenarios: ScenarioSpec[]; horizon_years: number | null; discount_rate_pct?: number | null; unsupported: string[]; note: string | null }
export type TurnResult = {
  reply: string
  profile_update: ProfileUpdate | null
  new_paths: (ScenarioSpec & { parent_id?: string | null })[]
  /** path = the complete new version (events changed / removed), or null + add_events (only additions: shorter) */
  edits: { path_id: string; path: ScenarioSpec | null; add_events?: TwinEvent[]; changes: string[] }[]
  remove_path_ids: string[]
  undo_path_ids?: string[]
  new_goals: { name: string; target_chf: number; by_month: number }[]
  remove_goals: string[]
  macro_update: import('./macro').MacroUpdate | null
  horizon_years: number | null
  /** discount rate for today's-money values (NPV), shared by every path; null = keep the current one (default 3%) */
  discount_rate_pct?: number | null
  unsupported: string[]
}
export type EditResult = { path: ScenarioSpec; changes: string[]; unsupported: string[]; note: string | null }
export type ExplainResult = { headline: string; explanation: string; caveat: string }
export type AnswerResult = { short_answer: string; reasoning: string; confidence_level: 'high' | 'medium' | 'low'; confidence_sentence: string }
/** exactly what was sent to the LLM (returned by the backend so the UI can show it) */
export type PromptInfo = { system: string; user: string; settings: Record<string, unknown> }
/** where a path came from (shown in "how this path was made") */
export type Origin =
  | { kind: 'today' }
  | { kind: 'preset'; button: string; desc: string }
  | { kind: 'ai'; question: string; model: string; ms?: number; cached?: boolean; prompt?: PromptInfo; answer: ParseResult }
  | { kind: 'offline'; question: string; reason: string; answer: ParseResult }

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
  calib: Calib
  ledger_closing_cash: number[]
  /** told in the chat: a home they already own (not in the data) */
  home?: number
  /** told in the chat: the least cash they want to keep (a constraint, C_t >= C_min) */
  minCash?: number
}

/** A person's spending calibration, from R (client_effects.csv). */
export type Calib = {
  /** R's regular-month non-rent spending: base[status] + city offset + u (never changes) */
  model_mu: number
  /** usual non-rent spending in a regular month: model_mu, or what the user told the twin */
  other_mu: number
  /** month-to-month spread in a regular month (sigma_i: own SD shrunk toward similar people, small-sample bias undone) */
  other_sd: number
  /** the person's own offset (BLUP) and its uncertainty */
  u: number
  u_sd: number
  /** ledger months it was estimated from */
  months: number
}

/** The monthly spending model estimated in R (R/eda.R -> R/output/model_parameters.csv). */
export type SpendingModel = {
  source: string
  /** non-rent spending by status and calendar month (Jan..Dec), population-average city, non-bonus month (CHF/mo) */
  base: Record<Status, number[]>
  /** mean of the regular months (not Feb / Aug / Dec; not Sep for students) */
  base_regular: Record<Status, number>
  /** cost-of-living offset vs the average city (CHF/mo) */
  city_offset: Record<string, number>
  /** students' tuition-like Feb / Sep peaks above their regular months: removed inside a study event (its tuition is explicit) */
  student_month_excess: number[]
  /** spread multiplier per calendar month (1 in regular months) */
  k: Record<Status, number[]>
  /** log(sigma) ~ status + log(income): how the spread changes when the situation changes */
  log_sigma: { intercept: number; log_income: number; status: Record<Status, number> }
  /** December bonus (share of monthly income): only groups with an estimated size distribution */
  bonus: Partial<Record<Status, { probability: number; size_quantiles: number[] }>>
  /** SD of personal offsets between people */
  sigma_u: number
}
export type SpendingFile = { model: SpendingModel; clients: Record<string, Calib> }

/** The economy forecast estimated in R (R/macro.R): VAR(1) on (inflation %, log unemployment %), annual, Swiss data. */
export type MacroModel = {
  source: string
  c: [number, number]
  /** rows = equation (inflation, log unemployment), columns = last year's (inflation, log unemployment) */
  A: [[number, number], [number, number]]
  /** lower Cholesky factor of the shock covariance */
  chol: [[number, number], [number, number]]
  start: { year: number; inflation_pct: number; unemployment_pct: number }
  long_run: { inflation_pct: number; unemployment_pct: number }
  labour: {
    duration_months: number
    registered_share: number
    replacement: number
    replacement_higher: number
    low_salary_threshold_month: number
    insured_salary_cap_year: number
    max_months_standard: number
    max_months_young: number
    max_months_55plus: number
    real_wage_growth: number
  }
  labour_sources: Record<string, string>
  backtest: { variable: string; horizon: number; n: number; coverage80: number; coverage50: number; rmse_model: number; rmse_random_walk: number; rmse_hist_mean: number }[]
  forecast: { year: number; variable: string; p10: number; p50: number; p90: number }[]
}

type Median = { median: number; p10?: number; p90?: number; n: number }

export type Params = {
  version: number
  seed: number
  units: string
  source: { files: string[]; profile_months: number; profiles: number; period: string; income_convention: string }
  data_checks: { rows: number; identity_violations: number; continuity_violations: number; negative_months: number; negative_flag_mismatch: number }
  /** monthly spending (R model) */
  spending: SpendingModel
  /** economy forecast (R model), used by the "Forecast (Swiss data)" economy */
  macro_model: MacroModel
  anchors: {
    income_by_status: Record<Status, { all: Median; by_age_band: Record<string, Median> }>
    rent_by_city: Record<string, { all: Median; by_household: Partial<Record<Household, Median>> }>
    city_canton: Record<string, string>
    study: { annual_tuition_chf_values: number[]; annual_tuition_chf_median: number; duration_years_median: number; source: string }
  }
  /** the simulator tested on 2026 with parameters estimated on 2025 only (backtest.json) */
  backtest: Backtest
  catalog: { id: string; category: string; name: string; baseline: string; intervention: string }[]
}

export type Backtest = {
  method: string
  profiles: number
  paths_per_profile: number
  coverage_80_year_end: number
  coverage_50_year_end: number
  coverage_80_all_months: number
  calibration_central?: { said: number; real: number }[]
  calibration_ends_higher?: { said: string; pairs: number; avg_said: number; real: number }[]
  calibration_negative_cash?: { said: string; profiles: number; avg_said: number; real: number }[]
  median_abs_error_year_end_chf: number
  median_abs_error_naive_chf: number
  brier_negative_cash_model: number
  brier_negative_cash_naive: number
  naive_definition: string
}

/** Where a number comes from. Shown as a coloured tag on every assumption. */
export type Source = 'data' | 'learned' | 'you' | 'assumption' | 'missing' | 'macro'

export type Assumption = {
  key: string
  label: string
  value: number
  unit: string
  source: Source
  note: string
  /** peer range from the data (10th-90th percentile) and which direction is good for the person */
  range?: { lo: number; hi: number; good: 'higher' | 'lower' }
  /** month from which this number starts to matter (events only) */
  month?: number
}
