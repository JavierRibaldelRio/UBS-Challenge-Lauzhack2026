// "Scenario report" in the exact structure UBS asks for (pre_docs/docs/scenario-modelling.md §20, Scenario Reporting Template).
import type { Driver } from './analysis'
import { describeMacro, type Macro } from './macro'
import type { Plan } from './resolve'
import type { Check, SimResult } from './sim'
import type { Origin, Params, Profile, ScenarioSpec } from './types'

type P = { id: string; name: string; spec: ScenarioSpec; plan: Plan; result: SimResult; origin: Origin }

export function scenarioReport(o: { profile: Profile; path: P; baseline: P; macro: Macro; years: number; drivers: Driver[]; checks: Check[]; params: Params; breakEvenPct: number | null }) {
  const { profile: pr, path, baseline, macro } = o
  const r100 = (x: number) => Math.round(x / 100) * 100
  const out = (r: SimResult) => ({
    net_worth_at_end_chf: { p10: r100(r.endNW.p10), median: r100(r.endNW.p50), p90: r100(r.endNW.p90) },
    cash_at_end_median_chf: r100(r.endCash.p50),
    lowest_cash_median_chf: r100(r.minCash.p50),
    chance_cash_below_zero_pct: Math.round(r.probNegCash * 100),
    goals: r.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by: g.date, chance_pct: Math.round(g.prob! * 100) })),
    home_purchases: r.homeBuys.map((h) => ({ month: h.month, down_payment_chf: r100(h.down), chance_down_payment_missing_pct: Math.round(h.shortShare * 100) })),
  })
  const bt = o.params.backtest
  return {
    template: 'UBS scenario reporting template (scenario-modelling.md §20)',
    scenario_id: path.spec.catalog_id ?? path.id,
    question: path.origin.kind === 'ai' || path.origin.kind === 'offline' ? path.origin.question : path.origin.kind === 'preset' ? `+ ${path.origin.button}` : 'If nothing changes',
    initial_state: { person: `${pr.name} (fictional, ${pr.id})`, age: pr.age, city: pr.city, status: pr.status, household: pr.household, net_income_chf_month: pr.income, rent_chf_month: pr.rent, usual_spending_without_rent_chf_month: Math.round(pr.calib.other_mu), cash_chf: pr.cash, investments_chf: pr.investments, loans: pr.loans, goals: pr.goals },
    intervention: { path: path.name, events: path.spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))) },
    baseline: { path: baseline.name, events: baseline.spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))) },
    time_horizon: `${o.years} years, monthly steps (${o.years * 12} months)`,
    currency: 'CHF, constant 2025 francs (real terms); amounts in other currencies are never converted silently',
    jurisdiction: 'Switzerland (synthetic data); incomes are net of tax as given in the data; no tax model',
    assumptions: path.plan.assumptions.map((a) => ({ what: a.label, value: Math.round(a.value * 100) / 100, unit: a.unit, source: a.source, note: a.note })),
    model: {
      idiosyncratic: 'the person: income, rent, usual spending (mixed model estimated in R on 28,800 months: status, city, calendar month + a small personal offset), life decisions as events, personal luck (surprise expenses, December bonus) drawn from that model',
      macroeconomic: `the economy, shared by every path: ${macro.name}${macro.catalog ? ` (${macro.catalog})` : ''}${describeMacro(macro, pr.age).length ? ': ' + describeMacro(macro, pr.age).join('; ') : ''}`,
      method: 'deterministic monthly accounting x_{t+1}=F(x_t,a_t,w_t;θ) + Monte Carlo, 500 futures per path with common random numbers (same luck for every path), fixed seed',
    },
    constraints: ['cash is reconciled every month; negative cash = funding gap, flagged (not hidden, no automatic borrowing)', 'a home down payment must come from own cash at that moment (checked in every future)', 'debt never below zero', 'goals: cash + investments (not home) above target at the goal date'],
    outputs: { path: out(path.result), baseline: out(baseline.result), difference_median_chf: r100(path.result.endNW.p50 - baseline.result.endNW.p50) },
    uncertainty: {
      month_to_month_luck: '10th–90th percentile of 500 futures (see outputs)',
      sensitivity: o.drivers.map((d) => ({ input: d.name, effect_on_end_net_worth_chf: `±${r100(d.range / 2)}` })),
      break_even_income_change_pct: o.breakEvenPct != null ? Math.round(o.breakEvenPct) : null,
      unknown_inputs: path.plan.assumptions.filter((a) => a.source === 'missing').map((a) => a.label),
      economy: macro.name,
    },
    validation: {
      live_accounting_checks: o.checks.map((c) => ({ check: c.name, ok: c.ok })),
      backtest: `estimated on 2025, tested on 2026 for ${bt.profiles} people: 80% range caught ${Math.round(bt.coverage_80_year_end * 1000) / 10}% of real results`,
      data_checks: o.params.data_checks,
    },
    limitations: ['all people and data are fictional (UBS synthetic data), not Swiss statistics', 'the data has no decisions, education or abroad information: decision effects are explicit assumptions, unknowns are marked', 'the economy presets are illustrative stress tests, not forecasts; “Forecast (Swiss data)” models national inflation and unemployment (World Bank data), not this person’s own risk', 'not financial advice'],
  }
}

export function downloadJson(name: string, data: unknown) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
