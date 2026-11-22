// "Does this actually take effect?" Checked by the ENGINE after every chat turn, never by the AI.
// The AI writes its reply before anything is simulated, so it cannot know. These notices are deterministic,
// formal, and always say how the scenario could be made possible (UBS: show constraint breaches, never hide them).
import { belowFloor } from './compare'
import { chf } from './fmt'
import type { Plan } from './resolve'
import { NO_KNOBS, runPath, type SimResult } from './sim'
import type { Params, Profile, ScenarioSpec } from './types'

export type Issue = { level: 'blocked' | 'risk'; text: string }

export function effectIssues(name: string, spec: ScenarioSpec, plan: Plan, r: SimResult, profile: Profile): Issue[] {
  const out: Issue[] = []
  const age = (m: number) => Math.floor(profile.age + m / 12)
  for (const e of spec.events) {
    if ((e.type === 'buy_home' || e.type === 'buy_asset') && !(e.amount_chf && e.amount_chf > 0))
      out.push({ level: 'blocked', text: `“${e.label}” in ${name} has no price, so it changes nothing. To make it count: give a price (e.g. “the flat costs 500k”).` })
  }
  for (const w of plan.warnings) if (!/no effect until you set a price/.test(w)) out.push({ level: 'blocked', text: `${name}: ${w}` })
  if (r.investCut.share > 0.05)
    out.push({ level: 'blocked', text: `In ${name}, the planned investing cannot happen in ${Math.round(r.investCut.share * 100)}% of futures (about ${chf(r.investCut.p50)} skipped in total): the cash is not there, and you can only invest money you have. To make it possible: invest less, earn more, spend less, or start with more savings.` })
  for (const h of r.homeBuys)
    if (h.shortShare >= 0.05)
      out.push({ level: h.shortShare >= 0.5 ? 'blocked' : 'risk', text: `In ${name}, the ${chf(h.down)} own money for “${h.label}” at ${age(h.month)} is missing in ${Math.round(h.shortShare * 100)}% of futures (typical cash just before: ${chf(h.cashBeforeP50)}). A bank would not lend. To make it possible: a smaller share of own money (a mortgage), a cheaper ${h.kind === 'home' ? 'home' : 'item'}, buying later, or more income / savings.` })
  if (r.probNegCash >= 0.5 && r.firstNegMonth != null)
    out.push({ level: 'risk', text: `In ${name}, cash runs out at about ${age(r.firstNegMonth)} in ${Math.round(r.probNegCash * 100)}% of futures: as it stands this is a funding gap, not a plan. To make it possible: more income, lower costs, or more savings at the start.` })
  if (profile.minCash && belowFloor(r, profile.minCash) >= 0.05)
    out.push({ level: 'risk', text: `In ${name}, cash drops below your ${chf(profile.minCash)} floor in ${Math.round(belowFloor(r, profile.minCash) * 100)}% of futures.` })
  return out
}

/**
 * Goal-seeking (UBS ai-and-technology §30, scenario-modelling §13): the smallest change of income, in every month,
 * for which cash never goes below zero (or below the person's floor) on this path. Deterministic (expected values).
 * null = already fine at today's income; Infinity = not reachable even with 5x the income.
 */
export function incomeNeeded(plan: Plan, params: Params, floor = 0): { pct: number; monthlyNow: number } | null {
  const ok = (scale: number) => {
    const o = runPath(plan, params, null, { ...NO_KNOBS, income: scale })
    let mn = Infinity
    for (const c of o.cash) if (c < mn) mn = c
    return mn >= floor && o.investCut === 0
  }
  if (ok(1)) return null
  if (!ok(5)) return { pct: Infinity, monthlyNow: Infinity }
  let lo = 1
  let hi = 5
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return { pct: Math.ceil((hi - 1) * 100), monthlyNow: Math.ceil((plan.income[0] * hi) / 10) * 10 }
}
