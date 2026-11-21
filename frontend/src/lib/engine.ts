// Deterministic monthly cash simulation — TS port of pre_docs/starter-kit/financial_twin.py.
// C_{t+1} = C_t + I_t - E_t - K_t   (all CHF, months 0-indexed, phases are [start, end))
// Placeholder engine: cash only, no tax/investments/debt/inflation yet.

export type Phase = {
  start_month: number
  end_month: number
  monthly_income_chf: number
  monthly_expenses_chf: number
}

export type Scenario = {
  name: string
  phases: Phase[]
  one_off_costs?: { month: number; amount_chf: number }[]
}

export type SimulationResult = {
  scenario_name: string
  opening_cash_chf: number
  closing_cash_chf: number
  minimum_cash_chf: number
  first_negative_month: number | null
  cash_by_month_chf: number[]
}

const r2 = (x: number) => Math.round(x * 100) / 100

export function simulate(openingCash: number, months: number, scenario: Scenario): SimulationResult {
  const income: number[] = new Array(months).fill(NaN)
  const expenses: number[] = new Array(months).fill(NaN)

  for (const p of scenario.phases) {
    if (!(0 <= p.start_month && p.start_month < p.end_month && p.end_month <= months)) {
      throw new Error(`Invalid phase interval in "${scenario.name}"`)
    }
    for (let m = p.start_month; m < p.end_month; m++) {
      if (!Number.isNaN(income[m])) throw new Error(`Overlapping phases at month ${m}`)
      income[m] = p.monthly_income_chf
      expenses[m] = p.monthly_expenses_chf
    }
  }
  if (income.some(Number.isNaN)) throw new Error(`Phases must cover every month in "${scenario.name}"`)

  const costs = new Array(months).fill(0)
  for (const c of scenario.one_off_costs ?? []) costs[c.month] += c.amount_chf

  let cash = openingCash
  const balances: number[] = []
  for (let m = 0; m < months; m++) {
    cash = cash + income[m] - expenses[m] - costs[m]
    balances.push(r2(cash))
  }

  const neg = balances.findIndex((v) => v < 0)
  return {
    scenario_name: scenario.name,
    opening_cash_chf: r2(openingCash),
    closing_cash_chf: balances[balances.length - 1],
    minimum_cash_chf: r2(Math.min(openingCash, ...balances)),
    first_negative_month: neg === -1 ? null : neg,
    cash_by_month_chf: balances,
  }
}

// Same illustrative assumptions as pre_docs/starter-kit/scenario_config.json
export const ALEXIA_SCENARIOS: Scenario[] = [
  {
    name: 'Start working',
    phases: [{ start_month: 0, end_month: 120, monthly_income_chf: 4200, monthly_expenses_chf: 3000 }],
  },
  {
    name: "Master's degree",
    phases: [
      { start_month: 0, end_month: 24, monthly_income_chf: 1200, monthly_expenses_chf: 2100 },
      { start_month: 24, end_month: 120, monthly_income_chf: 4800, monthly_expenses_chf: 3100 },
    ],
    one_off_costs: [
      { month: 0, amount_chf: 2500 },
      { month: 12, amount_chf: 2500 },
    ],
  },
  {
    name: 'Move abroad',
    phases: [{ start_month: 0, end_month: 120, monthly_income_chf: 3700, monthly_expenses_chf: 2900 }],
    one_off_costs: [{ month: 0, amount_chf: 6500 }],
  },
]
