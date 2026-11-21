// Validation tests mirroring pre_docs/evaluation/technical-validation.md. Run: pnpm test
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { breakEven, drivers, verifyNumbers } from '../lib/analysis'
import { makeEvent, medianLoanRate, presets, resolve } from '../lib/resolve'
import { checks, runPath, simulate } from '../lib/sim'
import { offlineParse } from '../lib/fallback'
import { verdict } from '../lib/answer'
import { suggestQuestions } from '../lib/suggest'
import { BASE_MACRO, MACRO_PRESETS } from '../lib/macro'
import type { Params, Profile, ScenarioSpec, TwinEvent } from '../lib/types'

const params: Params = JSON.parse(readFileSync('src/model/params.json', 'utf8'))
const profiles: Profile[] = JSON.parse(readFileSync('src/model/profiles.json', 'utf8'))
const alexia = profiles.find((p) => p.id === 'P00001')!
const rate = medianLoanRate(profiles)
const plan = (p: Profile, spec: ScenarioSpec, o = {}, H = 120) => resolve(p, params, spec, o, H, rate)
const quo: ScenarioSpec = { name: 'Status quo', catalog_id: null, events: [] }
const endNW = (pl: ReturnType<typeof plan>) => runPath(pl, params, null).nw.at(-1)!

describe('accounting identities', () => {
  for (const p of [alexia, profiles.find((x) => x.loans.length > 0)!, profiles.find((x) => x.investments > 100000)!]) {
    for (const pr of presets(p, params)) {
      it(`${p.id} ${pr.label}: all checks pass`, () => {
        for (const c of checks(plan(p, pr.spec), params, p)) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
      })
    }
  }
})

describe('model vs observed ledger (in-sample sanity)', () => {
  it('Alexia status quo: real 24-month ledger lies mostly inside the 80% band', () => {
    const r = simulate(plan(alexia, quo, {}, 24), params, alexia)
    const inside = alexia.ledger_closing_cash.filter((v, t) => v >= r.cash[t].p10 && v <= r.cash[t].p90).length
    expect(inside).toBeGreaterThanOrEqual(16)
  })
})

describe('scenario logic', () => {
  it('higher tuition never increases end net worth', () => {
    const lo = plan(alexia, { name: 'm', catalog_id: null, events: [makeEvent({ type: 'study', label: 'm', annual_tuition_chf: 1000 })] })
    const hi = plan(alexia, { name: 'm', catalog_id: null, events: [makeEvent({ type: 'study', label: 'm', annual_tuition_chf: 20000 })] })
    expect(endNW(hi)).toBeLessThan(endNW(lo))
  })
  it('zero income: cash falls, flagged negative', () => {
    const z = plan(alexia, { name: 'z', catalog_id: null, events: [makeEvent({ type: 'income_change', label: 'z', income_change_pct: -100 })] })
    expect(simulate(z, params, alexia, 100).probNegCash).toBe(1)
  })
  it('investing moves cash to investments without changing net worth (0% return)', () => {
    const inv = plan(alexia, { name: 'i', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 500 })] })
    expect(Math.abs(endNW(inv) - endNW(plan(alexia, quo)))).toBeLessThan(1e-6)
  })
  it('loan repaid: debt never negative, interest costs money', () => {
    const l = plan(alexia, { name: 'l', catalog_id: null, events: [makeEvent({ type: 'take_loan', label: 'l', amount_chf: 10000, duration_months: 24 })] })
    expect(endNW(l)).toBeLessThan(endNW(plan(alexia, quo)))
  })
  it('buying a home: net worth unchanged at purchase, cash drops by the down payment, rent stops, checks pass', () => {
    const home = plan(alexia, { name: 'h', catalog_id: null, events: [makeEvent({ type: 'buy_home', label: 'h', start_month: 12, amount_chf: 500000 })] }, { 'g.cash': 200000 })
    const none = plan(alexia, quo, { 'g.cash': 200000 })
    const a = runPath(home, params, null)
    const b = runPath(none, params, null)
    // cash drops by ~the 100k down payment; net worth only by the small monthly differences (rent saved, upkeep, interest)
    expect(Math.abs(a.cash[12] - a.cash[11] - (b.cash[12] - b.cash[11]) + 100000)).toBeLessThan(2000)
    expect(Math.abs(a.nw[12] - a.nw[11] - (b.nw[12] - b.nw[11]))).toBeLessThan(2000)
    expect(home.rent[12]).toBe(0)
    for (const c of checks(home, params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('down payment check: a broke student cannot pay it, a worker can', () => {
    const flat = (events: TwinEvent[]) => simulate(plan(alexia, { name: 'h', catalog_id: null, events }), params, alexia)
    const broke = flat([makeEvent({ type: 'buy_home', label: 'h', start_month: 60, amount_chf: 300000 })])
    expect(broke.homeBuys[0].down).toBe(60000)
    expect(broke.homeBuys[0].shortShare).toBe(1)
    const worker = flat([makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_home', label: 'h', start_month: 96, amount_chf: 600000 })])
    expect(worker.homeBuys[0].shortShare).toBe(0)
    // cash drops by ~the down payment that month, net worth does not
    expect(worker.cash[95].p50 - worker.cash[96].p50).toBeGreaterThan(100000)
    expect(Math.abs(worker.nw[96].p50 - worker.nw[95].p50)).toBeLessThan(10000)
  })
  it('"Can I afford a flat" is NO when the down payment is missing', () => {
    const cp2 = (spec: ScenarioSpec) => { const pl = plan(alexia, spec); return { id: spec.name, name: spec.name, spec, overrides: {}, plan: pl, result: simulate(pl, params, alexia) } }
    const v = verdict('Can I afford a flat for 300k at 25?', cp2({ name: 'Flat', catalog_id: null, events: [makeEvent({ type: 'buy_home', label: 'h', start_month: 60, amount_chf: 300000 })] }), cp2(quo), alexia, params, 120, rate)
    expect(v.kind).toBe('afford')
    expect(v.probability!.p).toBe(0)
  })
  it('buying a car: cash −price, assets +price, then the car loses value; checks pass in every economy', () => {
    const car = { name: 'c', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_asset', label: 'Car', start_month: 12, amount_chf: 30000, monthly_amount_chf: 300 })] }
    const pl = plan(alexia, car)
    const a = runPath(pl, params, null), b = runPath(plan(alexia, presets(alexia, params).find((p) => p.id === 'work')!.spec), params, null)
    expect(Math.round((b.cash[12] - a.cash[12]) / 1000)).toBe(30) // ~30k cash out (+ one month of running costs)
    expect(a.home[12]).toBe(30000)
    expect(a.home[24]).toBeCloseTo(30000 * 0.85, 0) // −15%/yr
    for (const m of MACRO_PRESETS) for (const c of checks(resolve(alexia, params, car, {}, 120, rate, m), params, alexia)) expect(c.ok, `${m.id}: ${c.name}`).toBe(true)
  })
  it('a financed car: the loan is debt, paid back over time', () => {
    const car = { name: 'c', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_asset', label: 'Car', start_month: 0, amount_chf: 40000, down_payment_pct: 25 })] }
    const o = runPath(plan(alexia, car), params, null)
    expect(Math.round(o.debt[0])).toBeGreaterThan(29000)
    expect(o.debt[60]).toBe(0)
  })
  it('home + housing downturn: net worth check still exact (value change without cash)', () => {
    const flat = { name: 'f', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_home', label: 'h', start_month: 12, amount_chf: 500000 })] }
    for (const c of checks(resolve(alexia, params, flat, {}, 120, rate, MACRO_PRESETS.find((m) => m.id === 'housing')!), params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('mortgage: the part above 2/3 of the price is paid off over 15 years (debt slopes down, then stays)', () => {
    const flat = { name: 'f', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_home', label: 'h', start_month: 12, amount_chf: 1000000 })] }
    const o = runPath(plan(alexia, flat, {}, 240), params, null)
    expect(Math.round(o.debt[12])).toBeLessThan(800000)
    expect(Math.round(o.debt[12])).toBeGreaterThan(799000)
    expect(o.debt[100]).toBeLessThan(o.debt[50])
    expect(Math.round(o.debt[200])).toBe(666667) // 2/3 of the price left, interest-only from then on
  })
  it('buying a home without a price does nothing and warns', () => {
    const h = plan(alexia, { name: 'h', catalog_id: null, events: [makeEvent({ type: 'buy_home', label: 'h' })] })
    expect(h.warnings.length).toBe(1)
    expect(endNW(h)).toBeCloseTo(endNW(plan(alexia, quo)), 6)
  })
  it('presets fit the person (no "start working" for a retiree)', () => {
    const retired = profiles.find((p) => p.status === 'retired')!
    expect(presets(retired, params).map((p) => p.id)).not.toContain('work')
    expect(presets(retired, params).map((p) => p.id)).not.toContain('master')
  })
  it('offline parser understands a combined sentence', () => {
    const r = offlineParse('work now, lose my job for 6 months, then buy a flat for 600k', alexia, Object.keys(params.anchors.rent_by_city))
    const types = r.scenarios.flatMap((s) => s.events.map((e) => e.type))
    expect(types).toEqual(expect.arrayContaining(['start_job', 'income_change', 'buy_home']))
  })
  it('user override wins and is tagged "you"', () => {
    const p2 = plan(alexia, presets(alexia, params)[0].spec, { 'e0.income': 5000 })
    const a = p2.assumptions.find((a) => a.key === 'e0.income')!
    expect(a.value).toBe(5000)
    expect(a.source).toBe('you')
  })
  it('break-even makes the master end level with working', () => {
    const work = plan(alexia, presets(alexia, params).find((x) => x.id === 'work')!.spec)
    const master = plan(alexia, presets(alexia, params).find((x) => x.id === 'master')!.spec)
    const be = breakEven(master, work, params)!
    expect(be).not.toBeNull()
    expect(be.pct).toBeGreaterThan(0)
  })
  it('reproducible with fixed seed', () => {
    const a = simulate(plan(alexia, quo), params, alexia, 100)
    const b = simulate(plan(alexia, quo), params, alexia, 100)
    expect(a.endNW).toEqual(b.endNW)
  })
})

describe('answer confidence (computed, not AI)', () => {
  const cp = (p: Profile, spec: ScenarioSpec, o = {}) => {
    const pl = plan(p, spec, o)
    return { id: spec.name, name: spec.name, spec, overrides: o, plan: pl, result: simulate(pl, params, p) }
  }
  const ps = presets(alexia, params)
  const work = ps.find((p) => p.id === 'work')!.spec
  const master = ps.find((p) => p.id === 'master')!.spec
  it('clear-cut comparison (work vs doing nothing) is HIGH', () => {
    const v = verdict('q', cp(alexia, work), cp(alexia, quo), alexia, params, 120, rate)
    expect(v.leader.name).toBe('Start working')
    expect(v.pairedShare).toBe(1)
    expect(v.confidence).toBe('high')
  })
  it('master vs work depends on an unknown premium and peer salaries -> not HIGH', () => {
    const v = verdict('q', cp(alexia, master), cp(alexia, work), alexia, params, 120, rate)
    expect(v.leader.name).toBe('Start working')
    expect(v.unknowns.length).toBeGreaterThan(0)
    expect(v.confidence).not.toBe('high')
    expect(v.flip!.pct).toBeGreaterThan(20)
  })
  it('a near tie is LOW (premium set exactly at break-even)', () => {
    const v = verdict('q', cp(alexia, master, { 'e0.premium': 23.6 }), cp(alexia, work), alexia, params, 120, rate)
    expect(v.pairedShare).toBeGreaterThan(0.05)
    expect(v.pairedShare).toBeLessThan(0.95)
    expect(v.confidence).toBe('low')
  })
  it('goal question: answered by the goal probability (0% -> clear-cut "no" -> high)', () => {
    const inv = { name: 'Invest 100', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 100 })] }
    const v = verdict('Can I reach my emergency savings goal by 2029 if I invest 100 a month?', cp(alexia, inv), cp(alexia, quo), alexia, params, 120, rate)
    expect(v.kind).toBe('goal')
    expect(v.probability!.p).toBe(0)
    expect(v.confidence).toBe('high')
  })
  it('investing at 0% return vs nothing: counted as a tie, not as "30% ends higher"', () => {
    const inv = { name: 'Invest 100', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 100 })] }
    const v = verdict('What if I invest 100 a month?', cp(alexia, inv), cp(alexia, quo), alexia, params, 120, rate)
    expect(v.ties).toBe(1)
    expect(v.reasons[0]).toMatch(/practically the same/)
  })
  it('afford question: answered by the chance that cash stays above zero', () => {
    const v = verdict('Can I afford to start working now?', cp(alexia, work), cp(alexia, quo), alexia, params, 120, rate)
    expect(v.kind).toBe('afford')
    expect(v.probability!.p).toBe(1)
  })
  it('identical paths -> nobody "ends higher"', () => {
    const v = verdict('q', cp(alexia, work), cp(alexia, work), alexia, params, 120, rate)
    expect(v.pairedShare).toBe(0)
  })
})

describe('suggested questions fit the person', () => {
  it('no "start working" or master for retirees; student gets study/work questions', () => {
    const retired = profiles.find((p) => p.status === 'retired')!
    for (const q of suggestQuestions(retired, params)) expect(q.toLowerCase()).not.toMatch(/master|start working/)
    expect(suggestQuestions(alexia, params).join(' ')).toMatch(/Master's/)
  })
  it('every profile gets 1-3 suggestions', () => {
    for (const p of profiles) {
      const s = suggestQuestions(p, params)
      expect(s.length).toBeGreaterThan(0)
      expect(s.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('economy (macroeconomic) vs personal (idiosyncratic) variables', () => {
  const eco = (id: string) => MACRO_PRESETS.find((m) => m.id === id)!
  const workSpec = presets(alexia, params).find((p) => p.id === 'work')!.spec
  const run = (spec: ScenarioSpec, m = BASE_MACRO) => simulate(resolve(alexia, params, spec, {}, 120, rate, m), params, alexia)
  it("today's economy changes nothing (same results as before the economy existed)", () => {
    expect(run(workSpec).endNW).toEqual(simulate(plan(alexia, workSpec), params, alexia).endNW)
  })
  it('high inflation (prices beat pay) lowers the result; a rate hike makes a mortgage cost more', () => {
    expect(run(workSpec, eco('inflation')).endNW.p50).toBeLessThan(run(workSpec).endNW.p50)
    const flat = { name: 'f', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_home', label: 'h', start_month: 60, amount_chf: 500000 })] }
    expect(run(flat, eco('rates')).endNW.p50).toBeLessThan(run(flat).endNW.p50)
  })
  it('a recession cuts pay only for people who work, in the recession months', () => {
    const p = resolve(alexia, params, workSpec, {}, 120, rate, eco('recession'))
    expect(p.income[30]).toBeCloseTo(p.income[10] * 0.85, 6)
    const quoPlan = resolve(alexia, params, quo, {}, 120, rate, eco('recession'))
    expect(quoPlan.income[30]).toBe(alexia.income) // a student is not hit
  })
  it('a housing downturn lowers net worth but not cash', () => {
    const flat = { name: 'f', catalog_id: null, events: [makeEvent({ type: 'start_job', label: 'j' }), makeEvent({ type: 'buy_home', label: 'h', start_month: 12, amount_chf: 500000 })] }
    const a = run(flat), b = run(flat, eco('housing'))
    expect(b.endNW.p50).toBeLessThan(a.endNW.p50 - 90000)
    expect(Math.abs(b.endCash.p50 - a.endCash.p50)).toBeLessThan(1)
  })
  it('uncertain economy: random recessions are shared by all paths in the same future, and widen the range', () => {
    const u = eco('uncertain')
    const a = run(workSpec, u)
    const base = run(workSpec)
    expect(a.endNW.p90 - a.endNW.p10).toBeGreaterThan(base.endNW.p90 - base.endNW.p10)
    // same seed + same economy -> reproducible
    expect(run(workSpec, u).endNW).toEqual(a.endNW)
  })
  it('all accounting checks still pass in every economy', () => {
    for (const m of MACRO_PRESETS) for (const c of checks(resolve(alexia, params, workSpec, {}, 120, rate, m), params, alexia)) expect(c.ok, `${m.id}: ${c.name}`).toBe(true)
  })
})

describe('LLM number verifier', () => {
  const facts = { a: 254300, b: 35, c: [12000, 18000] }
  it('accepts numbers present in facts (incl. k)', () => expect(verifyNumbers('CHF 254k, 35% chance, 12,000 to 18’000', facts).unmatched).toEqual([]))
  it('flags invented numbers', () => expect(verifyNumbers('a 42% chance', facts).unmatched).toEqual(['42%']))
  it('understands French / Swiss number formats', () => {
    expect(verifyNumbers('environ CHF 254 300, soit 254\u202f300 ou 254’300', facts).unmatched).toEqual([])
    expect(verifyNumbers('un écart de 12 000 CHF', facts).unmatched).toEqual([])
  })
  it('a word starting with k/M after a number is not a unit ("at 28 keeps")', () => {
    expect(verifyNumbers('buying the flat at 28 keeps cash above zero, CHF 254k', { age: 28, a: 254300 }).unmatched).toEqual([])
    expect(verifyNumbers('35% and 254 k', facts).unmatched).toEqual([])
  })
  it('numbers the user typed in the question count as known', () => {
    expect(verifyNumbers('your 50k inheritance', { question: 'I inherit 50k at 27' }).unmatched).toEqual([])
  })
})

it('prints Alexia summary', () => {
  for (const pr of [{ label: 'Status quo', spec: quo }, ...presets(alexia, params)]) {
    const pl = plan(alexia, pr.spec)
    const r = simulate(pl, params, alexia)
    console.log(pr.label.padEnd(22), 'endNW p10/p50/p90', [r.endNW.p10, r.endNW.p50, r.endNW.p90].map(Math.round), 'P(neg)', r.probNegCash.toFixed(2), 'goals', r.goals.map((g) => g.prob))
  }
  const work = plan(alexia, presets(alexia, params)[0].spec)
  console.log('drivers(work)', drivers(work, params).map((d) => [d.name, Math.round(d.low), Math.round(d.high)]))
  console.log('break-even master', breakEven(plan(alexia, presets(alexia, params)[1].spec), work, params))
})

// ---------------------------------------------------------------- the scenario tree + the A/B comparison
import { inferParent, layoutTree, withParentEvents, NODE_H } from '../lib/tree'
import { compareFacts, goalFit, templateCompare, type Side } from '../lib/compare'

describe('scenario tree', () => {
  const job = makeEvent({ type: 'start_job', label: 'Job' })
  const flat = makeEvent({ type: 'buy_home', label: 'Flat', amount_chf: 300000, start_month: 96 })
  const kid = makeEvent({ type: 'household_change', label: 'Kid', household_type: 'family', start_month: 72 })
  const spec = (name: string, events: TwinEvent[]): ScenarioSpec => ({ name, catalog_id: null, events })
  it('a new path hangs under the path whose decisions it contains (the most of them)', () => {
    const nodes = [{ id: 'w', spec: spec('work', [job]) }, { id: 'wf', spec: spec('work+flat', [job, flat]) }]
    expect(inferParent(spec('x', [job, flat, kid]), nodes, 'today')).toBe('wf')
    expect(inferParent(spec('x', [job, kid]), nodes, 'today')).toBe('w')
    expect(inferParent(spec('x', [kid]), nodes, 'today')).toBe('today')
    expect(inferParent(spec('x', [job]), nodes, 'today')).toBe('today') // same events = a sibling, not a child
  })
  it('a branch keeps every decision of its parent, without duplicates', () => {
    const parent = spec('work+flat', [job, flat])
    expect(withParentEvents(spec('kid', [kid]), parent).events.map((e) => e.label)).toEqual(['Job', 'Flat', 'Kid'])
    expect(withParentEvents(spec('all', [job, flat, kid]), parent).events).toHaveLength(3)
  })
  it('layout: today on the left, branches to the right, no overlaps, collapsing hides a branch', () => {
    const nodes = [{ id: 'today', parentId: null }, { id: 'a', parentId: 'today' }, { id: 'b', parentId: 'today' }, { id: 'a1', parentId: 'a' }, { id: 'a2', parentId: 'a' }]
    const { placed, edges } = layoutTree(nodes, new Set())
    expect(placed.get('a1')!.x).toBeGreaterThan(placed.get('a')!.x)
    expect(placed.get('a')!.x).toBeGreaterThan(placed.get('today')!.x)
    const ys = [...placed.values()].filter((p) => p.depth === 2).map((p) => p.y)
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(NODE_H)
    expect(edges).toHaveLength(4)
    const folded = layoutTree(nodes, new Set(['a']))
    expect(folded.placed.has('a1')).toBe(false)
    expect(folded.placed.get('a')!.hidden).toBe(2)
  })
  it('layout scales: 500 nodes in a few ms', () => {
    const nodes = [{ id: 'today', parentId: null }, ...Array.from({ length: 499 }, (_, i) => ({ id: `n${i}`, parentId: i < 20 ? 'today' : `n${i % 20}` }))]
    const t = performance.now()
    const { placed } = layoutTree(nodes, new Set())
    expect(placed.size).toBe(500)
    expect(performance.now() - t).toBeLessThan(50)
  })
})

describe('A/B comparison', () => {
  const mk = (id: string, s: ScenarioSpec): Side => {
    const pl = plan(alexia, s)
    return { id, name: s.name, spec: s, plan: pl, result: simulate(pl, params, alexia), parentName: null, madeBy: 'test', unknownFromAge: null }
  }
  const ps = presets(alexia, params)
  const work = mk('w', ps.find((p) => p.id === 'work')!.spec)
  const today = mk('t', quo)
  it('cash safety decides first: a path that runs out of cash does not "fit better", even with goals', () => {
    const f = goalFit(today, work, alexia)
    expect(f.pick).toBe('second')
    expect(f.decidedBy).toBe('cash')
  })
  it('the same path against itself is too close to call', () => {
    expect(goalFit(work, mk('w2', work.spec), alexia).pick).toBe('even')
  })
  it('the offline text only uses numbers from the facts', () => {
    const v = verdict('Which path ends with more net worth?', { ...work, overrides: {} }, { ...today, overrides: {} }, alexia, params, 120, rate)
    const facts = compareFacts({ profile: alexia, H: 120, first: today, second: work, verdict: v, fit: goalFit(today, work, alexia), breakEven: null, economy: null, told: [] })
    const t = templateCompare(facts)
    const all = [t.first.so_far, t.first.ahead, t.second!.so_far, t.second!.ahead, t.comparison].join(' ')
    expect(verifyNumbers(all, facts).unmatched).toEqual([])
    expect(facts.history_from_the_data!.months_observed).toBe(24) // the real ledger is reported as observed history
  })
})

// ---------------------------------------------------------------- facts about today: an owned home, a cash floor; editing link years
import { shiftBranch } from '../lib/tree'
import { belowFloor, breach } from '../lib/compare'

describe('facts about today (from a real chat: "assume I had a house at 20, gifted, worth 200k")', () => {
  const owner = { ...alexia, home: 200000 }
  it('an owned home adds to net worth from day one, cash is unchanged, accounting still adds up', () => {
    const a = runPath(plan(alexia, quo), params, null)
    const b = runPath(plan(owner, quo), params, null)
    expect(b.nw[0] - a.nw[0]).toBeCloseTo(200000, 0)
    expect(b.nw.at(-1)! - a.nw.at(-1)!).toBeCloseTo(200000, 0)
    expect(b.cash.at(-1)!).toBeCloseTo(a.cash.at(-1)!, 6)
    for (const c of checks(plan(owner, quo), params, owner)) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
    expect(plan(owner, quo).assumptions.find((x) => x.key === 'g.home')?.source).toBe('you')
  })
  it('the simulated median starts ~200k higher (the chart and the tiles use this)', () => {
    const r0 = simulate(plan(alexia, quo), params, alexia)
    const r1 = simulate(plan(owner, quo), params, owner)
    expect(r1.endNW.p50 - r0.endNW.p50).toBeCloseTo(200000, -2)
  })
  it('a cash floor counts every future that dips below it (a constraint, C_t >= C_min)', () => {
    const work = presets(alexia, params).find((p) => p.id === 'work')!.spec
    const r = simulate(plan(alexia, work), params, alexia)
    expect(belowFloor(r, undefined)).toBe(0)
    expect(belowFloor(r, 1e9)).toBe(1) // nobody keeps a billion
    expect(belowFloor(r, 1)).toBeGreaterThanOrEqual(r.probNegCash)
    expect(breach(r, 1e9)).toBe(1)
    expect(breach(r)).toBe(r.probNegCash)
  })
})

describe('adding events that are really changes', () => {
  it('a priced house "added" next to an unpriced one is merged, not duplicated; a real addition is appended', async () => {
    const { addEvents } = await import('../lib/tree')
    const house = makeEvent({ type: 'buy_home', label: 'House', start_month: 24 })
    const out = addEvents([house], [makeEvent({ type: 'buy_home', label: 'House', start_month: 24, amount_chf: 300000 })])
    expect(out).toHaveLength(1)
    expect(out[0].amount_chf).toBe(300000)
    expect(addEvents([house], [makeEvent({ type: 'buy_asset', label: 'Car', amount_chf: 20000 })])).toHaveLength(2)
  })
})

describe('editing the time on a link', () => {
  const job = makeEvent({ type: 'start_job', label: 'Job' })
  const flat = makeEvent({ type: 'buy_home', label: 'Flat', amount_chf: 400000, start_month: 60 })
  const kid = makeEvent({ type: 'household_change', label: 'Kid', household_type: 'family', start_month: 72 })
  const nodes = [
    { id: 'today', parentId: null, spec: { name: 'Today', catalog_id: null, events: [] } },
    { id: 'w', parentId: 'today', spec: { name: 'Work', catalog_id: null, events: [job] } },
    { id: 'wf', parentId: 'w', spec: { name: '+ flat', catalog_id: null, events: [job, flat] } },
    { id: 'wfk', parentId: 'wf', spec: { name: '+ kid', catalog_id: null, events: [job, flat, kid] } },
  ]
  it('+5 yrs -> +8 yrs moves the flat (and its copy in the sub-branch), nothing else', () => {
    const m = shiftBranch(nodes, 'wf', 8)!
    expect([...m.keys()].sort()).toEqual(['wf', 'wfk'])
    expect(m.get('wf')!.events.find((e) => e.type === 'buy_home')!.start_month).toBe(96)
    expect(m.get('wfk')!.events.find((e) => e.type === 'buy_home')!.start_month).toBe(96)
    expect(m.get('wfk')!.events.find((e) => e.type === 'household_change')!.start_month).toBe(72) // the kid's own time is kept
    expect(m.get('wf')!.events.find((e) => e.type === 'start_job')!.start_month ?? 0).toBe(0)
  })
  it('half years work; it never goes before the start; the root and unchanged links do nothing', () => {
    expect(shiftBranch(nodes, 'wf', 1.5)!.get('wf')!.events.find((e) => e.type === 'buy_home')!.start_month).toBe(18)
    expect(shiftBranch(nodes, 'wf', -50)!.get('wf')!.events.find((e) => e.type === 'buy_home')!.start_month).toBe(0)
    expect(shiftBranch(nodes, 'today', 3)).toBeNull()
    expect(shiftBranch(nodes, 'wf', 5)!.size).toBe(0)
  })
})
