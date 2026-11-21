// End-to-end test WITH the real LLM: question -> /api/parse -> resolver -> Monte Carlo -> facts -> /api/explain -> number check.
// Needs the backend running with a key:  cd backend && pnpm start   then   cd frontend && pnpm test:live
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { breakEven, buildFacts, drivers, verifyNumbers } from '../lib/analysis'
import { cities, medianLoanRate, presets, resolve } from '../lib/resolve'
import { simulate } from '../lib/sim'
import type { ExplainResult, Params, ParseResult, Profile } from '../lib/types'

const API = process.env.API ?? 'http://localhost:8000'
const params: Params = JSON.parse(readFileSync('src/model/params.json', 'utf8'))
const profiles: Profile[] = JSON.parse(readFileSync('src/model/profiles.json', 'utf8'))
const alexia = profiles.find((p) => p.id === 'P00001')!
const rate = medianLoanRate(profiles)

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; data: T; error?: string; ms: number }> {
  const t = Date.now()
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ...(await r.json()), ms: Date.now() - t }
}
const ctx = (text: string, p: Profile = alexia) => ({
  text, name: p.name, age: p.age, start_date: p.as_of,
  profile: { age: p.age, city: p.city, status: p.status, household: p.household, net_income_chf: p.income, rent_chf: p.rent, cash_chf: p.cash, investments_chf: p.investments },
  cities: cities(params), catalog: params.catalog.map((c) => ({ id: c.id, name: c.name })),
})

type Case = { q: string; expect: (r: ParseResult) => void }
const ev = (r: ParseResult) => r.scenarios.flatMap((s) => s.events)
const CASES: Case[] = [
  { q: "What if I do a master's?", expect: (r) => expect(ev(r).some((e) => e.type === 'study')).toBe(true) },
  { q: "Should I start working or do a master's degree?", expect: (r) => { expect(r.scenarios.length).toBe(2); expect(ev(r).map((e) => e.type)).toEqual(expect.arrayContaining(['study', 'start_job'])) } },
  { q: 'What if I move to Zurich next year and start a job there?', expect: (r) => { const re = ev(r).find((e) => e.type === 'relocate'); expect(re?.city).toBe('Zurich'); expect(re?.start_month).toBe(12) } },
  { q: 'What if I start working at 22 earning 6000 a month?', expect: (r) => { const j = ev(r).find((e) => e.type === 'start_job'); expect(j?.start_month).toBe(24); expect(j?.monthly_net_income_chf).toBe(6000) } },
  { q: 'What if I move to Berlin?', expect: (r) => { const re = ev(r).find((e) => e.type === 'relocate'); expect(re?.city?.toLowerCase()).toContain('abroad'); expect(re?.monthly_amount_chf ?? null).toBeNull() } },
  { q: 'What if I have a baby at 28?', expect: (r) => { const h = ev(r).find((e) => e.type === 'household_change'); expect(h?.household_type).toBe('family'); expect(h?.start_month).toBe(96) } },
  { q: 'What if I lose my job for 6 months at 25?', expect: (r) => { const c = ev(r).find((e) => e.type === 'income_change'); expect(c?.income_change_pct).toBe(-100); expect(c?.duration_months).toBe(6) } },
  { q: 'What if I work part-time at 60%?', expect: (r) => expect(ev(r).find((e) => e.type === 'income_change')?.income_change_pct).toBe(-40) },
  { q: 'What if I buy a car for 25k and pay 300 a month for insurance?', expect: (r) => { expect(ev(r).some((e) => e.type === 'one_off' && e.amount_chf === 25000)).toBe(true); expect(ev(r).some((e) => e.type === 'recurring_expense' && e.monthly_amount_chf === 300)).toBe(true) } },
  { q: 'What if I win the lottery? Also, how do taxes affect me?', expect: (r) => expect(r.unsupported.length + r.scenarios.length).toBeGreaterThan(0) },
]

describe.runIf(process.env.LIVE === '1')('live LLM', () => {
  it('backend has an LLM configured', async () => {
    const h = await (await fetch(API + '/api/health')).json()
    console.log('health', h)
    expect(h.llm).not.toBeNull()
  })

  for (const c of CASES) {
    it(`parse: ${c.q}`, async () => {
      const r = await post<ParseResult>('/api/parse', ctx(c.q))
      console.log(`${r.ms}ms  ${c.q}\n   ->`, JSON.stringify(r.ok ? r.data.scenarios.map((s) => ({ n: s.name, e: s.events.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))) })) : r.error), r.ok && r.data.unsupported.length ? `unsupported: ${r.data.unsupported}` : '')
      expect(r.ok, r.error).toBe(true)
      c.expect(r.data)
      // every parsed scenario must resolve + simulate cleanly
      for (const s of r.data.scenarios) {
        const plan = resolve(alexia, params, s, {}, 120, rate)
        const res = simulate(plan, params, alexia, 100)
        expect(Number.isFinite(res.endNW.p50)).toBe(true)
      }
    }, 40000)
  }

  it('explain: Alexia demo, all numbers traced to the engine', async () => {
    const ps = presets(alexia, params)
    const specs = [ps.find((p) => p.id === 'work')!, ps.find((p) => p.id === 'master')!, ps.find((p) => p.id === 'abroad')!]
    const branches = specs.map((p, i) => {
      const plan = resolve(alexia, params, p.spec, {}, 120, rate)
      return { id: p.id, name: p.spec.name, plan, result: simulate(plan, params, alexia), isBaseline: i === 0 }
    })
    const focus = branches[1]
    const facts = buildFacts(alexia, params, branches, drivers(focus.plan, params), breakEven(focus.plan, branches[0].plan, params), focus.id)
    const r = await post<ExplainResult>('/api/explain', { facts })
    expect(r.ok, r.error).toBe(true)
    console.log(`${r.ms}ms explain:\n  ${r.data.headline}\n  ${r.data.explanation}\n  ⚠ ${r.data.caveat}`)
    const v = verifyNumbers(`${r.data.headline} ${r.data.explanation} ${r.data.caveat}`, facts)
    console.log('verify', v)
    expect(v.unmatched).toEqual([])
  }, 40000)
})
