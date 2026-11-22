// Answering the user's QUESTION (separate from the general explanation).
// The verdict and its confidence are COMPUTED here, from the simulation and the data. The AI only puts them in words.
//
// Confidence combines three independent checks (see DEV_NOTES §5b):
//   1. Luck      : in how many of the 500 paired futures does the leading path end higher? (same random months for both)
//                  -> this part is validated by the backtest calibration curve (backtest.json: said 80% -> ~78% happened).
//   2. Data range: does the result still hold if the person is at the unlucky end of their peers in the data
//                  (salary at the 10th percentile, rent at the 90th) and the other path at the lucky end?
//   3. Unknowns  : does the result depend on a number nobody knows (e.g. a degree's salary premium)?
//                  If so, how far would that unknown have to move to flip the result (break-even)?
import { breakEven } from './analysis'
import { resolve, type Overrides, type Plan } from './resolve'
import { runPath, type SimResult } from './sim'
import { BASE_MACRO, type Macro } from './macro'
import type { Params, Profile, ScenarioSpec } from './types'

export type Confidence = 'high' | 'medium' | 'low'
export type ComparedPath = { id: string; name: string; spec: ScenarioSpec; overrides: Overrides; plan: Plan; result: SimResult }

export type QuestionKind = 'compare' | 'goal' | 'afford'
export type Verdict = {
  question: string
  kind: QuestionKind
  /** goal / afford questions: the probability that answers them (share of 500 futures) */
  probability: { what: string; p: number } | null
  ties: number // share of futures where both paths end (practically) the same
  leader: ComparedPath
  other: ComparedPath
  gap: number // median end net worth, leader - other
  pairedShare: number // share of paired futures where the leader ends higher
  peerTest: { holds: boolean; leaderLow: number; otherHigh: number; tested: string[] } | null
  unknowns: string[]
  flip: { pct: number; fromAge: number } | null // income change the trailing path would need to catch up
  confidence: Confidence
  reasons: string[]
}

const endOf = (plan: Plan, params: Params) => {
  const o = runPath(plan, params, null)
  return o.nw[o.nw.length - 1]
}

/** Re-resolve a path with every data-based number pushed to the bad (or good) end of the peer range. */
function atPeerEdge(p: ComparedPath, profile: Profile, params: Params, H: number, loanRate: number, edge: 'bad' | 'good', macro: Macro) {
  const o: Overrides = { ...p.overrides }
  const tested: string[] = []
  for (const a of p.plan.assumptions) {
    if (!a.range) continue
    const badIsLow = a.range.good === 'higher'
    o[a.key] = (edge === 'bad') === badIsLow ? a.range.lo : a.range.hi
    tested.push(a.label)
  }
  return { plan: resolve(profile, params, p.spec, o, H, loanRate, macro), tested }
}

export function verdict(question: string, a: ComparedPath, b: ComparedPath, profile: Profile, params: Params, H: number, loanRate: number, macro: Macro = BASE_MACRO): Verdict {
  const [leader, other] = a.result.endNW.p50 >= b.result.endNW.p50 ? [a, b] : [b, a]
  const gap = leader.result.endNW.p50 - other.result.endNW.p50

  // 1. luck: paired futures (identical random months for both paths)
  const L = leader.result.endNWPaths
  const O = other.result.endNWPaths
  const tol = Math.max(1000, 0.002 * Math.abs(leader.result.endNW.p50)) // differences below this are "the same"
  let wins = 0
  let same = 0
  for (let i = 0; i < L.length; i++) {
    if (Math.abs(L[i] - O[i]) <= tol) same++
    else if (L[i] > O[i]) wins++
  }
  const pairedShare = wins / L.length
  const ties = same / L.length

  // what kind of question is it? (goal / afford questions are answered by a probability, not by a ranking)
  const q = question.toLowerCase()
  const newPath = a // the path the question created (a is always the asked path)
  const goal = profile.goals.find((g) => q.includes(g.name.toLowerCase())) ?? (/\bgoal\b|\bziel\b|\bobjectif\b/.test(q) ? profile.goals[0] : undefined)
  const kind: QuestionKind = goal ? 'goal' : /afford|run out|enough money|go broke|leisten|assez d'argent/.test(q) ? 'afford' : 'compare'
  const gRes = goal ? newPath.result.goals.find((g) => g.name === goal.name) : undefined
  const probability =
    kind === 'goal' && gRes?.prob != null
      ? { what: `reaching “${goal!.name}” (CHF ${Math.round(goal!.target).toLocaleString('de-CH')} by ${goal!.date.slice(0, 4)}) with “${newPath.name}”`, p: gRes.prob }
      : kind === 'afford'
        ? newPath.result.homeBuys.length
          ? { what: `having enough cash for the down payment AND never going below zero with “${newPath.name}”`, p: Math.min(1 - newPath.result.probNegCash, ...newPath.result.homeBuys.map((h) => 1 - h.shortShare)) }
          : { what: `cash staying above zero the whole time with “${newPath.name}”`, p: 1 - newPath.result.probNegCash }
        : null

  // 2. data range: leader at the unlucky end of its peers, other at the lucky end
  const lBad = atPeerEdge(leader, profile, params, H, loanRate, 'bad', macro)
  const oGood = atPeerEdge(other, profile, params, H, loanRate, 'good', macro)
  const tested = [...new Set([...lBad.tested, ...oGood.tested])]
  const peerTest = tested.length
    ? { holds: endOf(lBad.plan, params) > endOf(oGood.plan, params), leaderLow: endOf(lBad.plan, params), otherHigh: endOf(oGood.plan, params), tested }
    : null

  // 3. unknowns that actually change the result (an unknown overridden by another event does not count)
  const base = endOf(leader.plan, params) - endOf(other.plan, params)
  const unknowns: string[] = []
  for (const p of [leader, other]) {
    for (const x of p.plan.assumptions.filter((y) => y.source === 'missing')) {
      const probe = x.unit.includes('%') ? x.value + 20 : x.value === 0 ? 1000 : x.value * 1.2
      const moved = resolve(profile, params, p.spec, { ...p.overrides, [x.key]: probe }, H, loanRate, macro)
      const diff = p === leader ? endOf(moved, params) - endOf(other.plan, params) : endOf(leader.plan, params) - endOf(moved, params)
      if (Math.abs(diff - base) > 1 && !unknowns.includes(x.label)) unknowns.push(x.label)
    }
  }
  const be = breakEven(other.plan, leader.plan, params)
  const flip = be ? { pct: be.pct, fromAge: Math.floor(profile.age + be.month / 12) } : null
  const unknownsMatter = unknowns.length > 0 && (!flip || Math.abs(flip.pct) < 50)

  const pct = (x: number) => `${Math.round(x * 100)}%`
  let confidence: Confidence
  const reasons: string[] = []
  if (probability) {
    // a yes/no question: clear if the probability is far from a coin flip (backtest: our probabilities are calibrated)
    const p = probability.p
    const clear = p <= 0.05 || p >= 0.95
    confidence = clear && !unknownsMatter ? 'high' : clear || p <= 0.2 || p >= 0.8 ? 'medium' : 'low'
    reasons.push(`The chance of ${probability.what} is ${pct(p)} of 500 simulated futures${clear ? ', so the answer is clear-cut' : p > 0.2 && p < 0.8 ? ', close to a coin flip' : ''}.`)
  } else if (ties >= 0.95) {
    confidence = unknownsMatter ? 'medium' : 'high'
    reasons.push(`In ${pct(ties)} of 500 simulated futures both paths end practically the same (within CHF ${Math.round(tol).toLocaleString('de-CH')}).`)
  } else {
    if (pairedShare >= 0.95 && (peerTest?.holds ?? true) && !unknownsMatter) confidence = 'high'
    else if (pairedShare >= 0.8 && ((peerTest?.holds ?? true) || (flip != null && Math.abs(flip.pct) >= 20))) confidence = 'medium'
    else confidence = 'low'
    reasons.push(
      pairedShare >= 0.995
        ? `In all 500 simulated futures (same luck for both), “${leader.name}” ends higher.`
        : `In ${pct(pairedShare)} of 500 simulated futures (same luck for both), “${leader.name}” ends higher${ties > 0.05 ? ` (${pct(ties)} end the same)` : ''}.`,
    )
  }
  if (peerTest && !probability && ties < 0.95)
    reasons.push(
      peerTest.holds
        ? `It still ends higher if its data-based numbers are at the unlucky end of real peers and the other path's at the lucky end.`
        : `It does NOT always end higher: with numbers at the unlucky end of real peers (and the other path at the lucky end), the order flips.`,
    )
  if (unknowns.length)
    reasons.push(
      flip && flip.pct > 0
        ? `It depends on unknown numbers (${unknowns.join('; ')}). “${other.name}” would catch up if its income from age ${flip.fromAge} were ${Math.round(flip.pct)}% higher.`
        : `It depends on unknown numbers (${unknowns.join('; ')}), which are set to “no change”.`,
    )
  else if (flip && flip.pct > 0) reasons.push(`“${other.name}” would need ${Math.round(flip.pct)}% more income from age ${flip.fromAge} to catch up.`)
  return { question, kind, probability, ties, leader, other, gap, pairedShare, peerTest, unknowns, flip, confidence, reasons }
}

/** The only things the answer-AI may talk about. */
export function answerFacts(v: Verdict, profile: Profile, params: Params, H: number) {
  const r100 = (x: number) => Math.round(x / 100) * 100
  const describe = (p: ComparedPath) => ({
    name: p.name,
    net_worth_at_end_median_chf: r100(p.result.endNW.p50),
    range_8_in_10_chf: [r100(p.result.endNW.p10), r100(p.result.endNW.p90)],
    chance_cash_below_zero_pct: Math.round(p.result.probNegCash * 100),
    age_cash_first_below_zero: p.result.firstNegMonth != null ? Math.floor(profile.age + p.result.firstNegMonth / 12) : null,
    goals: p.result.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by_year: g.date.slice(0, 4), chance_pct: Math.round(g.prob! * 100) })),
    home_purchases: p.result.homeBuys.map((h) => ({ age: Math.floor(profile.age + h.month / 12), down_payment_chf: r100(h.down), cash_just_before_median_chf: r100(h.cashBeforeP50), chance_not_enough_cash_for_down_payment_pct: Math.round(h.shortShare * 100) })),
    warnings: p.plan.warnings,
  })
  const cal80 = params.backtest.calibration_central?.find((c) => c.said === 80)
  return {
    question: v.question,
    question_type: v.kind === 'goal' ? 'can a goal be reached? answer yes/no with the chance' : v.kind === 'afford' ? 'can it be afforded? answer with the chance that cash stays above zero' : 'which path ends higher?',
    key_probability: v.probability ? { what: v.probability.what, chance_pct: Math.round(v.probability.p * 100) } : null,
    futures_where_both_end_the_same_pct: Math.round(v.ties * 100),
    person: { name: profile.name, age_now: profile.age, fictional: true },
    horizon: { years: H / 12, age_at_end: profile.age + H / 12 },
    leading_path: describe(v.leader),
    other_path: describe(v.other),
    gap_at_end_median_chf: r100(v.gap),
    confidence: v.confidence,
    confidence_reasons: v.reasons,
    futures_where_leader_ends_higher_pct: Math.round(v.pairedShare * 100),
    unknown_inputs: v.unknowns,
    catch_up: v.flip && v.flip.pct > 0 ? { path: v.other.name, income_increase_needed_pct: Math.round(v.flip.pct), from_age: v.flip.fromAge } : null,
    evidence_for_the_percentages: cal80 ? `backtest on 1,200 people: when the model said 80%, ${Math.round(cal80.real * 1000) / 10}% happened` : null,
  }
}
export type AnswerFacts = ReturnType<typeof answerFacts>

/** Offline answer (no AI): same facts, fixed sentences. */
export function templateAnswer(f: AnswerFacts) {
  const k = (x: number) => `CHF ${Math.round(x / 1000)}k`
  return {
    short_answer: `In this simulation, “${f.leading_path.name}” ends higher at age ${f.horizon.age_at_end}: about ${k(f.leading_path.net_worth_at_end_median_chf)} vs ${k(f.other_path.net_worth_at_end_median_chf)} for “${f.other_path.name}”.`,
    reasoning: [
      f.other_path.chance_cash_below_zero_pct > 0 ? `“${f.other_path.name}” runs short of cash in ${f.other_path.chance_cash_below_zero_pct}% of futures.` : '',
      f.leading_path.chance_cash_below_zero_pct > 0 ? `“${f.leading_path.name}” runs short of cash in ${f.leading_path.chance_cash_below_zero_pct}% of futures.` : '',
      f.catch_up ? `“${f.catch_up.path}” would catch up with ${f.catch_up.income_increase_needed_pct}% more income from age ${f.catch_up.from_age}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    confidence_level: f.confidence,
    confidence_sentence: `Confidence: ${f.confidence}. ${f.confidence_reasons[0]}`,
  }
}
