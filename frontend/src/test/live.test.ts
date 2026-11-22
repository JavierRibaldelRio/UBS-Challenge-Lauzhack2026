// End-to-end test WITH the real LLM: question -> /api/parse -> resolver -> Monte Carlo -> facts -> /api/explain -> number check.
// Needs the backend running with a key:  cd backend && pnpm start   then   cd frontend && pnpm test:live
import { loadModel } from './load'
import { describe, expect, it } from 'vitest'
import { breakEven, buildFacts, drivers, verifyNumbers } from '../lib/analysis'
import { answerFacts, verdict } from '../lib/answer'
import { cities, medianLoanRate, presets, resolve } from '../lib/resolve'
import { simulate } from '../lib/sim'
import { compareFacts, goalFit, type CompareResult, type Side } from '../lib/compare'
import { addEvents } from '../lib/tree'
import type { AnswerResult, EditResult, ExplainResult, ParseResult, Profile, TurnResult, TwinEvent } from '../lib/types'

const API = process.env.API ?? 'http://localhost:8000'
const { params, profiles } = loadModel()
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
  { q: 'What if I buy a car for 25k and pay 300 a month for insurance?', expect: (r) => { const car = ev(r).find((e) => e.type === 'buy_asset')!; expect(car.amount_chf).toBe(25000); expect(car.monthly_amount_chf === 300 || ev(r).some((e) => e.type === 'recurring_expense' && e.monthly_amount_chf === 300)).toBe(true) } },
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

  // ---------------- the twin updates itself + follow-up edits
  it('twin update: "I now earn 1,500 a month and have 10k saved" -> profile_update, no new path', async () => {
    const r = await post<ParseResult>('/api/parse', ctx('I now earn 1,500 a month and have 10k saved'))
    expect(r.ok, r.error).toBe(true)
    console.log('update ->', JSON.stringify(r.data.profile_update), r.data.scenarios.length)
    expect(r.data.profile_update?.monthly_net_income_chf).toBe(1500)
    expect(r.data.profile_update?.cash_chf).toBe(10000)
    expect(r.data.scenarios.length).toBe(0)
  }, 40000)
  it('small talk ("hey"): no paths, no update, a friendly reply in note', async () => {
    const r = await post<ParseResult>('/api/parse', ctx('hey'))
    expect(r.ok, r.error).toBe(true)
    console.log('hey ->', r.data.note)
    expect(r.data.scenarios.length).toBe(0)
    expect(r.data.profile_update ?? null).toBeNull()
    expect((r.data.note ?? '').length).toBeGreaterThan(10)
  }, 40000)
  it('mixed: a fact about today AND a what-if in one message', async () => {
    const r = await post<ParseResult>('/api/parse', ctx("My rent went up to 1,100. What if I do a master's?"))
    expect(r.ok, r.error).toBe(true)
    expect(r.data.profile_update?.monthly_rent_chf).toBe(1100)
    expect(ev(r.data).some((e) => e.type === 'study')).toBe(true)
  }, 40000)
  const editCtx = (text: string, path: unknown, fixed: unknown[] = []) => ({ ...ctx(text), path, fixed })
  const ED = (e: Partial<TwinEvent> & { type: TwinEvent['type']; label: string }) => ({ start_month: 0, duration_months: null, monthly_net_income_chf: null, income_change_pct: null, monthly_amount_chf: null, amount_chf: null, annual_tuition_chf: null, city: null, household_type: null, annual_rate_pct: null, drop_pct: null, down_payment_pct: null, ...e })
  it('edit: "make it 3 years and the degree raises my salary by 20%"', async () => {
    const r = await post<EditResult>('/api/edit', editCtx('make it 3 years and the degree raises my salary by 20%', { name: "Master's degree", events: [ED({ type: 'study', label: "Master's" })] }))
    expect(r.ok, r.error).toBe(true)
    console.log('edit1 ->', JSON.stringify(r.data.path.events.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)))), r.data.changes)
    const st = r.data.path.events.find((e) => e.type === 'study')!
    expect([st.duration_months, st.income_change_pct]).toEqual([36, 20])
  }, 40000)
  it('edit: change one amount, keep everything else exactly', async () => {
    const path = { name: 'Work, job loss, flat', events: [ED({ type: 'start_job', label: 'Start working' }), ED({ type: 'income_change', label: 'Job loss', start_month: 60, duration_months: 6, income_change_pct: -100 }), ED({ type: 'buy_home', label: 'Buy flat', start_month: 96, amount_chf: 600000 })] }
    const r = await post<EditResult>('/api/edit', editCtx('make the flat 500k', path))
    expect(r.ok, r.error).toBe(true)
    console.log('edit2 ->', r.data.changes)
    expect(r.data.path.events.length).toBe(3)
    expect(r.data.path.events.find((e) => e.type === 'buy_home')!.amount_chf).toBe(500000)
    expect(r.data.path.events.find((e) => e.type === 'income_change')!.duration_months).toBe(6)
  }, 40000)
  it('edit: remove an event; hand-set values are kept', async () => {
    const path = { name: 'Work, job loss, flat', events: [ED({ type: 'start_job', label: 'Start working' }), ED({ type: 'income_change', label: 'Job loss', start_month: 60, duration_months: 6, income_change_pct: -100 }), ED({ type: 'buy_home', label: 'Buy flat', start_month: 96, amount_chf: 600000 })] }
    const r = await post<EditResult>('/api/edit', editCtx('remove the job loss', path, [{ what: 'Buy flat: mortgage interest', value: 1.5, unit: '%/yr' }]))
    expect(r.ok, r.error).toBe(true)
    console.log('edit3 ->', JSON.stringify(r.data.path.events.map((e) => [e.type, e.amount_chf, e.annual_rate_pct])), r.data.changes)
    expect(r.data.path.events.some((e) => e.type === 'income_change')).toBe(false)
    expect(r.data.path.events.find((e) => e.type === 'buy_home')!.annual_rate_pct).toBe(1.5)
  }, 40000)

  // ---------------- the conversation endpoint: context makes the twin understand (cases from a real chat transcript)
  const STATE = {
    name: 'Alexia', age: 20, city: 'Lausanne', job_status: 'student', household: 'single', net_income_chf_per_month: 1200, rent_chf_per_month: 900, cash_chf: 8000, investments_chf: 0,
    usual_spending_without_rent_chf_per_month: 1336, spending_ups_and_downs_chf: 426, loans: [], goals: [{ goal: 'Emergency savings', target_chf: 12800, by: '2029-12' }, { goal: 'Career transition', target_chf: 39366, by: '2032-12' }],
    told_the_twin: [], if_nothing_changes: { years_simulated: 10, age_at_end: 30, net_worth_at_end_median_chf: -116100, chance_cash_below_zero_pct: 100, cash_runs_out_at_age: 20, goals: [] },
  }
  const chat = (text: string, o: { history?: { role: string; text: string }[]; paths?: unknown[]; target?: string | null; fork_from_path_id?: string } = {}) =>
    post<TurnResult>('/api/chat', { ...ctx(text), history: o.history ?? [], state: STATE, paths: o.paths ?? [], focus_path_id: null, target_path_id: o.target ?? null, fork_from_path_id: o.fork_from_path_id ?? null, compare: { A: null, B: null } })
  type Ed = TurnResult['edits'][number]
  const evOf = (e: Ed, before: { events: unknown[] }[] = []) => (e.path ? e.path.events : [...((before.find((b) => (b as { id?: string }).id === e.path_id) as { events?: TwinEvent[] } | undefined)?.events ?? []), ...(e.add_events ?? [])]) as TwinEvent[]
  const show = (l: string, r: { ms: number; data: TurnResult }) =>
    console.log(`${l} (${r.ms}ms)\n   reply: ${r.data.reply}\n   new ${r.data.new_paths.length} · edits ${JSON.stringify(r.data.edits.map((e) => [e.path_id, e.changes]))} · remove ${JSON.stringify(r.data.remove_path_ids)} · update ${JSON.stringify(r.data.profile_update)}`)
  const mansion = { id: 'p1', name: '1M job, mansion, kid', events: [{ type: 'income_change', label: '1M a year', start_month: 0, duration_months: 240, monthly_net_income_chf: 83333 }, { type: 'buy_home', label: 'Mansion', start_month: 240, amount_chf: 10000000 }, { type: 'household_change', label: 'Kid', start_month: 0, household_type: 'family' }, { type: 'recurring_expense', label: 'Kid costs', start_month: 0, monthly_amount_chf: 100000 }], net_worth_at_end_median_chf: -19520000 }

  it('chat: the NPV discount rate is set only when asked ("rate", not a rent discount, interest or inflation)', async () => {
    const no = ['what if interest rates rise to 5%?', 'I get a 20% discount on my rent from next year', 'what if inflation is 5% a year?']
    const yes: [string, number][] = [['use a 5% discount rate', 5], ["show the paths in today's money with a 2% discount rate", 2]]
    const rs = await Promise.all([...no, ...yes.map((y) => y[0])].map((q) => chat(q)))
    rs.forEach((r, i) => { expect(r.ok, r.error).toBe(true); console.log(`disc ${[...no, ...yes.map((y) => y[0])][i]} -> ${r.data.discount_rate_pct}`) })
    no.forEach((_, i) => expect(rs[i].data.discount_rate_pct ?? null).toBeNull())
    yes.forEach((y, i) => {
      const d = rs[no.length + i].data
      expect(d.discount_rate_pct).toBe(y[1])
      expect(d.new_paths.length + d.edits.length).toBe(0) // valuing paths is not a decision
    })
  }, 60000)
  it('chat: "just say hi and nothing else" -> just hi, no actions', async () => {
    const r = await chat('just say hi and nothing else', { history: [{ role: 'user', text: 'hey' }, { role: 'twin', text: "Hi! Ask me a what-if, like 'What if I do a master's?'" }] })
    show('hi', r)
    expect(r.data.new_paths.length + r.data.edits.length + r.data.remove_path_ids.length).toBe(0)
    expect(r.data.reply.length).toBeLessThan(40)
  }, 40000)
  it('chat: "what are my financials?" -> answers with her real numbers', async () => {
    const r = await chat('i mean what are my financials?', { history: [{ role: 'user', text: 'explain me my life now' }] })
    show('financials', r)
    const t = r.data.reply.replace(/[’',]/g, '')
    expect(t).toMatch(/1200/)
    expect(t).toMatch(/900/)
    expect(t).toMatch(/8000|8k/i)
    expect(r.data.new_paths.length).toBe(0)
  }, 40000)
  it('chat: "have the kid at 35 instead" -> EDITS the existing path, keeps the rest', async () => {
    const r = await chat('but i wanna have the kid at 35 instead', { history: [{ role: 'user', text: 'i wanna make 1M a year for life until 40 then buy a 10m chf mansion and have a kid who loses me 100k a month' }, { role: 'twin', text: '＋ 1M job, mansion, kid' }], paths: [mansion] })
    show('kid at 35', r)
    expect(r.data.new_paths.length).toBe(0)
    expect(r.data.edits[0]?.path_id).toBe('p1')
    const ev = evOf(r.data.edits[0], [mansion])
    expect(ev.find((e) => e.type === 'household_change')!.start_month).toBe(180)
    expect(ev.find((e) => e.type === 'recurring_expense')!.start_month).toBe(180)
    expect(ev.find((e) => e.type === 'buy_home')!.amount_chf).toBe(10000000)
    expect(ev.some((e) => (e.monthly_net_income_chf ?? 0) > 80000)).toBe(true)
  }, 40000)
  it('chat: "where\'s the 1M a year income" -> adds it to that path', async () => {
    const noIncome = { ...mansion, events: mansion.events.slice(1) }
    const r = await chat("wheres the fucking 1M a year income", { history: [{ role: 'user', text: 'i wanna make 1M a year until 40 then buy a 10m mansion and have a kid at 35' }, { role: 'twin', text: '＋ 1M job, mansion, kid' }], paths: [noIncome] })
    show('1M income', r)
    expect(r.data.edits[0]?.path_id).toBe('p1')
    expect(evOf(r.data.edits[0], [mansion]).some((e) => Math.round(e.monthly_net_income_chf ?? 0) === 83333)).toBe(true)
  }, 40000)
  it('chat: "until I buy the house it should be 2K a month" (after asking about rent) -> rent update, not saving', async () => {
    const r = await chat('until i buy the house it should be 2K a month', { history: [{ role: 'user', text: 'whats my rent' }, { role: 'twin', text: 'Your rent is 900 CHF a month.' }] })
    show('rent 2K', r)
    expect(r.data.profile_update?.monthly_rent_chf).toBe(2000)
    expect(r.data.new_paths.some((p) => p.events.some((e) => e.type === 'invest'))).toBe(false)
  }, 40000)
  it('chat: correction "I meant rent, not saving" -> removes the wrong path and fixes the rent', async () => {
    const wrong = { id: 'p2', name: 'Save 2K a month', events: [{ type: 'invest', label: 'Save 2K', start_month: 0, monthly_amount_chf: 2000 }] }
    const r = await chat('dude. i want my rent to be 2000 a month not save that much', { history: [{ role: 'user', text: 'until i buy the house it should be 2K a month' }, { role: 'twin', text: '＋ Save 2K a month: invest 2k/mo now' }], paths: [wrong] })
    show('correction', r)
    expect(r.data.remove_path_ids).toContain('p2')
    expect(r.data.profile_update?.monthly_rent_chf).toBe(2000)
  }, 40000)
  it('chat: explicit target -> edits exactly that path', async () => {
    const master = { id: 'p3', name: "Master's degree", events: [{ type: 'study', label: "Master's", start_month: 0 }] }
    const r = await chat('make it start a year later', { paths: [master, mansion], target: 'p3' })
    show('target', r)
    expect(r.data.edits[0]?.path_id).toBe('p3')
    expect(evOf(r.data.edits[0]).find((e) => e.type === 'study')!.start_month).toBe(12)
  }, 40000)

  const three = [
    { id: 'd1', name: 'Start working', events: [{ type: 'start_job', label: 'Start working', start_month: 0 }] },
    { id: 'd2', name: "Master's degree", events: [{ type: 'study', label: "Master's", start_month: 0 }] },
    { id: 'd3', name: 'Move abroad', events: [{ type: 'relocate', label: 'Move abroad', start_month: 0, city: 'abroad', monthly_net_income_chf: 3700 }] },
  ]
  it('chat: "add a house at 40 for 400k to all" -> edits EVERY path', async () => {
    const r = await chat('i wanna buy a house at 40 for 400K. add to all', { paths: three })
    show('add to all', r)
    expect(r.data.edits.map((e) => e.path_id).sort()).toEqual(['d1', 'd2', 'd3'])
    for (const e of r.data.edits) expect(evOf(e).some((x) => x.type === 'buy_home' && x.amount_chf === 400000 && x.start_month === 240)).toBe(true)
  }, 40000)
  it('chat: history claims a change that PATHS does not show -> applies it instead of saying "already done"', async () => {
    const r = await chat('[about path “Move abroad”] house for 400K at 40', { paths: three, target: 'd3', history: [{ role: 'user', text: 'i wanna buy a house at 40 for 400K. add to all' }, { role: 'twin', text: "I've added a 400K home purchase at 40 to all three paths. [no path, fact or economy was changed in this turn]" }] })
    show('claimed but not applied', r)
    expect(r.data.edits.some((e) => e.path_id === 'd3' && evOf(e).some((x) => x.type === 'buy_home'))).toBe(true)
  }, 40000)
  it('chat: "add a goal: 50k saved by 30" -> a new goal (no path)', async () => {
    const r = await chat('add a goal: i want 50k saved by 30 for a car')
    console.log('goal ->', JSON.stringify(r.data.new_goals), r.data.reply)
    expect(r.data.new_goals.length).toBe(1)
    expect(r.data.new_goals[0].target_chf).toBe(50000)
    expect(r.data.new_goals[0].by_month).toBe(120)
    expect(r.data.new_paths.length).toBe(0)
  }, 40000)
  it('chat: splits a personal decision (path) from an economy condition (macro)', async () => {
    const r = await chat("what if I do a master's and there's a recession in 2 years?")
    show('macro split', r)
    expect(r.data.new_paths.some((p) => p.events.some((e) => e.type === 'study'))).toBe(true)
    expect(r.data.new_paths.some((p) => p.events.some((e) => e.type === 'income_change' || e.type === 'market_shock'))).toBe(false)
    expect(r.data.macro_update?.preset === 'recession' || r.data.macro_update?.recession_start_month === 24).toBe(true)
  }, 40000)
  it('chat: "what if inflation hits 5%?" -> economy only, no new path', async () => {
    const r = await chat('what if inflation goes to 5% and my pay only grows 1%?')
    show('inflation', r)
    expect(r.data.new_paths.length).toBe(0)
    expect(r.data.macro_update?.inflation_pct).toBe(5)
    expect(r.data.macro_update?.wage_growth_pct).toBe(1)
  }, 40000)

  it('compare: A/B tiles + personal comparison, every number traced, the computed leaning respected, no advice words', async () => {
    const ps = presets(alexia, params)
    const side = (id: string): Side => {
      const p = ps.find((x) => x.id === id)!
      const plan = resolve(alexia, params, p.spec, {}, 120, rate)
      return { id, name: p.spec.name, spec: p.spec, plan, result: simulate(plan, params, alexia), parentName: null, madeBy: 'a ready-made button', unknownFromAge: null }
    }
    const [a, b] = [side('master'), side('work')]
    const v = verdict('Which path ends with more net worth?', { ...a, overrides: {} }, { ...b, overrides: {} }, alexia, params, 120, rate)
    const fit = goalFit(a, b, alexia)
    const facts = compareFacts({ profile: alexia, H: 120, first: a, second: b, verdict: v, fit, breakEven: v.flip && v.flip.pct > 0 ? { path: v.other.name, pct: v.flip.pct, fromAge: v.flip.fromAge } : null, economy: null, told: [] })
    const r = await post<CompareResult>('/api/compare', { facts })
    expect(r.ok, r.error).toBe(true)
    const d = r.data
    console.log(`${r.ms}ms compare:\n  A so far: ${d.first.so_far}\n  A ahead: ${d.first.ahead}\n  B so far: ${d.second?.so_far}\n  B ahead: ${d.second?.ahead}\n  vs: ${d.comparison}\n  ⚠ ${d.caveat}`)
    expect(d.second).not.toBeNull()
    const all = [d.first.so_far, d.first.ahead, d.second!.so_far, d.second!.ahead, d.comparison, d.caveat].join(' ')
    expect(verifyNumbers(all, facts).unmatched).toEqual([])
    expect(d.comparison).toContain(facts.comparison!.fits_goals_better)
    expect(all).not.toMatch(/you should|we recommend|guaranteed|best choice/i)
  }, 40000)
  it('compare: one path only -> its story, no comparison', async () => {
    const plan = resolve(alexia, params, { name: 'If nothing changes', catalog_id: null, events: [] }, {}, 120, rate)
    const s: Side = { id: 'today', name: 'If nothing changes', spec: { name: 'If nothing changes', catalog_id: null, events: [] }, plan, result: simulate(plan, params, alexia), parentName: null, madeBy: 'the data', unknownFromAge: null }
    const facts = compareFacts({ profile: alexia, H: 120, first: s, second: null, verdict: null, fit: null, breakEven: null, economy: null, told: [] })
    const r = await post<CompareResult>('/api/compare', { facts })
    expect(r.ok, r.error).toBe(true)
    console.log(`${r.ms}ms solo: ${r.data.first.so_far} | ${r.data.first.ahead}`)
    expect(r.data.second).toBeNull()
    expect(verifyNumbers(`${r.data.first.so_far} ${r.data.first.ahead} ${r.data.caveat}`, facts).unmatched).toEqual([])
  }, 40000)
  it('compare: texts talk about what IS on a path, never "there is no home purchase" (several pairs)', async () => {
    const ps = presets(alexia, params)
    const side = (id: string): Side => {
      const spec = id === 'today' ? { name: 'If nothing changes', catalog_id: null, events: [] } : ps.find((x) => x.id === id)!.spec
      const plan = resolve(alexia, params, spec, {}, 120, rate)
      return { id, name: spec.name, spec, plan, result: simulate(plan, params, alexia), parentName: null, madeBy: id === 'today' ? 'the data' : 'a ready-made button', unknownFromAge: null }
    }
    // "absence" sentences the user found useless: only what exists may be described
    const ABSENT = /\bno (home|house|flat|property|apartment|purchase|loans?|debts?|mortgage|unknowns?)\b|\b(not|n't|never) (buy|bought|buying|purchas)\w*|without (buying|a (home|house|flat|purchase))|\bnothing (here |on this path )?depends on unknown|\b(does not|doesn't) depend on (any )?unknown/i
    const pairs: [string, string | null][] = [['work', 'master'], ['work', 'abroad'], ['today', 'work'], ['master', 'abroad'], ['abroad', null]]
    const bad: string[] = []
    await Promise.all(pairs.map(async ([x, y]) => {
      const a = side(x)
      const b = y ? side(y) : null
      const v = b ? verdict('Which path ends with more net worth?', { ...a, overrides: {} }, { ...b, overrides: {} }, alexia, params, 120, rate) : null
      const facts = compareFacts({ profile: alexia, H: 120, first: a, second: b, verdict: v, fit: b ? goalFit(a, b, alexia) : null, breakEven: v?.flip && v.flip.pct > 0 ? { path: v.other.name, pct: v.flip.pct, fromAge: v.flip.fromAge } : null, economy: null, told: [] })
      expect(JSON.stringify(facts)).not.toMatch(/"home_or_asset_purchases":\[\]|"depends_on_unknown_numbers":\[\]|"warnings":\[\]/) // empty lists are not sent
      const r = await post<CompareResult>('/api/compare', { facts })
      expect(r.ok, r.error).toBe(true)
      const d = r.data
      const texts = [d.first.so_far, d.first.ahead, d.second?.so_far ?? '', d.second?.ahead ?? '', d.comparison, d.caveat]
      for (const s of texts.join(' ').split(/(?<=[.!?])\s+/)) if (ABSENT.test(s)) bad.push(`${x}/${y}: ${s}`)
    }))
    if (bad.length) console.log(bad.join('\n'))
    expect(bad).toEqual([])
  }, 90000)
  it('chat: fork_from_path_id -> a NEW branch that keeps the parent decisions', async () => {
    const work = { id: 'p1', name: 'Start working', parent_id: 'today', events: [{ type: 'start_job', label: 'Start working', start_month: 0 }], net_worth_at_end_median_chf: 745000 }
    const r = await chat('then buy a flat for 400k at 28', { fork_from_path_id: 'p1', paths: [work] })
    show('fork', r)
    expect(r.data.edits.length).toBe(0)
    expect(r.data.new_paths.length).toBe(1)
    const evs = r.data.new_paths[0].events
    // either it names the parent (the app copies its events) or it copied them itself
    expect(r.data.new_paths[0].parent_id === 'p1' || evs.some((e) => e.type === 'start_job')).toBe(true)
    expect(evs.some((e) => e.type === 'buy_home' && e.amount_chf === 400000 && e.start_month === 96)).toBe(true)
  }, 40000)
  // ---------------- from a real transcript: bulk requests must work (no refusal, no truncation, no fake "unsupported")
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Path ${i + 1}`, parent_id: i < 3 ? 'today' : `p${(i % 3) + 1}`, events: [{ type: 'start_job', label: 'Job', start_month: 0 }, ...(i >= 3 ? [{ type: 'invest', label: `Invest ${i}`, start_month: 12 * (i % 5), monthly_amount_chf: 100 * i }] : [])], net_worth_at_end_median_chf: 700000 + 1000 * i }))
  it('chat: "add 10 random paths" -> makes them (decisions only), no refusal, nothing "unsupported"', async () => {
    const r = await chat('add 10 random paths lol')
    show('10 random', r)
    expect(r.ok, r.error).toBe(true)
    expect(r.data.new_paths.length).toBeGreaterThanOrEqual(8)
    expect(r.data.unsupported.join(' ')).not.toMatch(/random/i)
  }, 130000)
  it('chat: "add a flat at 30 to all of them" with 13 paths -> one short edit per path, not cut off', async () => {
    const paths = many(13)
    const r = await chat('add a flat for 500k at 30 to all of them', { paths })
    show('13 edits', r)
    expect(r.ok, r.error).toBe(true)
    expect(new Set(r.data.edits.map((e) => e.path_id)).size).toBeGreaterThanOrEqual(12)
    for (const e of r.data.edits) expect(evOf(e, paths).some((x) => x.type === 'buy_home' && x.amount_chf === 500000)).toBe(true)
  }, 130000)
  it('chat: "branch each of them out" -> branches name their parent and stay short', async () => {
    const paths = many(4)
    const r = await chat('branch each of these out with 2 more ideas', { paths })
    show('branch out', r)
    expect(r.ok, r.error).toBe(true)
    expect(r.data.new_paths.length).toBeGreaterThanOrEqual(6)
    expect(r.data.new_paths.filter((p) => p.parent_id && paths.some((x) => x.id === p.parent_id)).length).toBeGreaterThanOrEqual(6)
    expect(r.data.horizon_years ?? null).toBeNull()
  }, 130000)
  // ---------------- a REAL conversation (Nov 2026), replayed turn by turn with the app's own rules, then simulated
  describe('conversation: house, master\'s, "assume I had a house", undo, gifted', () => {
    type P = { id: string; name: string; parentId: string | null; events: TwinEvent[]; history: TwinEvent[][]; lastChange: string[] | null }
    let prof: Profile = { ...alexia }
    let paths: P[] = []
    const hist: { role: string; text: string }[] = []
    let n = 1
    const stateOf = () => ({
      name: prof.name, age: prof.age, city: prof.city, job_status: prof.status, household: prof.household, net_income_chf_per_month: prof.income, rent_chf_per_month: prof.rent, cash_chf: prof.cash,
      investments_chf: prof.investments, home_already_owned_chf: prof.home ?? 0, minimum_cash_floor_chf: prof.minCash ?? null, usual_spending_without_rent_chf_per_month: Math.round(prof.calib.other_mu),
      goals: prof.goals.map((g) => ({ goal: g.name, target_chf: g.target, by: g.date.slice(0, 7) })),
    })
    const nw0 = (p: Profile, evs: TwinEvent[] = []) => simulate(resolve(p, params, { name: 'x', catalog_id: null, events: evs }, {}, 120, rate), params, p).nw[0].p50
    const end = (p: Profile, evs: TwinEvent[]) => simulate(resolve(p, params, { name: 'x', catalog_id: null, events: evs }, {}, 120, rate), params, p).endNW.p50
    /** one turn, applied exactly like App.tsx does */
    async function turn(text: string) {
      const r = await post<TurnResult>('/api/chat', { ...ctx(text, prof), history: hist.slice(-12), state: stateOf(), paths: paths.map((p) => ({ id: p.id, name: p.name, parent_id: p.parentId, events: p.events, last_change: p.lastChange ? { changes: p.lastChange } : null, can_undo: p.history.length > 0, undo_would_restore: p.history.length ? p.history.at(-1) : null })), focus_path_id: null, target_path_id: null, fork_from_path_id: null, compare: { A: null, B: null } })
      expect(r.ok, r.error).toBe(true)
      const d = r.data
      show(`turn "${text.slice(0, 40)}"`, r)
      if (r.data.undo_path_ids?.length) console.log(`   undo ${JSON.stringify(r.data.undo_path_ids)}`)
      const u = d.profile_update
      if (u) prof = { ...prof, income: u.monthly_net_income_chf ?? prof.income, rent: u.monthly_rent_chf ?? prof.rent, cash: u.cash_chf ?? prof.cash, home: u.home_value_chf ?? prof.home, minCash: u.min_cash_chf ?? prof.minCash }
      for (const id of d.undo_path_ids ?? []) {
        const p = paths.find((x) => x.id === id)
        if (p?.history.length) {
          p.events = p.history.pop()!
          p.lastChange = null
        }
      }
      for (const ed of d.edits) {
        const p = paths.find((x) => x.id === ed.path_id)
        if (!p) continue
        p.history.push(p.events)
        p.events = ed.path ? (ed.path.events as TwinEvent[]) : addEvents(p.events, (ed.add_events ?? []) as TwinEvent[])
        p.lastChange = ed.changes
      }
      paths = paths.filter((p) => !d.remove_path_ids.includes(p.id))
      for (const np of d.new_paths) {
        const parent = np.parent_id ? paths.find((x) => x.id === np.parent_id) : undefined
        paths.push({ id: `p${n++}`, name: np.name, parentId: parent?.id ?? 'today', events: [...(parent?.events ?? []), ...(np.events as TwinEvent[])], history: [], lastChange: null })
      }
      hist.push({ role: 'user', text }, { role: 'twin', text: d.reply })
      return d
    }
    const homeAt = (p: P) => p.events.filter((e) => e.type === 'buy_home').map((e) => e.start_month ?? 0)

    it('1) "buy a house 2 yrs later with minimum wage… or a master\'s first?" -> two paths (home at 22, master\'s)', async () => {
      await turn('buy a house 2 yrs later with minimum wage, do i die of hunger or not? should i do a masters first instead and fint a job later?')
      expect(paths.some((p) => homeAt(p).includes(24))).toBe(true)
      expect(paths.some((p) => p.events.some((e) => e.type === 'study'))).toBe(true)
    }, 130000)
    it('1b) no price was given -> the twin says so; "the house costs 300k" -> priced, the result changes', async () => {
      const home = paths.find((p) => homeAt(p).includes(24))!
      const before = end(prof, home.events)
      await turn('the house costs 300k')
      expect(home.events.find((e) => e.type === 'buy_home')!.amount_chf).toBe(300000)
      expect(end(prof, home.events)).not.toBeCloseTo(before, -2) // the graph updates
    }, 130000)
    it('2) "actually i wanna buy the home in 5 years" -> the house moves to 25, nothing is added, result recomputes', async () => {
      // "the home" is ambiguous when two paths buy one at 22: either may move, but at least one must, and no house may be added
      const before = paths.map((p) => end(prof, p.events))
      const houses = paths.map((p) => homeAt(p).length)
      const count = paths.length
      await turn('actually i wanna buy the home in 5 years')
      expect(paths.length).toBe(count)
      expect(paths.some((p) => homeAt(p).includes(60))).toBe(true)
      expect(paths.map((p) => homeAt(p).length)).toEqual(houses)
      expect(paths.some((p, i) => Math.abs(end(prof, p.events) - before[i]) > 100)).toBe(true) // the graph updates
    }, 130000)
    it('3) "assume I have a house for the baseline, worth 200k" -> a fact about today: no path touched, net worth +200k', async () => {
      const snapshot = JSON.stringify(paths.map((p) => p.events))
      const nwBefore = nw0(prof)
      await turn('assume i have a house for the baseline. worth 200k')
      expect(prof.home).toBe(200000)
      expect(JSON.stringify(paths.map((p) => p.events))).toBe(snapshot)
      expect(nw0(prof) - nwBefore).toBeCloseTo(200000, -3)
    }, 130000)
    it('4) a wrong edit, then "I didn\'t want any changes to the others" -> the twin restores it exactly', async () => {
      // replay the mistake from the real chat: the twin had changed the home path instead of the baseline
      const home = paths.find((p) => homeAt(p).length)!
      const original = JSON.stringify(home.events)
      home.history.push(home.events)
      home.events = [...home.events.filter((e) => e.type !== 'buy_home'), { ...home.events[0], type: 'buy_home', label: 'Home 200k', start_month: 0, amount_chf: 200000, duration_months: null, down_payment_pct: 100 } as TwinEvent]
      home.lastChange = ['removed the separate home purchase at 25', 'home worth 200k now owned from the start (age 20)']
      hist.push({ role: 'user', text: 'assume i have a house at the start' }, { role: 'twin', text: `[actions applied: ✏️ Changed ${home.name}: ✓ removed the separate home purchase at 25 ✓ home worth 200k now owned from the start]` })
      await turn('i meant assume i had a house at the very start, at 20. i didnt want any changes to the others')
      expect(JSON.stringify(home.events)).toBe(original)
      expect(prof.home).toBe(200000)
    }, 130000)
    it('5) "it was free for me, say gifted" -> still owned (net worth keeps the 200k), no purchase added anywhere', async () => {
      const buys = paths.map((p) => homeAt(p).length)
      await turn('it was free for me, say gifted')
      expect(prof.home).toBe(200000)
      expect(paths.map((p) => homeAt(p).length)).toEqual(buys)
      expect(nw0(prof)).toBeGreaterThan(200000)
    }, 130000)
    it('6) "I never want my savings below 5k" -> a cash floor (a constraint), not a path', async () => {
      const count = paths.length
      await turn('also, I never want my savings to go below 5k')
      expect(prof.minCash).toBe(5000)
      expect(paths.length).toBe(count)
    }, 130000)
  })
  // ---------------- from two real chats (Nov 2026): raises that compound, chains of nodes, investment returns, selling
  it('chat: "+2% raise every year for 10 years" -> compounds to ×1.02^10 by 30', async () => {
    const r = await chat('add a path where I start working now and get a 2% raise every year for 10 years')
    show('yearly raise', r)
    const evs = r.data.new_paths[0].events as TwinEvent[]
    const inc = resolve(alexia, params, { name: 'r', catalog_id: null, events: evs }, {}, 120, rate).income
    expect(inc[119] / inc[0]).toBeGreaterThan(Math.pow(1.02, 9) - 0.01) // at least 9-10 compounding raises
  }, 60000)
  it('chat: "add 3 nodes one after another, each a further 2% raise" -> a real chain (new:0, new:1)', async () => {
    const raise = { id: 'p1', name: '+2% raise', parent_id: 'today', events: [{ type: 'income_change', label: '+2% raise', start_month: 12, income_change_pct: 2 }] }
    const r = await chat('chain 3 more nodes after the raise path, one after another, each one year later with another +2% raise', { paths: [raise] })
    show('chain', r)
    const np = r.data.new_paths
    expect(np.length).toBe(3)
    expect(np[0].parent_id).toBe('p1')
    expect(np[1].parent_id).toBe('new:0')
    expect(np[2].parent_id).toBe('new:1')
  }, 60000)
  it('chat: "invest 200 a month with 7% return" -> an invest event + the return as an economy condition (not lost)', async () => {
    const zurich = { id: 'p1', name: 'Move to Zurich', parent_id: 'today', events: [{ type: 'relocate', label: 'Move to Zurich', start_month: 12, city: 'Zurich' }] }
    const r = await chat('to my current branch add 200 a month investing, with 7% return annually', { paths: [zurich], target: 'p1' })
    show('invest 7%', r)
    expect(r.data.macro_update?.market_return_pct).toBe(7)
    const e = r.data.edits.find((x) => x.path_id === 'p1')!
    expect(evOf(e, [zurich]).some((x) => x.type === 'invest' && x.monthly_amount_chf === 200)).toBe(true)
  }, 60000)
  it('chat: "invest 300 a month, then sell 5k of it at 25" -> a negative invest (back to cash)', async () => {
    const r = await chat('what if I invest 300 a month from now, and then sell 5k of those investments at 25?')
    show('sell', r)
    const evs = r.data.new_paths.flatMap((p) => p.events)
    expect(evs.some((x) => x.type === 'invest' && x.monthly_amount_chf === 300)).toBe(true)
    const sale = evs.find((x) => x.type === 'invest' && (x.amount_chf ?? 0) < 0)!
    expect(sale.amount_chf).toBe(-5000)
    expect(sale.start_month).toBe(60)
  }, 60000)
  // ---------------- from two more real chats (Nov 2026): honesty about effects, starting salaries, best branch, long messages
  const work3 = { id: 'p1', name: 'Start working', parent_id: 'today', events: [{ type: 'start_job', label: 'Start working', start_month: 0 }], net_worth_at_end_median_chf: 745000 }
  const masters = { id: 'p2', name: "Master's degree", parent_id: 'today', events: [{ type: 'study', label: "Master's", start_month: 0 }], net_worth_at_end_median_chf: 557000 }
  it('chat: "Can I reach my emergency savings goal by 2029 if I invest 100 a month?" -> builds the path (no refusal)', async () => {
    const r = await chat('Can I reach my emergency savings goal by 2029 if I invest 100 a month?')
    show('goal question', r)
    expect(r.data.new_paths.flatMap((p) => p.events).some((e) => e.type === 'invest' && e.monthly_amount_chf === 100)).toBe(true)
  }, 60000)
  it('chat: "starting salary 3000 on all" -> on the master\'s it starts AFTER the degree, not at 20', async () => {
    const r = await chat('starting salary 3000 a month on all paths', { paths: [work3, masters] })
    show('starting salary', r)
    const m = r.data.edits.find((e) => e.path_id === 'p2')!
    const job = evOf(m, [masters]).find((e) => e.type === 'start_job')!
    expect(job.monthly_net_income_chf).toBe(3000)
    expect(job.start_month).toBeGreaterThanOrEqual(24)
  }, 60000)
  it('chat: a bare "3000" right after "starting salary 2000 on all" -> it ACTS (no "done" without a change)', async () => {
    const p1 = { ...work3, events: [{ type: 'start_job', label: 'Start working', start_month: 0, monthly_net_income_chf: 2000 }] }
    const r = await chat('3000', { paths: [p1], history: [{ role: 'user', text: 'starting salary 2000 a month on all' }, { role: 'twin', text: 'Added a starting salary of 2,000 a month. [actions applied: ✏️ Changed Start working: ✓ salary 2000/month]' }] })
    show('3000', r)
    expect(r.data.edits.length + (r.data.profile_update?.monthly_net_income_chf != null ? 1 : 0)).toBeGreaterThan(0)
  }, 60000)
  it('chat: "salary 5K" then "baseline" -> a fact about today (income 5000)', async () => {
    const r = await chat('baseline', { paths: [work3], history: [{ role: 'user', text: 'salary 5K' }, { role: 'twin', text: 'Got it — 5,000 a month. Which path should I put it on: Start working, or all of them? [no path, fact or economy was changed in this turn]' }] })
    show('baseline', r)
    expect(r.data.profile_update?.monthly_net_income_chf).toBe(5000)
    expect(r.data.edits.length).toBe(0)
  }, 60000)
  it('chat: "what\'s the best branch?" when the baseline ends highest -> the answer includes the baseline', async () => {
    const st = { ...STATE, net_income_chf_per_month: 5000, if_nothing_changes: { years_simulated: 10, age_at_end: 30, net_worth_at_end_median_chf: 340000, chance_cash_below_zero_pct: 0, cash_runs_out_at_age: null, goals: [] },
      all_paths_ranked_by_net_worth_at_end: [{ rank: 1, path: 'BASELINE (if nothing changes)', net_worth_at_end_median_chf: 340000, chance_cash_below_zero_pct: 0 }, { rank: 2, path: 'Start working', net_worth_at_end_median_chf: 118000, chance_cash_below_zero_pct: 0 }, { rank: 3, path: "Master's degree", net_worth_at_end_median_chf: 102000, chance_cash_below_zero_pct: 0 }] }
    const r = await post<TurnResult>('/api/chat', { ...ctx('whats the best branch out of all'), history: [], state: st, paths: [{ ...work3, net_worth_at_end_median_chf: 118000 }, { ...masters, net_worth_at_end_median_chf: 102000 }], focus_path_id: null, target_path_id: null, fork_from_path_id: null, compare: { A: null, B: null } })
    show('best', r)
    expect(r.data.reply).toMatch(/baseline|nothing changes|if nothing/i)
    expect(r.data.reply).toMatch(/340/)
  }, 60000)
  it('chat: investing that cannot happen -> "can I invest successfully now?" is answered NO, with a way to make it possible', async () => {
    const inv = { id: 'p1', name: 'Invest 2000/month', parent_id: 'today', events: [{ type: 'invest', label: 'Invest', start_month: 0, monthly_amount_chf: 2000 }], net_worth_at_end_median_chf: -116000, planned_investing_skipped_pct: 100, chance_cash_below_zero_pct: 100 }
    const r = await chat('so can i invest successfully now?', { paths: [inv] })
    show('invest blocked', r)
    expect(r.data.reply).toMatch(/\bno\b|not|can't|cannot|isn't|won't/i)
    expect(r.data.reply).not.toMatch(/builds up nicely|works well|you can invest successfully/i)
  }, 60000)
  it('chat: "how much do I have to make to pay the down payment?" -> quotes the engine\'s income_needed', async () => {
    const home = { id: 'p1', name: 'Buy a home at 40', parent_id: 'today', events: [{ type: 'buy_home', label: 'Home', start_month: 240, amount_chf: 300000, down_payment_pct: 100 }], net_worth_at_end_median_chf: 140000, home_down_payment_missing_pct: [100], income_needed: { income_change_needed_pct: 210, monthly_income_needed_now_chf: 3720, meaning: 'smallest income (in every month) for which cash never goes below zero on this path' } }
    const r = await chat('how much do i have to make to be able to pay the downpayment', { paths: [home] })
    show('income needed', r)
    expect(r.data.reply).toMatch(/3[’',.]?720|3[.,]7\s?k/)
  }, 60000)
  it('chat: "my income decreases by 20% each year for 2 years" -> two compounding cuts (× 0.64)', async () => {
    const r = await chat('add a path: my income decreases by 20% each year for 2 years')
    show('cuts', r)
    const evs = r.data.new_paths[0].events as TwinEvent[]
    const inc = resolve(alexia, params, { name: 'c', catalog_id: null, events: evs }, {}, 120, rate).income
    expect(inc[30] / alexia.income).toBeCloseTo(0.64, 2)
  }, 60000)
  it('chat: a long, five-part message -> every part lands in the right place', async () => {
    const r = await chat("ok so, a few things. I'm now earning 2,800 net and my rent went up to 1,100. Add two paths: first, a part-time master's at 21 while I keep working at 60%; second, I move to Zurich at 23 and buy a flat for 600k at 30 with 20% down. Also add a goal of 30k saved by 28, and assume a recession in 3 years. Which one looks riskier?")
    show('long', r)
    expect(r.data.profile_update?.monthly_net_income_chf).toBe(2800)
    expect(r.data.profile_update?.monthly_rent_chf).toBe(1100)
    expect(r.data.new_paths.length).toBe(2)
    const flat = r.data.new_paths.flatMap((p) => p.events).find((e) => e.type === 'buy_home')!
    expect(flat.amount_chf).toBe(600000)
    expect(flat.start_month).toBe(120)
    expect(r.data.new_goals.some((g) => g.target_chf === 30000 && g.by_month === 96)).toBe(true)
    expect(r.data.macro_update?.preset === 'recession' || r.data.macro_update?.recession_start_month === 36).toBe(true)
  }, 90000)
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
