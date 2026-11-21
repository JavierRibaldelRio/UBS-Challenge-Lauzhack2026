// End-to-end test WITH the real LLM: question -> /api/parse -> resolver -> Monte Carlo -> facts -> /api/explain -> number check.
// Needs the backend running with a key:  cd backend && pnpm start   then   cd frontend && pnpm test:live
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { breakEven, buildFacts, drivers, verifyNumbers } from '../lib/analysis'
import { answerFacts, verdict } from '../lib/answer'
import { cities, medianLoanRate, presets, resolve } from '../lib/resolve'
import { simulate } from '../lib/sim'
import type { AnswerResult, EditResult, ExplainResult, Params, ParseResult, Profile, TurnResult, TwinEvent } from '../lib/types'

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
  const chat = (text: string, o: { history?: { role: string; text: string }[]; paths?: unknown[]; target?: string | null } = {}) =>
    post<TurnResult>('/api/chat', { ...ctx(text), history: o.history ?? [], state: STATE, paths: o.paths ?? [], focus_path_id: null, target_path_id: o.target ?? null })
  const show = (l: string, r: { ms: number; data: TurnResult }) =>
    console.log(`${l} (${r.ms}ms)\n   reply: ${r.data.reply}\n   new ${r.data.new_paths.length} · edits ${JSON.stringify(r.data.edits.map((e) => [e.path_id, e.changes]))} · remove ${JSON.stringify(r.data.remove_path_ids)} · update ${JSON.stringify(r.data.profile_update)}`)
  const mansion = { id: 'p1', name: '1M job, mansion, kid', events: [{ type: 'income_change', label: '1M a year', start_month: 0, duration_months: 240, monthly_net_income_chf: 83333 }, { type: 'buy_home', label: 'Mansion', start_month: 240, amount_chf: 10000000 }, { type: 'household_change', label: 'Kid', start_month: 0, household_type: 'family' }, { type: 'recurring_expense', label: 'Kid costs', start_month: 0, monthly_amount_chf: 100000 }], net_worth_at_end_median_chf: -19520000 }

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
    const ev = r.data.edits[0].path.events
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
    expect(r.data.edits[0].path.events.some((e) => Math.round(e.monthly_net_income_chf ?? 0) === 83333)).toBe(true)
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
    expect(r.data.edits[0].path.events.find((e) => e.type === 'study')!.start_month).toBe(12)
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
    for (const e of r.data.edits) expect(e.path.events.some((x) => x.type === 'buy_home' && x.amount_chf === 400000 && x.start_month === 240)).toBe(true)
  }, 40000)
  it('chat: history claims a change that PATHS does not show -> applies it instead of saying "already done"', async () => {
    const r = await chat('[about path “Move abroad”] house for 400K at 40', { paths: three, target: 'd3', history: [{ role: 'user', text: 'i wanna buy a house at 40 for 400K. add to all' }, { role: 'twin', text: "I've added a 400K home purchase at 40 to all three paths. [no path, fact or economy was changed in this turn]" }] })
    show('claimed but not applied', r)
    expect(r.data.edits.some((e) => e.path_id === 'd3' && e.path.events.some((x) => x.type === 'buy_home'))).toBe(true)
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
