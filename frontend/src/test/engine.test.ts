// Validation tests mirroring pre_docs/evaluation/technical-validation.md. Run: pnpm test
import { describe, expect, it } from 'vitest'
import { breakEven, drivers, verifyNumbers } from '../lib/analysis'
import { makeEvent, medianLoanRate, presets, resolve } from '../lib/resolve'
import { checks, NO_KNOBS, runPath, simulate } from '../lib/sim'
import { offlineParse } from '../lib/fallback'
import { verdict } from '../lib/answer'
import { suggestQuestions } from '../lib/suggest'
import { BASE_MACRO, MACRO_PRESETS } from '../lib/macro'
import type { Params, Profile, ScenarioSpec, Status, TwinEvent } from '../lib/types'
import { loadModel } from './load'

const { params, profiles } = loadModel()
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
  // The R model finds no persistent personal spending habit (sigma_u ~ CHF 16: a person's 2025 deviation from people
  // like them does not predict 2026), so a single person can sit outside their band (Alexia, P00001, spent ~CHF 280/month
  // less than similar students: her real month-24 cash is above the 80% band). Calibration is judged on everyone.
  it('all 1,200 people, status quo: the real month-24 cash lies inside the 80% band for about 80% of them', { timeout: 120_000 }, () => {
    let inside = 0
    for (const p of profiles) {
      const r = simulate(plan(p, quo, {}, 24), params, p, 200)
      if (p.ledger_closing_cash[23] >= r.cash[23].p10 && p.ledger_closing_cash[23] <= r.cash[23].p90) inside++
    }
    console.log(`in-sample: real month-24 cash inside the 80% band for ${inside} of ${profiles.length} people`)
    expect(inside / profiles.length).toBeGreaterThanOrEqual(0.7)
    expect(inside / profiles.length).toBeLessThanOrEqual(0.9)
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
    const zero = { ...BASE_MACRO, market_return_pct: 0 }
    const inv = resolve(alexia, params, { name: 'i', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 500 })] }, {}, 120, rate, zero)
    expect(Math.abs(endNW(inv) - endNW(resolve(alexia, params, quo, {}, 120, rate, zero)))).toBeLessThan(1e-6)
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
    const zero = { ...BASE_MACRO, market_return_pct: 0 }
    const cz = (s: ScenarioSpec) => { const pl = resolve(alexia, params, s, {}, 120, rate, zero); return { id: s.name, name: s.name, spec: s, overrides: {}, plan: pl, result: simulate(pl, params, alexia) } }
    const v = verdict('What if I invest 100 a month?', cz(inv), cz(quo), alexia, params, 120, rate, zero)
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

// ---------------------------------------------------------------- investments, raises, and the learned model: checked against UBS's own formulas
describe('investments follow UBS’s formulas exactly (scenario-modelling §5, financial-concepts §6)', () => {
  const r = Math.pow(1.04, 1 / 12) - 1 // the economy's 4% a year, as a monthly rate
  it('a lump sum: 10,000 at 4% for 5 years = 10,000 × 1.04^5 ≈ 12,167 (UBS’s own example)', () => {
    const pl = plan(alexia, quo, { 'g.invest': 10000 })
    const o = runPath(pl, params, null)
    expect(o.invest[59]).toBeCloseTo(10000 * Math.pow(1.04, 5), 6)
    expect(Math.round(o.invest[59])).toBe(12167)
  })
  it('monthly saving: 100 a month for 10 years = A((1+r)^n − 1)/r (contributions at the end of each month)', () => {
    const pl = plan(alexia, { name: 'i', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 100 })] }, { 'g.cash': 1e6 })
    expect(runPath(pl, params, null).invest[119]).toBeCloseTo((100 * (Math.pow(1 + r, 120) - 1)) / r, 6)
  })
  it('returns grow net worth, never cash and never income; at 4% investing ends higher than not investing', () => {
    const inv = plan(alexia, { name: 'i', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 100 })] }, { 'g.cash': 1e6 })
    const a = runPath(inv, params, null)
    const b = runPath(plan(alexia, quo, { 'g.cash': 1e6 }), params, null)
    expect(a.cash[119]).toBeCloseTo(b.cash[119] - 12000, 6) // 120 × 100 left cash, nothing came back
    expect(a.nw[119] - b.nw[119]).toBeCloseTo((100 * (Math.pow(1 + r, 120) - 1)) / r - 12000, 6) // the gain = the return
    expect(inv.income).toEqual(plan(alexia, quo).income)
    for (const c of checks(inv, params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('budget constraint (scenario-modelling §14): you cannot invest money you do not have', () => {
    // Alexia runs out of cash at 20: planned investing is skipped, so investing cannot look like free money
    const inv = plan(alexia, { name: 'i', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'i', monthly_amount_chf: 500 })] })
    const r = simulate(inv, params, alexia)
    const none = simulate(plan(alexia, quo), params, alexia)
    expect(r.investCut.share).toBe(1)
    expect(r.endNW.p50 - none.endNW.p50).toBeLessThan(2000) // before this rule: +13k from "investing" money she never had
    for (const c of checks(inv, params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('selling: money goes back to cash, net worth unchanged that month, and never more than is held', () => {
    const base = plan(alexia, quo, { 'g.invest': 10000 })
    const sell = (amt: number) => plan(alexia, { name: 's', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'Sell', start_month: 12, amount_chf: amt })] }, { 'g.invest': 10000 })
    const o = runPath(base, params, null)
    const s1 = runPath(sell(-4000), params, null)
    expect(s1.invest[12]).toBeCloseTo(o.invest[12] - 4000, 6)
    expect(s1.cash[12]).toBeCloseTo(o.cash[12] + 4000, 6)
    expect(s1.nw[12]).toBeCloseTo(o.nw[12], 6)
    const all = runPath(sell(-1e9), params, null) // sell far more than exists: capped at what is held
    expect(all.invest[12]).toBeCloseTo(0, 6)
    expect(all.cash[12]).toBeCloseTo(o.cash[12] + o.invest[12], 6)
    for (const c of checks(sell(-1e9), params, alexia)) expect(c.ok, c.name).toBe(true)
  })
})

describe('raises', () => {
  const inc = (events: TwinEvent[]) => plan(alexia, { name: 'r', catalog_id: null, events }).income
  it('+2% every year for 10 years compounds: income × 1.02^10 (one event)', () => {
    const i = inc([makeEvent({ type: 'income_change', label: 'Raise', income_change_pct: 2, repeat_every_months: 12, duration_months: 120 })])
    expect(i[119]).toBeCloseTo(alexia.income * Math.pow(1.02, 10), 6)
    expect(i[12]).toBeCloseTo(alexia.income * Math.pow(1.02, 2), 6)
  })
  it('separate permanent raises stack (×1.02 × 1.02); a raise WITH a duration is temporary', () => {
    const two = inc([makeEvent({ type: 'income_change', label: 'r1', income_change_pct: 2, start_month: 12 }), makeEvent({ type: 'income_change', label: 'r2', income_change_pct: 2, start_month: 24 })])
    expect(two[30]).toBeCloseTo(alexia.income * 1.0404, 6)
    const temp = inc([makeEvent({ type: 'income_change', label: 't', income_change_pct: 2, start_month: 12, duration_months: 12 })])
    expect(temp[30]).toBeCloseTo(alexia.income, 6)
  })
})

describe('the spending model estimated in R does real work', () => {
  const S = params.spending
  const each = (f: (s: Status) => number[]) => Object.fromEntries((Object.keys(S.base) as Status[]).map((s) => [s, f(s)])) as Record<Status, number[]>
  // no seasons (every month = the regular level), no December bonus, no surprises (k = 0)
  const flat: Params = { ...params, spending: { ...S, base: each((s) => Array(12).fill(S.base_regular[s])), k: each(() => Array(12).fill(0)), bonus: {}, student_month_excess: Array(12).fill(0) } }
  const job = presets(alexia, params).find((p) => p.id === 'work')!.spec
  it('without the learned seasons, bonus and surprises the results change, and the uncertainty band almost vanishes', () => {
    const learned = simulate(plan(alexia, job), params, alexia)
    const none = simulate(plan(alexia, job), flat, alexia)
    expect(Math.abs(learned.endNW.p50 - none.endNW.p50)).toBeGreaterThan(1000) // e.g. December bonuses, expensive Februaries
    const w = (x: typeof learned) => x.endNW.p90 - x.endNW.p10
    expect(w(none)).toBeLessThan(w(learned) * 0.8) // the band comes from what was learned
  })
  it('defaults come from the data: a new job pays the median of real peers of that age', () => {
    const a = plan(alexia, job).assumptions.find((x) => x.label.includes('net salary'))!
    expect(a.source).toBe('data')
    expect(a.value).toBeCloseTo(params.anchors.income_by_status.employed.by_age_band['20-24'].median, 6)
  })
})

// ---------------------------------------------------------------- UBS technical-validation edge cases + "does it take effect?"
import { effectIssues, incomeNeeded } from '../lib/effects'

describe('UBS technical-validation edge cases', () => {
  it('zero interest rate: no division by zero, the loan is repaid to exactly 0', () => {
    const l = plan(alexia, { name: 'l', catalog_id: null, events: [makeEvent({ type: 'take_loan', label: 'l', amount_chf: 12000, annual_rate_pct: 0, duration_months: 24 })] })
    const o = runPath(l, params, null)
    expect(o.nw.every(Number.isFinite)).toBe(true)
    expect(o.debt[30]).toBeCloseTo(0, 6)
    for (const c of checks(l, params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('negative investment return: the portfolio shrinks consistently, accounting still adds up', () => {
    const bad = { ...BASE_MACRO, id: 'custom', market_return_pct: -10 }
    const pl = resolve(alexia, params, quo, { 'g.invest': 10000 }, 120, rate, bad)
    expect(runPath(pl, params, null).invest[11]).toBeCloseTo(9000, 6)
    for (const c of checks(pl, params, alexia)) expect(c.ok, c.name).toBe(true)
  })
  it('"my income drops 20% each year for 2 years": two compounding cuts (× 0.64), then it stays there', () => {
    const i = plan(alexia, { name: 'c', catalog_id: null, events: [makeEvent({ type: 'income_change', label: 'Cut', income_change_pct: -20, repeat_every_months: 12, duration_months: 24 })] }).income
    expect(i[6]).toBeCloseTo(alexia.income * 0.8, 6)
    expect(i[18]).toBeCloseTo(alexia.income * 0.64, 6)
    expect(i[119]).toBeCloseTo(alexia.income * 0.64, 6)
  })
  it('decisions that cannot work as written are flagged: a job during a study; an event after the end', () => {
    const w = plan(alexia, { name: 'x', catalog_id: null, events: [makeEvent({ type: 'study', label: "Master's" }), makeEvent({ type: 'start_job', label: 'Job 3000', monthly_net_income_chf: 3000 }), makeEvent({ type: 'one_off', label: 'Party', amount_chf: 1000, start_month: 200 })] }).warnings
    expect(w.some((x) => /starts while studying/.test(x))).toBe(true)
    expect(w.some((x) => /after the end of the simulation/.test(x))).toBe(true)
  })
})

describe('does it take effect? (engine-checked notices after every chat turn)', () => {
  const sim = (spec: ScenarioSpec, p: Profile = alexia, o = {}) => {
    const pl = plan(p, spec, o)
    return { pl, r: simulate(pl, params, p, 200) }
  }
  it('a healthy path has no notices', () => {
    const job = presets(alexia, params).find((p) => p.id === 'work')!.spec
    const { pl, r } = sim(job)
    expect(effectIssues('Start working', job, pl, r, alexia)).toEqual([])
  })
  it('investing without the cash, a house without a price, a down payment that is not there: all "not taking effect"', () => {
    const inv: ScenarioSpec = { name: 'Invest', catalog_id: null, events: [makeEvent({ type: 'invest', label: 'Invest', monthly_amount_chf: 500 })] }
    const a = sim(inv)
    expect(effectIssues('Invest', inv, a.pl, a.r, alexia).some((x) => x.level === 'blocked' && /cannot happen/.test(x.text))).toBe(true)
    const nop: ScenarioSpec = { name: 'Flat', catalog_id: null, events: [makeEvent({ type: 'buy_home', label: 'Flat', start_month: 60 })] }
    const b = sim(nop)
    expect(effectIssues('Flat', nop, b.pl, b.r, alexia).some((x) => x.level === 'blocked' && /no price/.test(x.text))).toBe(true)
    const big: ScenarioSpec = { name: 'Flat', catalog_id: null, events: [makeEvent({ type: 'buy_home', label: 'Flat', start_month: 60, amount_chf: 300000, down_payment_pct: 100 })] }
    const c = sim(big)
    expect(effectIssues('Flat', big, c.pl, c.r, alexia).some((x) => x.level === 'blocked' && /own money/.test(x.text))).toBe(true)
  })
  it('income needed (goal-seek): none when already fine; when not, that income really keeps cash >= 0', () => {
    const job = presets(alexia, params).find((p) => p.id === 'work')!.spec
    expect(incomeNeeded(plan(alexia, job), params)).toBeNull()
    const n = incomeNeeded(plan(alexia, quo), params)!
    expect(n.pct).toBeGreaterThan(0)
    expect(Number.isFinite(n.pct)).toBe(true)
    const o = runPath(plan(alexia, quo), params, null, { ...NO_KNOBS, income: 1 + n.pct / 100 })
    expect(Math.min(...o.cash)).toBeGreaterThanOrEqual(0)
    const o2 = runPath(plan(alexia, quo), params, null, { ...NO_KNOBS, income: 1 + (n.pct - 2) / 100 })
    expect(Math.min(...o2.cash)).toBeLessThan(0) // and it is the smallest such income (within 2%)
  })
})

import { buildFacts, templateExplanation } from '../lib/analysis'
describe('AI facts describe only what IS there', () => {
  const ps = presets(alexia, params)
  const sideOf = (id: string) => {
    const p = ps.find((x) => x.id === id)!
    const plan = resolve(alexia, params, p.spec, {}, 120, rate)
    return { id, name: p.spec.name, spec: p.spec, plan, result: simulate(plan, params, alexia), parentName: null, madeBy: 'x', unknownFromAge: null }
  }
  it('no empty purchase / unknown / warning lists are sent, and the offline texts never say "undefined"', () => {
    const [work, master] = [sideOf('work'), sideOf('master')]
    const cf = compareFacts({ profile: alexia, H: 120, first: work, second: master, verdict: null, fit: goalFit(work, master, alexia), breakEven: null, economy: null, told: [] })
    const js = JSON.stringify(cf)
    expect(js).not.toMatch(/"(home_or_asset_purchases|depends_on_unknown_numbers|warnings)":\[\]/)
    expect(js).not.toMatch(/"(investments_chf|debts_chf)":0\b/) // Alexia has none: not "no investments, no debts"
    expect(cf.paths[1].depends_on_unknown_numbers?.length).toBeGreaterThan(0) // what IS there is still sent
    const t = templateCompare(cf)
    expect(JSON.stringify(t)).not.toMatch(/undefined|NaN/)
    // the explain facts (baseline = work, focus = master): work has no unknowns
    const br = [work, master].map((s, i) => ({ id: s.id, name: s.name, plan: s.plan, result: s.result, isBaseline: i === 0 }))
    const ef = buildFacts(alexia, params, br, drivers(master.plan, params), breakEven(master.plan, work.plan, params), 'master')
    expect(JSON.stringify(ef)).not.toMatch(/"(home_purchases|unknown_inputs|warnings)":\[\]/)
    const te = templateExplanation(ef)
    expect(JSON.stringify(te)).not.toMatch(/undefined|NaN/)
    const onlyWork = buildFacts(alexia, params, [br[0], { ...br[0], id: 'w2', isBaseline: false }], [], null, 'w2')
    expect(templateExplanation(onlyWork).caveat).not.toMatch(/undefined|Unknown inputs/) // no unknowns -> no "unknown inputs: ." (flatMap over a missing list)
  })
})
