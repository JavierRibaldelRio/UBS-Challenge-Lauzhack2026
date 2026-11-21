// End-to-end test WITH the real LLM: question -> /api/parse -> resolver -> Monte Carlo -> facts -> /api/explain -> number check.
// Needs the backend running with a key:  cd backend && pnpm start   then   cd frontend && pnpm test:live
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { breakEven, buildFacts, drivers, verifyNumbers } from '../lib/analysis'
import { answerFacts, verdict } from '../lib/answer'
import { cities, medianLoanRate, presets, resolve } from '../lib/resolve'
import { simulate } from '../lib/sim'
import type { AnswerResult, ExplainResult, Params, ParseResult, Profile } from '../lib/types'

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
  {
    q: "Do a 2-year master's now, lose my job for 6 months at 25, and buy a flat for 750k at 28",
    expect: (r) => {
      expect(r.scenarios.length).toBe(1)
      const types = ev(r).map((e) => e.type)
      expect(types).toEqual(expect.arrayContaining(['study', 'income_change', 'buy_home']))
      const h = ev(r).find((e) => e.type === 'buy_home')!
      expect(h.amount_chf).toBe(750000)
      expect(h.start_month).toBe(96)
    },
  },
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

  // ---------------- very complex sentences + a direct, verified answer for each
  const COMPLEX: { q: string; check: (r: ParseResult) => void }[] = [
    {
      q: "If I do a two-year master's in Geneva starting now, then work there for 7,500 a month, have a kid at 29 and put 400 a month into an ETF from 26, versus just starting a job in Lausanne now and buying a 700k flat at 30 with 25% down at 1.8% interest",
      check: (r) => {
        expect(r.scenarios.length).toBe(2)
        const all = ev(r)
        expect(all.some((e) => e.type === 'study')).toBe(true)
        expect(all.some((e) => e.type === 'relocate' && e.city === 'Geneva')).toBe(true)
        expect(all.some((e) => e.type === 'household_change' && e.start_month === 108)).toBe(true)
        expect(all.some((e) => e.type === 'invest' && e.monthly_amount_chf === 400 && e.start_month === 72)).toBe(true)
        const h = all.find((e) => e.type === 'buy_home')!
        expect([h.amount_chf, h.down_payment_pct, h.annual_rate_pct, h.start_month]).toEqual([700000, 25, 1.8, 120])
      },
    },
    {
      q: 'I want to borrow 30k at 4% over 10 years to pay for a master, and I expect my salary afterwards to be 15% higher',
      check: (r) => {
        const l = ev(r).find((e) => e.type === 'take_loan')!
        expect([l.amount_chf, l.annual_rate_pct, l.duration_months]).toEqual([30000, 4, 120])
        expect(ev(r).find((e) => e.type === 'study')?.income_change_pct).toBe(15)
      },
    },
    {
      q: 'What if I lose my job at 24 for a whole year but get 70% of my salary as unemployment benefits?',
      check: (r) => {
        const c = ev(r).find((e) => e.type === 'income_change')!
        expect([c.income_change_pct, c.duration_months, c.start_month]).toEqual([-30, 12, 48])
      },
    },
    {
      q: 'Start working now; I inherit 50k at 27 and invest half of it right away',
      check: (r) => {
        expect(ev(r).some((e) => e.type === 'one_off' && e.amount_chf === -50000 && e.start_month === 84)).toBe(true)
        expect(ev(r).some((e) => e.type === 'invest' && e.amount_chf === 25000)).toBe(true)
      },
    },
    {
      q: 'Et si je déménage à Zurich l’année prochaine et que je commence à travailler là-bas ?',
      check: (r) => {
        expect(ev(r).some((e) => e.type === 'relocate' && e.city === 'Zurich' && e.start_month === 12)).toBe(true)
        expect(ev(r).some((e) => e.type === 'start_job')).toBe(true)
      },
    },
    {
      q: 'Move to London next year earning 6k pounds a month',
      check: (r) => {
        const re = ev(r).find((e) => e.type === 'relocate')!
        expect(re.city?.toLowerCase()).toContain('abroad')
        // pounds are not francs: the AI must not silently convert, and must flag it
        const income = ev(r).map((e) => e.monthly_net_income_chf).find((x) => x != null)
        expect(income == null || r.unsupported.join(' ').toLowerCase().match(/currenc|gbp|pound|exchange/)).toBeTruthy()
      },
    },
    {
      q: "So basically my parents might give me 20k when I turn 23, and I'm thinking of using it with a 5k personal loan as the deposit for a small studio for 250k when I'm 25. Until 22 I keep studying, then I work.",
      check: (r) => {
        expect(r.scenarios.length).toBe(1)
        const types = ev(r).map((e) => e.type)
        expect(types).toEqual(expect.arrayContaining(['one_off', 'buy_home']))
        expect(ev(r).find((e) => e.type === 'buy_home')!.amount_chf).toBe(250000)
        expect(ev(r).some((e) => e.type === 'one_off' && e.amount_chf === -20000 && e.start_month === 36)).toBe(true)
      },
    },
    {
      q: 'Can I reach my emergency savings goal by 2029 if I invest 100 a month?',
      check: (r) => expect(ev(r).some((e) => e.type === 'invest' && e.monthly_amount_chf === 100)).toBe(true),
    },
    {
      q: 'Can I afford a flat for 600k at 28 if I start working now?',
      check: (r) => expect(ev(r).some((e) => e.type === 'buy_home' && e.amount_chf === 600000 && e.start_month === 96)).toBe(true),
    },
    {
      q: 'Can I afford a flat for 300k at 25 if nothing else changes?',
      check: (r) => expect(ev(r).some((e) => e.type === 'buy_home' && e.amount_chf === 300000 && e.start_month === 60)).toBe(true),
    },
  ]
  for (const c of COMPLEX) {
    it(`complex + answer: ${c.q.slice(0, 70)}…`, async () => {
      const r = await post<ParseResult>('/api/parse', ctx(c.q))
      expect(r.ok, r.error).toBe(true)
      console.log(`\n${r.ms}ms  ${c.q}\n   ->`, JSON.stringify(r.data.scenarios.map((s) => ({ n: s.name, e: s.events.map((e) => Object.fromEntries(Object.entries(e).filter(([k, v]) => v != null && k !== 'label'))) }))), r.data.unsupported.length ? `\n   unsupported: ${r.data.unsupported.join(' | ')}` : '')
      c.check(r.data)
      // answer: same logic as the app (1 path -> vs "nothing changes"; 2+ -> the top two)
      const mk = (spec: (typeof r.data.scenarios)[number]) => {
        const plan = resolve(alexia, params, spec, {}, 120, rate)
        return { id: spec.name, name: spec.name, spec, overrides: {}, plan, result: simulate(plan, params, alexia) }
      }
      const made = r.data.scenarios.map(mk).sort((a, b) => b.result.endNW.p50 - a.result.endNW.p50)
      const quo = { name: 'If nothing changes', catalog_id: null, events: [] }
      const pair = made.length >= 2 ? [made[0], made[1]] : [made[0], mk(quo)]
      const v = verdict(c.q, pair[0], pair[1], alexia, params, 120, rate)
      const f = answerFacts(v, alexia, params, 120)
      const a = await post<AnswerResult>('/api/answer', { facts: f })
      expect(a.ok, a.error).toBe(true)
      const check = verifyNumbers(`${a.data.short_answer} ${a.data.reasoning} ${a.data.confidence_sentence}`, f)
      console.log(`   ANSWER (${a.ms}ms, kind ${v.kind}, confidence ${v.confidence}, paired ${Math.round(v.pairedShare * 100)}%, peer test ${v.peerTest?.holds ?? 'n/a'}):\n     ${a.data.short_answer}\n     ${a.data.reasoning}\n     ${a.data.confidence_sentence}\n     numbers: ${check.total - check.unmatched.length}/${check.total} ${check.unmatched.join(', ')}`)
      expect(check.unmatched).toEqual([])
      expect(a.data.confidence_level).toBe(v.confidence) // the AI must not change the computed confidence
    }, 60000)
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
