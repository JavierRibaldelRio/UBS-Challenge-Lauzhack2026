// Rolling-horizon valuation (NPV in today's money): the formula, its properties and the single default discount rate.
import { describe, expect, it } from 'vitest'
import { verifyNumbers } from '../lib/analysis'
import { verdict } from '../lib/answer'
import { compareFacts, goalFit, templateCompare, type Side } from '../lib/compare'
import { offlineParse } from '../lib/fallback'
import { BASE_MACRO, MACRO_PRESETS, type Macro } from '../lib/macro'
import { makeEvent, medianLoanRate, presets, resolve } from '../lib/resolve'
import { simulate, type Band } from '../lib/sim'
import type { Profile, ScenarioSpec } from '../lib/types'
import { catchUp, DEFAULT_DISCOUNT_PCT, discountFactors, npvSeries } from '../lib/valuation'
import { loadModel } from './load'

const { params, profiles } = loadModel()
const rate = medianLoanRate(profiles)
const alexia = profiles.find((p) => p.id === 'P00001')!
const worker = profiles.find((p) => p.status === 'employed' && p.age >= 26 && p.age <= 40 && p.income > 5000 && p.cash > 20000)!
const spec = (...events: Parameters<typeof makeEvent>[0][]): ScenarioSpec => ({ name: 'x', catalog_id: null, events: events.map(makeEvent) })
const plan = (p: Profile, s: ScenarioSpec, disc: number | null = null, macro: Macro = BASE_MACRO, H = 120) => resolve(p, params, s, {}, H, rate, macro, disc)
const sim = (pl: ReturnType<typeof plan>, p: Profile, paths = 200) => simulate(pl, params, p, paths)
const work = presets(alexia, params).find((x) => x.id === 'work')!.spec
const master = presets(alexia, params).find((x) => x.id === 'master')!.spec

describe('NPV formula', () => {
  it('discount factors: 12 months compound to exactly the annual rate', () => {
    const df = discountFactors(0.03, 24)
    expect(df[11]).toBeCloseTo(1 / 1.03, 12)
    expect(df[23]).toBeCloseTo(1 / 1.03 ** 2, 12)
  })

  it('a hand-made example: +1,200 cash in month 12, nothing else', () => {
    const cash = Float64Array.from({ length: 12 }, (_, t) => (t === 11 ? 1200 : 0))
    const npv = npvSeries(0, cash, cash, discountFactors(0.03, 12))
    expect(npv[11]).toBeCloseTo(1200 / 1.03, 9)
  })

  it('with a 0% discount rate, worth in today’s money = net worth, in every future and every month', () => {
    for (const s of [{ name: 'q', catalog_id: null, events: [] }, work, master]) {
      const r = sim(plan(alexia, s, 0), alexia)
      for (let t = 0; t < r.nw.length; t++) {
        expect(r.npv[t].p10).toBeCloseTo(r.nw[t].p10, 6)
        expect(r.npv[t].p50).toBeCloseTo(r.nw[t].p50, 6)
        expect(r.npv[t].p90).toBeCloseTo(r.nw[t].p90, 6)
      }
      r.endNPVPaths.forEach((v, i) => expect(v).toBeCloseTo(r.endNWPaths[i], 6))
    }
  })

  it('investing at a return equal to the discount rate leaves the NPV unchanged (future by future)', () => {
    const macro = { ...BASE_MACRO, market_return_pct: 3 }
    const a = sim(plan(worker, spec(), 3, macro), worker)
    const b = sim(plan(worker, spec({ type: 'invest', label: 'invest', monthly_amount_chf: 500 }), 3, macro), worker)
    expect(b.endNW.p50).toBeGreaterThan(a.endNW.p50) // investing does raise net worth (3% return vs 0% on cash)
    let worst = 0
    a.endNPVPaths.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b.endNPVPaths[i]))))
    expect(worst).toBeLessThan(1)
  })

  it('the same cost earlier weighs more in today’s money, while the end net worth is the same', () => {
    const early = sim(plan(worker, spec({ type: 'one_off', label: 'car', amount_chf: 20000, start_month: 12 })), worker)
    const late = sim(plan(worker, spec({ type: 'one_off', label: 'car', amount_chf: 20000, start_month: 96 })), worker)
    expect(early.endNW.p50).toBeCloseTo(late.endNW.p50, 0)
    expect(early.endNPV.p50).toBeLessThan(late.endNPV.p50 - 2000)
  })

  it('a higher discount rate lowers the value of a path that earns later (master’s vs work)', () => {
    const gap = (d: number) => sim(plan(alexia, work, d), alexia).endNPV.p50 - sim(plan(alexia, master, d), alexia).endNPV.p50
    expect(gap(6)).toBeLessThan(gap(0)) // later income is discounted more…
    expect(gap(0)).toBeCloseTo(sim(plan(alexia, work, 0), alexia).endNW.p50 - sim(plan(alexia, master, 0), alexia).endNW.p50, 6)
  })
})

describe('one default discount rate, a labelled assumption', () => {
  it(`is ${DEFAULT_DISCOUNT_PCT}% (assumption) for every economy and every person, unless the user sets one`, () => {
    for (const m of MACRO_PRESETS)
      for (const p of profiles.slice(0, 40)) {
        const pl = plan(p, spec(), null, m, 24)
        const row = pl.assumptions.find((a) => a.key === 'v.disc')!
        expect(row.value).toBe(DEFAULT_DISCOUNT_PCT)
        expect(row.source).toBe('assumption')
        expect(pl.discountRate).toBe(DEFAULT_DISCOUNT_PCT / 100)
      }
    const mine = plan(alexia, spec(), 5)
    const row = mine.assumptions.find((a) => a.key === 'v.disc')!
    expect([row.value, row.source, mine.discountRate]).toEqual([5, 'you', 0.05])
  })

  it('a per-path override cannot change it (the rate is shared by every path)', () => {
    const pl = resolve(alexia, params, spec(), { 'v.disc': 9 }, 120, rate, BASE_MACRO, null)
    expect(pl.discountRate).toBe(DEFAULT_DISCOUNT_PCT / 100)
  })

  it('valuation never changes the simulation', () => {
    const a = sim(plan(alexia, work, null), alexia)
    const b = sim(plan(alexia, work, 9), alexia)
    expect(Array.from(b.endNWPaths)).toEqual(Array.from(a.endNWPaths))
    expect(b.endNPV.p50).toBeLessThan(a.endNPV.p50)
  })
})

describe('today’s money in the A/B text, the chat and offline mode', () => {
  const mk = (id: string, s: ScenarioSpec, disc: number | null): Side => {
    const pl = plan(alexia, s, disc)
    return { id, name: s.name, spec: s, plan: pl, result: simulate(pl, params, alexia), parentName: null, madeBy: 'test', unknownFromAge: null }
  }
  for (const disc of [null, 5]) {
    it(`the offline A/B text states the NPV and the rate (${disc ?? 'default'}), and every number in it is in the facts`, () => {
      const w = mk('w', work, disc)
      const m = mk('m', master, disc)
      const v = verdict('Which path ends with more net worth?', { ...m, overrides: {} }, { ...w, overrides: {} }, alexia, params, 120, rate)
      const facts = compareFacts({ profile: alexia, H: 120, first: w, second: m, verdict: v, fit: goalFit(w, m, alexia), breakEven: null, economy: null, told: [] })
      expect(facts.todays_money.discount_rate_pct).toBe(disc ?? DEFAULT_DISCOUNT_PCT)
      expect(facts.todays_money.rate_source).toBe(disc == null ? 'default assumption, the same for every path' : 'set by the user')
      expect(facts.paths[0].worth_in_todays_money_at_end_median_chf).toBe(Math.round(w.result.endNPV.p50 / 100) * 100)
      const t = templateCompare(facts)
      const all = [t.first.so_far, t.first.ahead, t.second!.so_far, t.second!.ahead, t.comparison].join(' ')
      expect(all).toContain(`NPV at ${disc ?? DEFAULT_DISCOUNT_PCT}% a year`)
      expect(t.comparison).toContain('In today\'s money')
      expect(verifyNumbers(all, facts).unmatched).toEqual([])
    })
  }

  it('offline keyword rules understand a discount rate (and nothing else sets one)', () => {
    expect(offlineParse('use a 5% discount rate', alexia, []).discount_rate_pct).toBe(5)
    expect(offlineParse('discount at 2.5%', alexia, []).discount_rate_pct).toBe(2.5)
    expect(offlineParse('what if I do a master?', alexia, []).discount_rate_pct).toBeNull()
    expect(offlineParse('discount rate of 4%', alexia, []).discount_rate_pct).toBe(4)
    expect(offlineParse('I get a 20% discount on my rent', alexia, []).discount_rate_pct).toBeNull() // a price cut, not a rate
    expect(offlineParse('20% discount on a car', alexia, []).discount_rate_pct).toBeNull()
  })
})

describe('rolling horizon: who is ahead in today’s money, year by year', () => {
  const bands = (yearly: number[]): Band[] => yearly.flatMap((v) => Array.from({ length: 12 }, () => ({ p10: v, p50: v, p90: v })))
  it('the path ending ahead after being behind: the age it catches up', () => {
    // A behind in years 1-3, ahead from year 4 on; start age 20 -> ahead from 24
    expect(catchUp(bands([-10e3, -5e3, -1e3, 5e3, 20e3]), bands([0, 0, 0, 0, 0]), 20)).toEqual({ ahead: 'a', fromAge: 24 })
  })
  it('ahead all along, and a tie', () => {
    expect(catchUp(bands([0, 0, 0]), bands([5e3, 9e3, 30e3]), 20)).toEqual({ ahead: 'b', fromAge: null })
    expect(catchUp(bands([100e3, 100e3]), bands([0, 100.5e3]), 20)).toEqual({ ahead: 'tie', fromAge: null })
  })
})
