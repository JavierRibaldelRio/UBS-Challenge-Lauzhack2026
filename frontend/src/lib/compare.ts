// Comparing two paths (A = green, B = blue), the way UBS's scenario catalog measures every scenario:
// "Liquidity, net worth, goal feasibility, constraint breaches" (pre_docs/Data/scenario-catalog.csv, example_metrics).
//
// Which path "fits your goals better" is COMPUTED here, with the weighting stated openly
// (scenario-modelling.md §13: preference weights "should not be hidden from users"; FAQ: the scenario with the
// most money is not always best). The AI only puts it in words, and the app checks every number it writes.
import type { Verdict } from './answer'
import type { Plan } from './resolve'
import type { SimResult } from './sim'
import { describeSpec } from './resolve'
import type { Profile } from './types'
import { catchUp } from './valuation'

export type Side = { id: string; name: string; spec: import('./types').ScenarioSpec; plan: Plan; result: SimResult; parentName: string | null; madeBy: string; unknownFromAge: number | null }

const r100 = (x: number) => Math.round(x / 100) * 100
const pct = (x: number) => Math.round(x * 100)
const kfmt = (x: number) => (Math.abs(x) >= 1e6 ? `CHF ${(x / 1e6).toFixed(2)}M` : `CHF ${(x / 1000).toFixed(1)}k`)

/** Share of futures where cash ever drops below a floor the person set ("never below 20k"). */
export const belowFloor = (r: SimResult, floor: number | undefined) => {
  if (!floor) return 0
  let n = 0
  for (const m of r.minCashPaths) if (m < floor) n++
  return n / r.minCashPaths.length
}
/** The worst constraint breach of a path: cash below zero (or below the person's own floor), or a down payment it cannot pay. */
export const breach = (r: SimResult, floor?: number) => Math.max(r.probNegCash, belowFloor(r, floor), ...r.homeBuys.map((h) => h.shortShare), 0)

export const FIT_RULE = 'In this order: 1) not running into cash trouble (cash below zero, below your own minimum if you set one, or a down payment you cannot pay), 2) your goals, high-priority goals count double, 3) net worth at the end.'

export type Fit = { pick: 'first' | 'second' | 'even'; decidedBy: 'cash' | 'goals' | 'net worth' | 'none'; reasons: string[] }

/** Lexicographic on purpose: easy to explain, and no hidden weights. */
export function goalFit(a: Side, b: Side, profile: Profile): Fit {
  const ba = breach(a.result, profile.minCash)
  const bb = breach(b.result, profile.minCash)
  const reasons: string[] = []
  // 1) cash trouble: a clear difference decides
  if (Math.abs(ba - bb) >= 0.2 || (Math.max(ba, bb) >= 0.5 && Math.min(ba, bb) < 0.2)) {
    const safer = ba < bb ? a : b
    const other = safer === a ? b : a
    reasons.push(`“${other.name}” runs into cash trouble${profile.minCash ? ` (below zero, below your ${Math.round(profile.minCash).toLocaleString('de-CH')} floor, or a down payment)` : ''} in ${pct(breach(other.result, profile.minCash))}% of simulated futures, “${safer.name}” in ${pct(breach(safer.result, profile.minCash))}%.`)
    return { pick: safer === a ? 'first' : 'second', decidedBy: 'cash', reasons }
  }
  // 2) goals (only goals both paths can be measured on)
  let score = 0
  const prio = new Map(profile.goals.map((g) => [g.name, g.priority === 'high' || g.priority === 'yours' ? 2 : 1]))
  for (const ga of a.result.goals) {
    const gb = b.result.goals.find((g) => g.name === ga.name)
    if (ga.prob == null || gb?.prob == null) continue
    const d = ga.prob - gb.prob
    if (Math.abs(d) < 0.1) continue
    score += (prio.get(ga.name) ?? 1) * d
    reasons.push(`“${ga.name}” (${(prio.get(ga.name) ?? 1) === 2 ? 'high priority' : 'medium priority'}): ${pct(ga.prob)}% with “${a.name}” vs ${pct(gb.prob)}% with “${b.name}”.`)
  }
  if (Math.abs(score) >= 0.15) return { pick: score > 0 ? 'first' : 'second', decidedBy: 'goals', reasons }
  // 3) net worth
  const na = a.result.endNW.p50
  const nb = b.result.endNW.p50
  if (Math.abs(na - nb) > Math.max(5000, 0.03 * Math.max(Math.abs(na), Math.abs(nb)))) {
    reasons.push(`Cash risk and goals are about the same, so net worth decides: “${na > nb ? a.name : b.name}” ends higher.`)
    return { pick: na > nb ? 'first' : 'second', decidedBy: 'net worth', reasons }
  }
  reasons.push('Cash risk, goals and net worth are all close: in this simulation neither path clearly fits better.')
  return { pick: 'even', decidedBy: 'none', reasons }
}

/** One path in plain facts (the only numbers the AI may use about it). */
function describe(s: Side, profile: Profile, H: number) {
  const r = s.result
  const age = (m: number) => Math.floor(profile.age + m / 12)
  const years = H / 12
  const snapAt = [1, 3, 5, 10, 20, 30].filter((y) => y < years).concat(years)
  return {
    name: s.name,
    branches_from: s.parentName,
    made_by: s.madeBy,
    what_it_changes: describeSpec(s.spec, profile.age),
    decisions: [...s.spec.events].sort((x, y) => (x.start_month ?? 0) - (y.start_month ?? 0)).map((e) => ({ at_age: age(e.start_month ?? 0), what: e.label, type: e.type })),
    // pre-formatted on purpose: raw 40900 next to 556700 gets misread as "409k" by the AI; the number check still parses these
    over_time_median: snapAt.map((y) => ({ age: profile.age + y, net_worth: kfmt(r.nw[y * 12 - 1].p50), cash: kfmt(r.cash[y * 12 - 1].p50) })),
    net_worth_at_end_median_chf: r100(r.endNW.p50),
    net_worth_at_end_range_8_in_10_chf: [r100(r.endNW.p10), r100(r.endNW.p90)],
    worth_in_todays_money_at_end_median_chf: r100(r.endNPV.p50),
    worth_in_todays_money_over_time_median: snapAt.map((y) => ({ age: profile.age + y, npv: kfmt(r.npv[y * 12 - 1].p50) })),
    cash_at_end_median_chf: r100(r.endCash.p50),
    lowest_cash_median_chf: r100(r.minCash.p50),
    chance_cash_goes_below_zero_pct: pct(r.probNegCash),
    ...(profile.minCash ? { chance_cash_goes_below_your_floor_pct: pct(belowFloor(r, profile.minCash)) } : {}),
    age_cash_goes_below_zero: r.firstNegMonth != null ? age(r.firstNegMonth) : null,
    ...(r.investCut.share > 0.05 ? { planned_investing_not_affordable: { futures_pct: pct(r.investCut.share), skipped_total_median_chf: r100(r.investCut.p50), why: 'you can only invest money you have (budget constraint)' } } : {}),
    goals: r.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by_year: g.date.slice(0, 4), chance_pct: pct(g.prob!) })),
    home_or_asset_purchases: r.homeBuys.map((h) => ({ what: h.label, age: age(h.month), price_chf: r100(h.price), down_payment_chf: r100(h.down), cash_just_before_median_chf: r100(h.cashBeforeP50), chance_not_enough_own_money_pct: pct(h.shortShare) })),
    depends_on_unknown_numbers: s.plan.assumptions.filter((x) => x.source === 'missing').map((x) => x.label),
    unknowns_matter_from_age: s.unknownFromAge,
    warnings: s.plan.warnings,
  }
}

export function compareFacts(o: { profile: Profile; H: number; first: Side; second: Side | null; verdict: Verdict | null; fit: Fit | null; breakEven: { path: string; pct: number; fromAge: number } | null; economy: unknown; told: string[] }) {
  const { profile: p, H, first, second, verdict: v, fit } = o
  const led = p.ledger_closing_cash
  const winnerName = (f: Fit) => (f.pick === 'first' ? first.name : f.pick === 'second' ? second!.name : null)
  return {
    person: { name: p.name, age_now: p.age, city: p.city, job_status: p.status.replace('_', ' '), household: p.household.replace('_', ' '), fictional: true },
    today: {
      starting_point: `${p.as_of.slice(0, 7)}`,
      cash_chf: Math.round(p.cash),
      investments_chf: Math.round(p.investments),
      debts_chf: Math.round(p.loans.reduce((a, l) => a + l.principal, 0)),
      ...(p.home ? { home_already_owned_chf: Math.round(p.home), net_worth_today_chf: Math.round(p.cash + p.investments + p.home - p.loans.reduce((a, l) => a + l.principal, 0)) } : {}),
      ...(p.minCash ? { your_minimum_cash_floor_chf: Math.round(p.minCash) } : {}),
      net_income_chf_per_month: Math.round(p.income),
      rent_chf_per_month: Math.round(p.rent),
      usual_other_spending_chf_per_month: Math.round(p.calib.other_mu),
      usual_total_spending_with_rent_chf_per_month: Math.round(p.rent + p.calib.other_mu),
      usual_monthly_balance_chf: Math.round(p.income - p.rent - p.calib.other_mu),
      told_the_twin: o.told,
    },
    history_from_the_data: led.length
      ? { period: `${p.as_of.slice(0, 7)} to ${led.length} months later`, real_bank_balance_start_chf: Math.round(p.cash), real_bank_balance_after_chf: Math.round(led[led.length - 1]), lowest_real_balance_chf: Math.round(Math.min(...led)), months_below_zero: led.filter((x) => x < 0).length, months_observed: led.length, source: 'UBS synthetic ledger (observed, not simulated)' }
      : null,
    goals: p.goals.map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by_year: g.date.slice(0, 4), priority: g.priority === 'yours' ? 'high (added in the chat)' : g.priority })),
    horizon: { years: H / 12, age_at_end: p.age + H / 12 },
    units: 'CHF, constant 2025 francs, income after tax',
    economy: o.economy,
    todays_money: {
      discount_rate_pct: Math.round(first.plan.discountRate * 10000) / 100,
      rate_source: first.plan.assumptions.find((a) => a.key === 'v.disc')?.source === 'you' ? 'set by the user' : 'default assumption, the same for every path',
      meaning: "worth in today's money (NPV): every franc in or out discounted to today when it happens + what is owned minus debts at that age, discounted. Shown as an extra measure only; 'fits goals better' uses net worth",
      ...(second
        ? (() => {
            const cu = catchUp(first.result.npv, second.result.npv, p.age)
            return { ends_ahead: cu.ahead === 'tie' ? 'both about level' : cu.ahead === 'a' ? first.name : second.name, ahead_from_age: cu.ahead === 'tie' ? null : (cu.fromAge ?? 'ahead at every year') }
          })()
        : {}),
    },
    paths: [describe(first, p, H), ...(second ? [describe(second, p, H)] : [])],
    comparison: second && v && fit
      ? {
          more_net_worth: v.leader.name,
          net_worth_gap_at_end_median_chf: r100(v.gap),
          futures_where_it_ends_higher_pct: pct(v.pairedShare),
          futures_where_both_end_the_same_pct: pct(v.ties),
          confidence_of_the_net_worth_gap: v.confidence,
          confidence_reasons: v.reasons,
          fits_goals_better: winnerName(fit) ?? 'neither (too close)',
          fits_goals_better_decided_by: fit.decidedBy,
          fits_goals_better_reasons: fit.reasons,
          how_fit_is_judged: FIT_RULE,
          break_even: o.breakEven ? { path: o.breakEven.path, income_change_needed_pct: Math.round(o.breakEven.pct), from_age: o.breakEven.fromAge } : null,
        }
      : null,
  }
}
export type CompareFacts = ReturnType<typeof compareFacts>
export type Story = { so_far: string; ahead: string }
export type CompareResult = { first: Story; second: Story | null; comparison: string; caveat: string }

const k = (x: number) => (Math.abs(x) >= 1e6 ? `CHF ${(x / 1e6).toFixed(2)}M` : `CHF ${Math.round(x / 1000)}k`)

/** one sentence on the rolling-horizon valuation (today's money), from the facts only */
function todaysMoney(f: CompareFacts): string {
  const t = f.todays_money
  if (!('ends_ahead' in t)) return ''
  const rate = `NPV at ${t.discount_rate_pct}% a year`
  if (t.ends_ahead === 'both about level') return ` In today's money (${rate}) both end about level.`
  return t.ahead_from_age === 'ahead at every year' ? ` In today's money (${rate}) “${t.ends_ahead}” is ahead at every year.` : ` In today's money (${rate}) “${t.ends_ahead}” is ahead from age ${t.ahead_from_age}.`
}

/** Offline text (no AI): same facts, plain sentences. Also shown instantly while the AI writes. */
export function templateCompare(f: CompareFacts): CompareResult {
  const story = (x: CompareFacts['paths'][number]): Story => {
    const h = f.history_from_the_data
    const start = h
      ? `In UBS's data your bank balance went from ${k(h.real_bank_balance_start_chf)} to ${k(h.real_bank_balance_after_chf)} over ${h.months_observed} months${h.months_below_zero ? `, and was below zero in ${h.months_below_zero} of them` : ''}.`
      : `You start with ${k(f.today.cash_chf)} in cash.`
    const change = x.decisions.length ? ` This path changes: ${x.what_it_changes}.` : ' On this path nothing changes.'
    const end = { age: x.over_time_median.at(-1)!.age, net_worth_chf: x.net_worth_at_end_median_chf }
    const runs = x.age_cash_goes_below_zero != null ? ` Cash runs out at about ${x.age_cash_goes_below_zero} (in ${x.chance_cash_goes_below_zero_pct}% of futures).` : x.chance_cash_goes_below_zero_pct > 0 ? ` Cash goes below zero in ${x.chance_cash_goes_below_zero_pct}% of futures.` : ' Cash stays above zero.'
    const goals = x.goals.length ? ` Goals: ${x.goals.map((g) => `${g.goal} ${g.chance_pct}%`).join(', ')}.` : ''
    const npv = ` In today's money (NPV at ${f.todays_money.discount_rate_pct}% a year) that is about ${k(x.worth_in_todays_money_at_end_median_chf)}.`
    return { so_far: start + change, ahead: `In this simulation you reach about ${k(end.net_worth_chf)} of net worth at ${end.age}, with ${k(x.cash_at_end_median_chf)} in cash.${npv}${runs}${goals}` }
  }
  const [a, b] = f.paths
  const c = f.comparison
  return {
    first: story(a),
    second: b ? story(b) : null,
    comparison: b && c
      ? `“${c.more_net_worth}” ends with about ${k(c.net_worth_gap_at_end_median_chf)} more net worth (${c.confidence_of_the_net_worth_gap} confidence). Judged on cash safety first, then your goals, then net worth, the better fit in this simulation is: ${c.fits_goals_better}. ${c.fits_goals_better_reasons[0] ?? ''}${todaysMoney(f)}`
      : '',
    caveat: [a, b].flatMap((x) => x?.depends_on_unknown_numbers ?? []).length ? `Some numbers are unknown and set to “no change”: ${[...new Set([a, b].flatMap((x) => x?.depends_on_unknown_numbers ?? []))].slice(0, 3).join('; ')}.` : 'Fictional data; results depend on the assumptions shown and are not a forecast.',
  }
}
