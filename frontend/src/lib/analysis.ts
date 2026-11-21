// Explanations that are COMPUTED, not written: what drives the result, break-even values,
// and the "facts" object the LLM is allowed to talk about (nothing else).
import type { Assumption, Params, Profile } from './types'
import type { Plan } from './resolve'
import { NO_KNOBS, runPath, type Knobs, type SimResult } from './sim'

const endNW = (plan: Plan, params: Params, k: Knobs = NO_KNOBS) => {
  const o = runPath(plan, params, null, k)
  return o.nw[o.nw.length - 1]
}

export type Driver = { name: string; low: number; high: number; range: number }

/** Change each input by ±10% (return by ±1 point) and see how much end net worth moves. */
export function drivers(plan: Plan, params: Params): Driver[] {
  const base = endNW(plan, params)
  const tests: { name: string; lo: Partial<Knobs>; hi: Partial<Knobs> }[] = [
    { name: 'Income ±10%', lo: { income: 0.9 }, hi: { income: 1.1 } },
    { name: 'Rent ±10%', lo: { rent: 1.1 }, hi: { rent: 0.9 } },
    { name: 'Other spending ±10%', lo: { other: 1.1 }, hi: { other: 0.9 } },
    { name: 'One-off costs & tuition ±10%', lo: { oneOff: 1.1 }, hi: { oneOff: 0.9 } },
    { name: 'Investment return ±1 pt', lo: { retShift: -0.01 }, hi: { retShift: 0.01 } },
  ]
  return tests
    .map((d) => {
      const low = endNW(plan, params, { ...NO_KNOBS, ...d.lo }) - base
      const high = endNW(plan, params, { ...NO_KNOBS, ...d.hi }) - base
      return { name: d.name, low, high, range: Math.abs(high - low) }
    })
    .filter((d) => d.range > 1)
    .sort((a, b) => b.range - a.range)
}

/** By how much must income (from the decision month on) change so this branch ends level with the baseline? */
export function breakEven(plan: Plan, baseline: Plan, params: Params): { pct: number; month: number; incomeNeeded: number } | null {
  if (plan.changeMonth == null || plan.changeMonth >= plan.months - 1) return null
  const month = plan.changeMonth
  const target = endNW(baseline, params)
  const f = (x: number) => endNW(plan, params, { ...NO_KNOBS, incomeFrom: { month, scale: 1 + x } }) - target
  let lo = -0.95
  let hi = 5
  if (f(lo) > 0 || f(hi) < 0) return null
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > 0) hi = mid
    else lo = mid
  }
  const x = (lo + hi) / 2
  return { pct: x * 100, month, incomeNeeded: plan.income[month] * (1 + x) }
}

// ---------------------------------------------------------------- facts for the LLM
export type Branch = { id: string; name: string; plan: Plan; result: SimResult; isBaseline: boolean }

const r100 = (x: number) => Math.round(x / 100) * 100
const p = (x: number) => Math.round(x * 100)

export function buildFacts(profile: Profile, params: Params, branches: Branch[], drv: Driver[], be: ReturnType<typeof breakEven>, focusId: string) {
  const H = branches[0]?.plan.months ?? 120
  const base = branches.find((b) => b.isBaseline) ?? branches[0]
  const focus = branches.find((b) => b.id === focusId) ?? base
  const summarize = (a: Assumption) => ({ what: a.label, value: Math.round(a.value), unit: a.unit, source: a.source })
  return {
    person: { name: profile.name, age_now: profile.age, city: profile.city, status: profile.status, fictional: true },
    horizon: { years: H / 12, age_at_end: profile.age + H / 12 },
    units: 'CHF, constant 2025 francs',
    baseline_path: base.name,
    paths: branches.map((b) => ({
      name: b.name,
      is_baseline: b.isBaseline,
      net_worth_at_end_median_chf: r100(b.result.endNW.p50),
      net_worth_at_end_range_80pct_chf: [r100(b.result.endNW.p10), r100(b.result.endNW.p90)],
      difference_vs_baseline_median_chf: r100(b.result.endNW.p50 - base.result.endNW.p50),
      lowest_cash_median_chf: r100(b.result.minCash.p50),
      chance_cash_goes_below_zero_pct: p(b.result.probNegCash),
      age_when_cash_goes_below_zero: b.result.firstNegMonth != null ? Math.floor(profile.age + b.result.firstNegMonth / 12) : null,
      goals: b.result.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by: g.date.slice(0, 4), chance_pct: p(g.prob!) })),
      key_assumptions: b.plan.assumptions.filter((a) => !a.key.startsWith('g.') || a.source === 'you').slice(0, 8).map(summarize),
      unknown_inputs: b.plan.assumptions.filter((a) => a.source === 'missing').map((a) => a.label),
    })),
    focus_path: focus.name,
    drivers_for_focus_path: drv.slice(0, 3).map((d) => ({ input: d.name, effect_on_end_net_worth_chf: [r100(Math.min(d.low, d.high)), r100(Math.max(d.low, d.high))] })),
    break_even: be ? { path: focus.name, income_change_needed_pct: Math.round(be.pct), from_age: Math.floor(profile.age + be.month / 12), monthly_income_needed_chf: r100(be.incomeNeeded), meaning: be.pct >= 0 ? `${focus.name} catches up with ${base.name} only if income from that age is this % higher than assumed` : `${focus.name} stays ahead of ${base.name} even if income from that age were this % lower than assumed` } : null,
    method: {
      uncertainty: 'Monte Carlo, 500 paths, spending surprises and bonuses learned from 24 months of synthetic ledger data',
      backtest_80pct_band_coverage_pct: p(params.backtest.coverage_80_year_end),
    },
  }
}
export type Facts = ReturnType<typeof buildFacts>

// ---------------------------------------------------------------- verify the LLM's numbers
/** Every number in the text must match a number in the facts (allowing "k"/"M" and rounding). */
export function verifyNumbers(text: string, facts: unknown): { total: number; unmatched: string[] } {
  const known: number[] = []
  const walk = (x: unknown) => {
    if (typeof x === 'number') known.push(x, Math.abs(x))
    else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
    else if (typeof x === 'string') (x.match(/-?\d+(?:\.\d+)?/g) ?? []).forEach((s) => known.push(Math.abs(Number(s))))
  }
  walk(facts)
  const re = /(-?\d[\d'’,]*(?:\.\d+)?)\s*(k|K|M|million|%)?/g
  const unmatched: string[] = []
  let total = 0
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim()
    let v = Math.abs(Number(m[1].replace(/['’,]/g, '')))
    if (!Number.isFinite(v)) continue
    if (m[2] === 'k' || m[2] === 'K') v *= 1000
    if (m[2] === 'M' || m[2] === 'million') v *= 1e6
    if (v <= 12 && !m[2] && Number.isInteger(v)) continue // small counts ("2 years", "3 paths")
    total++
    const tol = (x: number) => Math.max(1, Math.abs(x) * (m[2] ? 0.02 : 0.01))
    if (!known.some((k) => Math.abs(k - v) <= tol(k))) unmatched.push(raw)
  }
  return { total, unmatched }
}

// ---------------------------------------------------------------- offline explanation (no LLM)
export function templateExplanation(f: Facts) {
  const k = (x: number) => `CHF ${Math.round(x / 1000)}k`
  const base = f.paths.find((x) => x.is_baseline)!
  const others = f.paths.filter((x) => !x.is_baseline)
  const lines: string[] = []
  lines.push(`In this simulation, "${base.name}" ends with a median net worth of ${k(base.net_worth_at_end_median_chf)} at age ${f.horizon.age_at_end}.`)
  for (const o of others) {
    const d = o.difference_vs_baseline_median_chf
    lines.push(`"${o.name}" ends at ${k(o.net_worth_at_end_median_chf)}, ${d >= 0 ? k(d) + ' more' : k(-d) + ' less'} than the baseline (80% range ${k(o.net_worth_at_end_range_80pct_chf[0])} to ${k(o.net_worth_at_end_range_80pct_chf[1])}).`)
    if (o.chance_cash_goes_below_zero_pct > 0) lines.push(`Cash goes below zero in ${o.chance_cash_goes_below_zero_pct}% of simulated paths.`)
  }
  if (f.drivers_for_focus_path[0]) lines.push(`For "${f.focus_path}", the input that matters most is ${f.drivers_for_focus_path[0].input.toLowerCase()}.`)
  if (f.break_even) lines.push(`It ends level with the baseline only if income from age ${f.break_even.from_age} changes by ${f.break_even.income_change_needed_pct}%.`)
  const unknown = others.flatMap((o) => o.unknown_inputs)
  return {
    headline: others.length ? `${others.length} path(s) compared with "${base.name}"` : `Baseline: ${base.name}`,
    explanation: lines.join(' '),
    caveat: unknown.length ? `Unknown inputs were set to "no change": ${[...new Set(unknown)].slice(0, 3).join('; ')}.` : 'Fictional data; results depend on the listed assumptions and are not a forecast.',
  }
}
