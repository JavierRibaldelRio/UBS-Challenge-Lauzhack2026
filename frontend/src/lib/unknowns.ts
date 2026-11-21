// "From here on, this path depends on something nobody knows."
// For every UNKNOWN number that actually changes a path (e.g. a degree's salary premium, rent abroad, a moving cost),
// we find the month it starts to matter and re-run the path with that number pushed low and high.
// The chart draws the path dashed from that month, with a hatched "fog" between the low and high runs.
// The low/high values are ILLUSTRATIVE (the data has no range for unknowns), and the UI says so.
import { resolve, type Overrides, type Plan } from './resolve'
import { runPath } from './sim'
import { BASE_MACRO, type Macro } from './macro'
import type { Assumption, Params, Profile, ScenarioSpec } from './types'

export type UnknownImpact = {
  from: number // first month where an unknown matters
  items: { label: string; month: number; lo: number; hi: number; unit: string }[]
  nw: { lo: number; hi: number }[] // deterministic envelope, as offsets from the base run
  cash: { lo: number; hi: number }[]
}

/** Illustrative low/high for an unknown number. */
function probes(a: Assumption, profile: Profile): [number, number] {
  const inc = Math.max(profile.income, 3000)
  if (a.unit.includes('%')) return [a.value - 20, a.value + 20]
  if (a.value !== 0) return [a.value * 0.75, a.value * 1.25] // "kept as today" (e.g. rent abroad)
  if (a.unit.includes('/mo')) return [0, Math.round(0.2 * inc)] // an unknown monthly cost
  if (a.key.endsWith('.amt') && /money in/.test(a.label)) return [-3 * inc, 3 * inc] // one-off: cost or gift
  return [0, 3 * inc] // an unknown one-off cost
}

export function unknownImpact(spec: ScenarioSpec, overrides: Overrides, plan: Plan, profile: Profile, params: Params, H: number, loanRate: number, macro: Macro = BASE_MACRO): UnknownImpact | null {
  const unknown = plan.assumptions.filter((a) => a.source === 'missing')
  if (!unknown.length) return null
  const base = runPath(plan, params, null)
  const end = (o: { nw: Float64Array }) => o.nw[o.nw.length - 1]
  const runs: { nw: Float64Array; cash: Float64Array }[] = []
  const items: UnknownImpact['items'] = []
  for (const a of unknown) {
    const [lo, hi] = probes(a, profile)
    const rLo = runPath(resolve(profile, params, spec, { ...overrides, [a.key]: lo }, H, loanRate, macro), params, null)
    const rHi = runPath(resolve(profile, params, spec, { ...overrides, [a.key]: hi }, H, loanRate, macro), params, null)
    if (Math.abs(end(rLo) - end(base)) < 1 && Math.abs(end(rHi) - end(base)) < 1) continue // doesn't matter
    runs.push(rLo, rHi)
    items.push({ label: a.label, month: a.month ?? 0, lo, hi, unit: a.unit })
  }
  if (!items.length) return null
  const env = (k: 'nw' | 'cash') =>
    Array.from({ length: H }, (_, t) => {
      let lo = 0
      let hi = 0
      for (const r of runs) {
        const d = r[k][t] - base[k][t]
        if (d < lo) lo = d
        if (d > hi) hi = d
      }
      return { lo, hi }
    })
  return { from: Math.min(...items.map((i) => i.month)), items, nw: env('nw'), cash: env('cash') }
}
