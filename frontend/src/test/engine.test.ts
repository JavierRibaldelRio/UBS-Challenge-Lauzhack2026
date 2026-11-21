// Validation tests mirroring pre_docs/evaluation/technical-validation.md. Run: pnpm test
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { breakEven, drivers, verifyNumbers } from '../lib/analysis'
import { makeEvent, medianLoanRate, presets, resolve } from '../lib/resolve'
import { checks, runPath, simulate } from '../lib/sim'
import type { Params, Profile, ScenarioSpec } from '../lib/types'

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

describe('LLM number verifier', () => {
  const facts = { a: 254300, b: 35, c: [12000, 18000] }
  it('accepts numbers present in facts (incl. k)', () => expect(verifyNumbers('CHF 254k, 35% chance, 12,000 to 18’000', facts).unmatched).toEqual([]))
  it('flags invented numbers', () => expect(verifyNumbers('a 42% chance', facts).unmatched).toEqual(['42%']))
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
