import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnswerCard } from './components/Answer'
import { Chat, type ChatLine, type ChatMsg } from './components/Chat'
import { EconomyBar } from './components/Economy'
import { applyMacroUpdate, BASE_MACRO, describeMacro, MACRO_PRESETS, type Macro } from './lib/macro'
import { ProjectionChart, type Marker } from './components/Chart'
import { AssumptionList, Drivers } from './components/Details'
import { HowMade, type HowMadeContent } from './components/HowMade'
import { OutcomeCard } from './components/Outcome'
import { PathEditor, type PathEdit } from './components/PathEditor'
import { TrustDetails, TrustSummary } from './components/Trust'
import { breakEven, buildFacts, drivers, templateExplanation, verifyNumbers } from './lib/analysis'
import { answerFacts, templateAnswer, verdict as computeVerdict, type ComparedPath } from './lib/answer'
import { apiAnswer, apiChat, apiExplain, apiHealth } from './lib/api'
import { offlineParse } from './lib/fallback'
import { chf, chfk, monthIndex } from './lib/fmt'
import { cities, describeSpec, medianLoanRate, presets, resolve, type Overrides, type Preset } from './lib/resolve'
import { checks, runPath, simulate } from './lib/sim'
import { suggestQuestions } from './lib/suggest'
import { downloadJson, scenarioReport } from './lib/report'
import type { AnswerResult, ExplainResult, Origin, Params, ParseResult, Profile, ProfileUpdate, PromptInfo, ScenarioSpec, TwinEvent } from './lib/types'
import { unknownImpact } from './lib/unknowns'
import paramsJson from './model/params.json'
import profilesJson from './model/profiles.json'

const COLORS = ['#64748b', '#2563eb', '#e11d48', '#059669', '#7c3aed', '#d97706', '#0891b2']
type Version = { spec: ScenarioSpec; overrides: Overrides }
type NewMsg = ChatMsg extends infer T ? (T extends ChatMsg ? Omit<T, 'id'> : never) : never
type PathState = { id: string; spec: ScenarioSpec; overrides: Overrides; color: string; origin: Origin; history: Version[]; edits: PathEdit[] }
const TODAY = (): PathState => ({ id: 'today', spec: { name: 'If nothing changes', catalog_id: null, events: [] }, overrides: {}, color: COLORS[0], origin: { kind: 'today' }, history: [], edits: [] })
const colorOf = (id: string) => COLORS[((Number(id.replace(/\D/g, '')) - 1) % (COLORS.length - 1)) + 1]
const fromPreset = (p: Preset): Origin => ({ kind: 'preset', button: p.label, desc: p.desc })

// icons for life events (chart markers + card timelines)
const ICON: Record<string, string> = { start_job: '💼', study: '🎓', relocate: '🚚', income_change: '📉', household_change: '👶', recurring_expense: '🔁', one_off: '💸', invest: '📈', market_shock: '📉', take_loan: '🏦', buy_home: '🏠', buy_asset: '🚗' }
const iconOf = (e: TwinEvent) => (e.type === 'household_change' && e.household_type === 'couple' ? '💑' : e.type === 'income_change' && (e.income_change_pct ?? 0) > 0 ? '📈' : e.type === 'one_off' && (e.amount_chf ?? 0) < 0 ? '🎁' : ICON[e.type])
const sortedEvents = (spec: ScenarioSpec) => [...spec.events].sort((a, b) => (a.start_month ?? 0) - (b.start_month ?? 0))
function markersFor(spec: ScenarioSpec, H: number): Marker[] {
  return sortedEvents(spec)
    .map((e) => ({ month: Math.max(0, Math.min(H - 1, e.start_month ?? 0)), icon: iconOf(e), text: e.label }))
    .filter((m) => m.month > 0) // events "now" sit on the axis
}

/** The twin's memory: facts the person told it about TODAY. Applied on top of the data, in order. */
type TwinUpdate = { id: number; said: string; update: ProfileUpdate }
function applyUpdates(p: Profile, ups: TwinUpdate[]): Profile {
  let q = p
  for (const { update: u } of ups) {
    q = {
      ...q,
      income: u.monthly_net_income_chf ?? q.income,
      rent: u.monthly_rent_chf ?? q.rent,
      cash: u.cash_chf ?? q.cash,
      investments: u.investments_chf ?? q.investments,
      calib: u.monthly_spending_chf != null ? { ...q.calib, other_mu: u.monthly_spending_chf } : q.calib,
    }
  }
  return q
}
/** keep where a preset's numbers came from, if the AI kept the event unchanged */
function keepSources(oldSpec: ScenarioSpec, next: ScenarioSpec): ScenarioSpec {
  const key = (e: TwinEvent) => JSON.stringify({ ...e, label: '', _source: undefined })
  const src = new Map(oldSpec.events.filter((e) => e._source).map((e) => [key(e), e._source]))
  return { ...next, events: next.events.map((e) => (src.has(key(e)) ? { ...e, _source: src.get(key(e)) } : e)) }
}

type Explain = { status: 'loading' | 'ai' | 'offline'; data: ExplainResult; model?: string; cached?: boolean; error?: string; verify?: { total: number; unmatched: string[] }; prompt?: PromptInfo; ms?: number }

// Model artifacts are bundled (built by ml/train.py) -> no runtime fetch that could fail during a demo.
export default function App() {
  return <Twin params={paramsJson as unknown as Params} profiles={profilesJson as unknown as Profile[]} />
}

function Twin({ params, profiles }: { params: Params; profiles: Profile[] }) {
  const [profileId, setProfileId] = useState('P00001')
  const [updates, setUpdates] = useState<TwinUpdate[]>([])
  const dataProfile = profiles.find((p) => p.id === profileId) ?? profiles[0]
  const profile = useMemo(() => applyUpdates(dataProfile, updates), [dataProfile, updates])
  const [years, setYears] = useState(10)
  const [macro, setMacro] = useState<Macro>(BASE_MACRO) // the economy: shared by every path
  const H = years * 12
  const [paths, setPaths] = useState<PathState[]>([TODAY()])
  const [baselineId, setBaselineId] = useState('today')
  const [focusId, setFocusId] = useState('today')
  const [metric, setMetric] = useState<'nw' | 'cash'>('nw')
  const [asking, setAsking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null) // chat replies edit this path instead of asking something new
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const msgId = useRef(1)
  const chatRef = useRef<HTMLDivElement>(null)
  const [llm, setLlm] = useState<{ model: string } | null | undefined>(undefined)
  const [explain, setExplain] = useState<Explain | null>(null)
  const [howMade, setHowMade] = useState<HowMadeContent | null>(null)
  const [asked, setAsked] = useState<{ question: string; ids: string[]; msg: number } | null>(null)
  const [answer, setAnswer] = useState<{ status: 'loading' | 'ai' | 'offline'; data: AnswerResult | null; prompt?: PromptInfo; model?: string; ms?: number; verify?: { total: number; unmatched: string[] } } | null>(null)
  const examples = useMemo(() => suggestQuestions(profile, params), [profile, params])
  const nextId = useRef(1)
  const updId = useRef(1)
  const loanRate = useMemo(() => medianLoanRate(profiles), [profiles])
  const cityList = useMemo(() => cities(params), [params])
  const quick = useMemo(() => presets(profile, params), [profile, params])

  useEffect(() => {
    apiHealth().then((h) => setLlm(h.ok ? h.llm : null))
  }, [])

  // ------------------------------------------------------------ chat helpers
  const say = (m: NewMsg) => {
    const id = msgId.current++
    setMessages((ms) => [...ms, { ...m, id } as ChatMsg])
    return id
  }
  const replace = (id: number, m: Partial<ChatMsg>) => setMessages((ms) => ms.map((x) => (x.id === id ? ({ ...x, ...m } as ChatMsg) : x)))
  const welcome: ChatMsg = {
    id: 0,
    role: 'twin',
    lines: [
      { text: `Hi, I'm ${dataProfile.name}'s financial twin. I start from UBS's data about ${dataProfile.name} (age ${dataProfile.age}, ${dataProfile.city}, income, rent, savings, goals) and learned ${dataProfile.name}'s spending habits from 24 months of bank history.` },
      { text: 'Ask me “what if…”, tell me what changed today (“I now earn 1,500”), or add a ready-made path below.' },
    ],
  }
  const thread = [welcome, ...messages]

  const reset = (id: string, next: PathState[] = [TODAY()], base = 'today', focus = 'today') => {
    setProfileId(id)
    setMacro(BASE_MACRO)
    setUpdates([])
    setPaths(next)
    setBaselineId(base)
    setFocusId(focus)
    setExplain(null)
    setAsked(null)
    setAnswer(null)
    setTarget(null)
    setMessages([])
  }
  const addPaths = useCallback((specs: ScenarioSpec[], origin: Origin) => {
    const added: PathState[] = specs.map((spec) => {
      const n = nextId.current++
      return { id: `p${n}`, spec, overrides: {}, color: colorOf(`p${n}`), origin, history: [], edits: [] }
    })
    setPaths((ps) => [...ps, ...added])
    if (added.length) setFocusId(added[added.length - 1].id)
    return added.map((a) => a.id)
  }, [])

  // The challenge's own example: Alexia — start working (baseline) vs master's vs move abroad
  const loadDemo = useCallback(() => {
    const alexia = profiles.find((p) => p.id === 'P00001')!
    const ps = presets(alexia, params)
    const pick = (id: string, i: number): PathState => {
      const p = ps.find((x) => x.id === id)!
      return { id: `d${i}`, spec: p.spec, overrides: {}, color: COLORS[i], origin: fromPreset(p), history: [], edits: [] }
    }
    setYears(10)
    reset('P00001', [TODAY(), pick('work', 1), pick('master', 2), pick('abroad', 3)], 'd1', 'd2')
  }, [profiles, params])
  useEffect(() => {
    if (new URLSearchParams(location.search).has('demo')) loadDemo()
  }, [loadDemo])

  // ------------------------------------------------------------ compute (pure, fast, deterministic)
  const computed = useMemo(
    () =>
      paths.map((p) => {
        const plan = resolve(profile, params, p.spec, p.overrides, H, loanRate, macro)
        return { ...p, name: p.spec.name, plan, result: simulate(plan, params, profile), isBaseline: p.id === baselineId, unknown: unknownImpact(p.spec, p.overrides, plan, profile, params, H, loanRate, macro) }
      }),
    [paths, profile, params, H, loanRate, baselineId, macro],
  )
  const baseline = computed.find((c) => c.isBaseline) ?? computed[0]
  const focus = computed.find((c) => c.id === focusId) ?? baseline
  const today = computed.find((c) => c.id === 'today') ?? computed[0]
  const drv = useMemo(() => drivers(focus.plan, params), [focus, params])
  const be = useMemo(() => (focus.id !== baseline.id ? breakEven(focus.plan, baseline.plan, params) : null), [focus, baseline, params])
  const liveChecks = useMemo(() => checks(focus.plan, params, profile), [focus, params, profile])
  const economy = useMemo(() => ({ name: macro.name, ubs_scenario: macro.catalog, conditions: describeMacro(macro, profile.age), note: macro.id === 'base' ? 'today’s economy, nothing special' : 'illustrative economy scenario, shared by every path' }), [macro, profile.age])
  const facts = useMemo(() => ({ ...buildFacts(profile, params, computed, drv, be, focus.id), economy }), [profile, params, computed, drv, be, focus.id, economy])
  const factsKey = JSON.stringify(facts)

  // ------------------------------------------------------------ the direct answer to the last question
  const verdict = useMemo(() => {
    if (!asked) return null
    const mine = asked.ids.map((id) => computed.find((c) => c.id === id)).filter((c): c is (typeof computed)[number] => !!c)
    if (!mine.length) return null
    const asPath = (c: (typeof computed)[number]): ComparedPath => ({ id: c.id, name: c.name, spec: c.spec, overrides: c.overrides, plan: c.plan, result: c.result })
    let pair: (typeof computed)[number][]
    if (mine.length === 1) {
      const ref = baseline.id !== mine[0].id ? baseline : (computed.find((c) => c.id !== mine[0].id) ?? baseline)
      pair = [mine[0], ref]
    } else pair = [...mine].sort((x, y) => y.result.endNW.p50 - x.result.endNW.p50).slice(0, 2)
    if (pair[0].id === pair[1].id) return null
    return computeVerdict(asked.question, asPath(pair[0]), asPath(pair[1]), profile, params, H, loanRate, macro)
  }, [asked, computed, baseline, profile, params, H, loanRate, macro])
  const ansFacts = useMemo(() => (verdict ? { ...answerFacts(verdict, profile, params, H), economy } : null), [verdict, profile, params, H, economy])
  const ansKey = ansFacts ? JSON.stringify(ansFacts) : ''
  const answerSeq = useRef(0)
  const askedMsg = useRef<number | null>(null)
  askedMsg.current = asked?.msg ?? null
  useEffect(() => {
    if (!ansKey) return
    const f = JSON.parse(ansKey)
    const id = ++answerSeq.current
    setAnswer((s) => (s?.data ? { ...s, status: 'loading' } : { status: 'loading', data: null }))
    const t = setTimeout(async () => {
      const r = await apiAnswer(f)
      if (id !== answerSeq.current) return
      const data = r.ok ? r.data : templateAnswer(f)
      if (r.ok) setAnswer({ status: 'ai', data: r.data, prompt: r.prompt, model: r.model, ms: r.ms, verify: verifyNumbers(`${r.data.short_answer} ${r.data.reasoning} ${r.data.confidence_sentence}`, f) })
      else setAnswer({ status: 'offline', data })
      if (askedMsg.current != null) replace(askedMsg.current, { answer: { text: data.short_answer, confidence: f.confidence } } as Partial<ChatMsg>)
    }, 300)
    return () => clearTimeout(t)
  }, [ansKey])

  // ------------------------------------------------------------ explanation: instant template, then the LLM (verified)
  const explainSeq = useRef(0)
  const runExplain = useCallback(async (f: typeof facts) => {
    const id = ++explainSeq.current
    const r = await apiExplain(f)
    if (id !== explainSeq.current) return // a newer request was sent meanwhile
    if (r.ok) setExplain({ status: 'ai', data: r.data, model: r.model, cached: r.cached, prompt: r.prompt, ms: r.ms, verify: verifyNumbers(`${r.data.headline} ${r.data.explanation} ${r.data.caveat}`, f) })
    else setExplain({ status: 'offline', data: templateExplanation(f), error: r.error })
  }, [])
  useEffect(() => {
    const f = JSON.parse(factsKey)
    setExplain((s) => (s ? { ...s, status: 'loading' } : { status: 'loading', data: templateExplanation(f) }))
    const t = setTimeout(() => runExplain(f), 700)
    return () => clearTimeout(t)
  }, [factsKey, runExplain])

  // ------------------------------------------------------------ talking to the twin
  const ctxFor = (text: string) => ({
    text,
    name: profile.name,
    age: profile.age,
    start_date: profile.as_of,
    profile: { age: profile.age, city: profile.city, status: profile.status, household: profile.household, net_income_chf: profile.income, rent_chf: profile.rent, cash_chf: profile.cash, investments_chf: profile.investments, usual_spending_without_rent_chf: Math.round(profile.calib.other_mu), goals: profile.goals.map((g) => g.name) },
    cities: cityList,
    catalog: params.catalog.map((c) => ({ id: c.id, name: c.name })),
  })

  // ------------------------------------------------------------ what the AI gets to see: the conversation, today's state, every path + results
  const r100 = (x: number) => Math.round(x / 100) * 100
  const ageOut = (m: number | null) => (m == null ? null : Math.floor(profile.age + m / 12))
  const compactEvents = (spec: ScenarioSpec) => spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)))
  const stateFor = () => ({
    name: profile.name, age: profile.age, city: profile.city, job_status: profile.status, household: profile.household,
    net_income_chf_per_month: Math.round(profile.income), rent_chf_per_month: Math.round(profile.rent), cash_chf: Math.round(profile.cash), investments_chf: Math.round(profile.investments),
    usual_spending_without_rent_chf_per_month: Math.round(profile.calib.other_mu), spending_ups_and_downs_chf: Math.round(profile.calib.other_sd),
    usual_monthly_balance_chf: Math.round(profile.income - profile.rent - profile.calib.other_mu), // income − rent − usual spending (negative = losing money each month)
    loans: profile.loans.map((l) => ({ principal_chf: Math.round(l.principal), rate_pct: Math.round(l.annual_rate * 10000) / 100 })),
    goals: profile.goals.map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by: g.date.slice(0, 7) })),
    told_the_twin: describeMemory(dataProfile, updates),
    economy: { current: macro.name, conditions: describeMacro(macro, profile.age), presets: MACRO_PRESETS.map((p) => `${p.id}: ${p.name}${p.catalog ? ` (${p.catalog})` : ''}`) },
    if_nothing_changes: {
      years_simulated: years, age_at_end: profile.age + years, net_worth_at_end_median_chf: r100(today.result.endNW.p50),
      chance_cash_below_zero_pct: Math.round(today.result.probNegCash * 100), cash_runs_out_at_age: ageOut(today.result.firstNegMonth),
      goals: today.result.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, chance_pct: Math.round(g.prob! * 100) })),
    },
    where_numbers_come_from: 'UBS synthetic data; usual spending learned from 24 months of this person\'s bank history',
  })
  const pathsFor = () =>
    computed.filter((c) => c.id !== 'today').map((c) => ({
      id: c.id, name: c.name, is_baseline: c.isBaseline, events: compactEvents(c.spec),
      net_worth_at_end_median_chf: r100(c.result.endNW.p50), chance_cash_below_zero_pct: Math.round(c.result.probNegCash * 100), cash_runs_out_at_age: ageOut(c.result.firstNegMonth),
      unknown_inputs: c.plan.assumptions.filter((a) => a.source === 'missing').map((a) => a.label),
      home_down_payment_missing_pct: c.result.homeBuys.map((h) => Math.round(h.shortShare * 100)),
    }))
  const historyFor = () =>
    messages.slice(-12).map((m) =>
      m.role === 'user'
        ? { role: 'user', text: m.target ? `[about path “${m.target.name}”] ${m.text}` : m.text }
        : { role: 'twin', text: [m.reply, m.lines.length ? `[actions applied: ${m.lines.map((l) => l.text).join(' ')}]` : '[no path, fact or economy was changed in this turn]', m.answer?.text].filter(Boolean).join(' ') },
    )

  /** One chat turn: the twin answers AND acts (update today's facts, add / edit / remove paths). */
  const talk = async (text: string, targetId: string | null = target) => {
    if (!text.trim() || asking || editing) return
    const tgt = targetId ? computed.find((c) => c.id === targetId) : undefined
    setAsking(true)
    if (tgt) setEditing(tgt.id)
    say({ role: 'user', text, target: tgt ? { name: tgt.name, color: tgt.color } : undefined })
    const reply = say({ role: 'twin', lines: [], pending: true })
    const state = stateFor()
    const pathsNow = pathsFor()
    const r = await apiChat({ ...ctxFor(text), history: historyFor(), state, paths: pathsNow, focus_path_id: focus.id !== 'today' ? focus.id : null, target_path_id: tgt?.id ?? null })

    if (!r.ok) {
      // AI unreachable: simple keyword rules (new paths and "I earn / I have / my rent is" only)
      const res = offlineParse(text, profile, cityList)
      const lines: ChatLine[] = []
      if (res.profile_update) {
        lines.push({ text: `🧠 Updated what I know: ${describeMemory(profile, [{ id: 0, said: text, update: res.profile_update }]).join(', ')}.` })
        setUpdates((us) => [...us, { id: updId.current++, said: text, update: res.profile_update! }])
      }
      const ids = addPaths(res.scenarios, { kind: 'offline', question: text, reason: r.error, answer: res })
      res.scenarios.forEach((sc, i) => lines.push({ text: `＋ ${sc.name}: ${describeSpec(sc, profile.age)}`, pathId: ids[i], color: colorOf(ids[i]) }))
      replace(reply, { pending: false, reply: lines.length ? undefined : res.note ?? undefined, lines, muted: `AI offline (${r.error}): understood with simple keyword rules${tgt ? '; editing a path needs the AI, but you can change any number in “The numbers behind”' : ''}.`, answer: ids.length ? null : undefined } as Partial<ChatMsg>)
      if (ids.length) setAsked({ question: text, ids, msg: reply })
      setAsking(false)
      setEditing(null)
      return
    }

    const d = r.data
    const lines: ChatLine[] = []
    // 1) facts about today -> the twin updates itself
    const u = d.profile_update
    if (u && [u.monthly_net_income_chf, u.monthly_rent_chf, u.cash_chf, u.investments_chf, u.monthly_spending_chf].some((x) => x != null)) {
      const ch = describeMemory(profile, [{ id: 0, said: text, update: u }])
      setUpdates((us) => [...us, { id: updId.current++, said: text, update: u }])
      if (ch.length) lines.push({ text: `🧠 Updated what I know: ${ch.join(', ')}. Every path now starts from this.` })
    }
    // 1b) the economy (macro, shared by every path)
    if (d.macro_update && Object.values(d.macro_update).some((x) => x != null)) {
      const next = applyMacroUpdate(macro, d.macro_update)
      setMacro(next)
      lines.push({ text: `🌍 Economy for every path: ${next.name}${describeMacro(next, profile.age).length ? ` (${describeMacro(next, profile.age).join(', ')})` : ''}` })
    }
    // 2) remove paths the user says were wrong
    const removable = d.remove_path_ids.filter((id) => id !== 'today' && computed.some((c) => c.id === id))
    for (const id of removable) {
      lines.push({ text: `🗑 Removed “${computed.find((c) => c.id === id)!.name}”` })
      remove(id)
    }
    // 3) edit existing paths (one or several, e.g. "add a house to all paths"); old versions kept for undo
    const editedIds: string[] = []
    const editRecords: Record<string, PathEdit[]> = {}
    const norm = (x: string) => x.trim().toLowerCase()
    for (const ed of d.edits ?? []) {
      // match by id, or by name if the AI used the name
      const p = computed.find((c) => c.id === ed.path_id) ?? computed.find((c) => c.id !== 'today' && norm(c.name) === norm(ed.path_id))
      if (!p) {
        lines.push({ text: `⚠ I tried to change a path I couldn't find (“${ed.path_id}”), so nothing was changed there.` })
        continue
      }
      if (removable.includes(p.id) || editedIds.includes(p.id)) continue
      const spec = keepSources(p.spec, ed.path)
      const keepGlobal = Object.fromEntries(Object.entries(p.overrides).filter(([k]) => k.startsWith('g.')))
      const edits = [...p.edits, { instruction: text, changes: ed.changes, model: r.model, ms: r.ms, prompt: r.prompt }]
      editRecords[p.id] = edits
      setPaths((ps) => ps.map((x) => (x.id === p.id ? { ...x, spec, overrides: keepGlobal, history: [...x.history, { spec: x.spec, overrides: x.overrides }], edits } : x)))
      editedIds.push(p.id)
      lines.push({ text: `✏️ Changed ${spec.name}:`, pathId: p.id, color: p.color }, ...ed.changes.map((c) => ({ text: `✓ ${c}` })))
    }
    if (editedIds.length) setFocusId(editedIds[editedIds.length - 1])
    const editedId = editedIds[0] ?? null
    // 4) new paths (they get a computed answer)
    const res: ParseResult = { profile_update: u, scenarios: d.new_paths, horizon_years: d.horizon_years, unsupported: d.unsupported, note: d.reply }
    const origin: Origin = { kind: 'ai', question: text, model: r.model, ms: r.ms, cached: r.cached, prompt: r.prompt, answer: res }
    const ids = addPaths(d.new_paths, origin)
    d.new_paths.forEach((sc, i) => lines.push({ text: `＋ ${sc.name}: ${describeSpec(sc, profile.age)}`, pathId: ids[i], color: colorOf(ids[i]) }))
    if (d.horizon_years) setYears(Math.max(1, Math.min(40, d.horizon_years)))
    // the twin's own words may only use numbers it was given
    // numbers the user typed, also per month / per year (1M a year -> 83,333 a month)
    const typed = [...text.matchAll(/(\d[\d'’,.]*)\s*(k|m|million)?\b/gi)].map((m) => Number(m[1].replace(/['’,]/g, '')) * (/^k$/i.test(m[2] ?? '') ? 1e3 : m[2] ? 1e6 : 1)).filter(Number.isFinite)
    const v = verifyNumbers(d.reply, { state, paths: pathsNow, text, typed, perMonth: typed.map((x) => x / 12), perYear: typed.map((x) => x * 12), history: historyFor().map((h) => h.text) })
    const muted = [d.unsupported.length ? `Not modelled: ${d.unsupported.join('; ')}.` : '', v.unmatched.length ? `ℹ calculated by the twin (not from the simulator): ${v.unmatched.join(', ')}` : ''].filter(Boolean).join(' ')
    const editedNow = editedId
    replace(reply, {
      pending: false,
      reply: d.reply,
      lines,
      muted: muted || undefined,
      answer: ids.length ? null : undefined,
      details: ids.length
        ? () => setHowMade({ what: 'path', name: d.new_paths[0].name, origin, spec: d.new_paths[0] })
        : editedNow
          ? () => { const p = paths.find((x) => x.id === editedNow); const ed = d.edits.find((x) => x.path_id === editedNow); if (p && ed) setHowMade({ what: 'path', name: ed.path.name, origin: p.origin, spec: ed.path, edits: editRecords[editedNow] }) }
          : lines.length
            ? () => setHowMade({ what: 'answer', prompt: r.prompt, answer: { short_answer: d.reply, reasoning: '', confidence_level: 'medium', confidence_sentence: '' }, model: r.model, ms: r.ms, offline: false, verify: v })
            : undefined, // a plain chat reply: nothing to explain
    } as Partial<ChatMsg>)
    if (ids.length) {
      setAsked({ question: text, ids, msg: reply })
      setAnswer(null)
    }
    if (tgt) setTarget(null)
    setAsking(false)
    setEditing(null)
  }
  const send = (text: string) => talk(text, target && computed.some((c) => c.id === target) ? target : null)
  const undoEdit = (id: string) =>
    setPaths((ps) => ps.map((x) => (x.id === id && x.history.length ? { ...x, spec: x.history.at(-1)!.spec, overrides: x.history.at(-1)!.overrides, history: x.history.slice(0, -1), edits: x.edits.slice(0, -1) } : x)))

  const update = (id: string, f: (p: PathState) => PathState) => setPaths((ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  const remove = (id: string) => {
    setPaths((ps) => ps.filter((p) => p.id !== id))
    if (id === baselineId) setBaselineId('today')
    if (id === focusId) setFocusId('today')
  }

  const endAge = profile.age + years
  const ageAt = (m: number) => Math.floor(profile.age + m / 12)
  const sameAsCash = computed.every((c) => c.result.nw.every((b, i) => Math.abs(b.p50 - c.result.cash[i].p50) < 1))
  const view = sameAsCash ? 'cash' : metric
  const focusParts = useMemo(() => runPath(focus.plan, params, null), [focus, params])
  const runsOut = today.result.probNegCash >= 0.5 && today.result.firstNegMonth != null
  const memory = updates.length ? describeMemory(dataProfile, updates) : []

  return (
    <div className="page">
      <nav className="nav">
        <span className="brand">
          <span className="logo" /> Financial Twin
        </span>
        <span className="spacer" />
        <span className={`status ${llm ? 'on' : ''}`} title={llm ? llm.model : 'No LLM: questions use simple offline rules'}>
          {llm === undefined ? '…' : llm ? 'AI on' : 'AI offline'}
        </span>
        <button className="btn-ghost" onClick={loadDemo}>
          ▶ Demo
        </button>
      </nav>

      <main className="col">
        {/* ---------------- who + the question ---------------- */}
        <section className="hero card">
          <div className="person">
            <div className="avatar">{profile.name[0]}</div>
            <div className="person-text">
              <div className="person-name">
                {profile.name}, {profile.age} <span className="muted">· {profile.city} · {profile.status.replace('_', ' ')}</span>
              </div>
              <div className="person-facts">
                <span>{chf(profile.cash)} saved</span>
                <span>earns {chf(profile.income)}/mo</span>
                <span>rent {chf(profile.rent)}/mo</span>
                {profile.investments > 0 && <span>invested {chfk(profile.investments)}</span>}
              </div>
            </div>
            <select className="person-pick" value={profileId} onChange={(e) => reset(e.target.value)} title="pick another fictional person">
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, {p.age}, {p.city}, {p.status}
                </option>
              ))}
            </select>
          </div>

          {memory.length > 0 && (
            <div className="memory">
              <span className="eyebrow">The twin knows</span>
              {memory.map((m) => (
                <span key={m} className="mem-chip">
                  {m}
                </span>
              ))}
              <button className="link-btn" onClick={() => setUpdates((u) => u.slice(0, -1))}>
                ↶ undo
              </button>
            </div>
          )}

          <h1 className="hook">
            {runsOut ? (
              <>
                If nothing changes, {profile.name}’s cash <span className="neg">runs out at age {ageAt(today.result.firstNegMonth!)}</span>.
              </>
            ) : (
              <>
                If nothing changes, {profile.name} has about <span className="pos">{chfk(today.result.endNW.p50)}</span> at {endAge}.
              </>
            )}
          </h1>

          <div ref={chatRef}>
            <Chat
              messages={thread}
              busy={asking || editing != null}
              placeholder={target ? `How should “${computed.find((c) => c.id === target)?.name}” change?` : 'Ask “what if…”, or tell the twin something new (“I now earn 1,500”)'}
              target={target ? (({ name, color }) => ({ name, color }))(computed.find((c) => c.id === target) ?? { name: '', color: '' }) : null}
              onClearTarget={() => setTarget(null)}
              onSend={send}
              onPath={(id) => setFocusId(id)}
            />
          </div>
          <div className="chip-group">
            <span className="chip-label">
              Ready-made paths <span className="muted">· instant, no AI · hover for details</span>
            </span>
            <div className="chips">
              {quick.map((p) => (
                <button key={p.id} className="chip" title={p.desc} onClick={() => addPaths([p.spec], fromPreset(p))}>
                  + {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="chip-group">
            <span className="chip-label">
              Questions for {profile.name} <span className="muted">· the AI turns them into paths</span>
            </span>
            <div className="chips">
              {examples.map((q) => (
                <button key={q} className="chip chip-ask" onClick={() => (setTarget(null), talk(q, null))} disabled={asking}>
                  “{q}”
                </button>
              ))}
            </div>
          </div>
        </section>

        {verdict && (
          <AnswerCard
            verdict={verdict}
            answer={answer?.data ?? null}
            status={answer?.status ?? 'loading'}
            verify={answer?.verify}
            onClose={() => (setAsked(null), setAnswer(null))}
            onSeePrompt={() => answer?.data && setHowMade({ what: 'answer', prompt: answer.prompt, answer: answer.data, model: answer.model, ms: answer.ms, offline: answer.status === 'offline', verify: answer.verify })}
          />
        )}

        {/* ---------------- the futures ---------------- */}
        <EconomyBar macro={macro} age={profile.age} onPick={setMacro} />

        <div className="section-title">
          <span className="eyebrow">Possible futures</span>
          <span className="muted small">click a card to look closer · {years} years</span>
        </div>
        <section className="outcomes">
          {computed.map((c) => (
            <OutcomeCard
              key={c.id}
              name={c.name}
              summary={describeSpec(c.spec, profile.age)}
              timeline={sortedEvents(c.spec).map((e) => ({ icon: iconOf(e), age: ageAt(e.start_month ?? 0), text: e.label }))}
              unknownFromAge={c.unknown ? ageAt(c.unknown.from) : null}
              warnings={c.plan.warnings}
              color={c.color}
              result={c.result}
              baseline={baseline}
              isBaseline={c.isBaseline}
              isFocus={c.id === focus.id}
              age={profile.age}
              endAge={endAge}
              onFocus={() => setFocusId(c.id)}
              onBaseline={() => setBaselineId(c.id)}
              onRemove={c.id === 'today' ? undefined : () => remove(c.id)}
            />
          ))}
        </section>

        {focus.id !== 'today' && (
          <PathEditor
            key={focus.id}
            name={focus.name}
            color={focus.color}
            spec={focus.spec}
            age={profile.age}
            busy={editing === focus.id}
            edits={focus.edits}
            canUndo={focus.history.length > 0}
            onEdit={(t) => talk(t, focus.id)}
            onWrite={() => {
              setTarget(focus.id)
              chatRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              setTimeout(() => chatRef.current?.querySelector('input')?.focus(), 350)
            }}
            onUndo={() => undoEdit(focus.id)}
          />
        )}

        <section className="card">
          <div className="card-head">
            <h2>{sameAsCash ? 'Money by age' : view === 'nw' ? 'Net worth by age' : 'Cash in the bank by age'}</h2>
            {!sameAsCash && <span className="muted small">{view === 'nw' ? 'everything owned − debts' : 'money you can spend'}</span>}
            <span className="spacer" />
            {!sameAsCash && (
              <div className="seg">
                <button className={view === 'nw' ? 'on' : ''} onClick={() => setMetric('nw')}>
                  Net worth
                </button>
                <button className={view === 'cash' ? 'on' : ''} onClick={() => setMetric('cash')}>
                  Cash
                </button>
              </div>
            )}
            <select className="mini" value={years} onChange={(e) => setYears(Number(e.target.value))}>
              {[...new Set([3, 5, 10, 20, 30, years])].sort((a, b) => a - b).map((y) => (
                <option key={y} value={y}>
                  {y} years
                </option>
              ))}
            </select>
          </div>
          <ProjectionChart paths={computed} focusId={focus.id} profile={updates.length ? { ...profile, ledger_closing_cash: [] } : profile} metric={view} months={H} markers={markersFor(focus.spec, focus.plan.months)} focusParts={focusParts} />
          {view === 'nw' && (focusParts.home.some((x) => x > 0) || focusParts.debt.some((x) => x > 0)) && (
            <div className="parts-legend small">
              <span>For <b style={{ color: focus.color }}>{focus.name}</b>:</span>
              <span><i style={{ background: focus.color }} /> net worth</span>
              <span><i style={{ background: focus.color, opacity: 0.5 }} /> cash (dotted)</span>
              {focusParts.home.some((x) => x > 0) && <span><i style={{ background: '#059669' }} /> assets (home, car…)</span>}
              {focusParts.debt.some((x) => x > 0) && <span><i style={{ background: 'var(--danger)' }} /> debt, below zero (mortgage + loans)</span>}
              <span className="muted">net worth = cash + investments + assets − debt</span>
            </div>
          )}
          {focus.unknown && (
            <p className="fog-note small">
              <b style={{ color: focus.color }}>?</b> From age {ageAt(focus.unknown.from)}, <b>{focus.name}</b> depends on {focus.unknown.items.length === 1 ? 'a number' : 'numbers'} nobody knows yet:{' '}
              {focus.unknown.items.map((i) => i.label.replace(/^[^:]+:\s*/, '')).join(', ')}. The line turns <b>dotted</b> there, and the <b>hatched area</b> shows how far it could go if {focus.unknown.items.length === 1 ? 'it were' : 'they were'} different ({focus.unknown.items.map((i) => (i.unit.includes('%') ? `${i.lo}% to ${i.hi}%` : `${chfk(i.lo)} to ${chfk(i.hi)}`)).join('; ')}, an illustrative range). Set {focus.unknown.items.length === 1 ? 'it' : 'them'} in “The numbers behind” or with a follow-up to make it solid.
            </p>
          )}
          {focus.result.homeBuys.map((h) => (
            <p key={`${h.month}-${h.label}`} className={`home-note small ${h.shortShare >= 0.5 ? 'neg' : ''}`}>
              {h.kind === 'home' ? '🏠' : '🚗'} <b>{h.label}</b>, age {ageAt(h.month)}, price {chf(h.price)}: <b>cash −{chf(h.down)}</b> (own money){h.loan > 0 ? <>, <b>debt +{chf(h.loan)}</b> ({h.kind === 'home' ? 'mortgage' : 'loan'})</> : ''}, <b>assets +{chf(h.price)}</b>. Net worth doesn’t jump: money just changes form{h.kind === 'asset' ? ', then the item loses value every year (net worth falls slowly)' : ''}. In the Net worth view: green = assets, red below zero = debt, dotted = cash.
              {h.shortShare >= 0.5
                ? ` But just before buying, cash is only about ${chf(h.cashBeforeP50)} (typical future): in ${Math.round(h.shortShare * 100)}% of futures there is NOT enough own money. A bank would not lend; the chart shows cash going below zero instead.`
                : h.shortShare > 0.05
                  ? ` In ${Math.round(h.shortShare * 100)}% of futures cash is not enough for the down payment at that moment.`
                  : ` Cash just before buying: about ${chf(h.cashBeforeP50)}, enough in all futures.`}
              {view === 'nw' && ' The thin dotted line is cash.'}
            </p>
          ))}
          {profile.goals.length > 0 && (
            <div className="goals">
              {profile.goals.map((g) => (
                <div key={g.name} className="goal">
                  <span className="goal-title">
                    🎯 <b>{g.name}</b>: {chf(g.target)} by {g.date.slice(0, 7)} <span className="muted">(age {ageAt(monthIndex(profile.as_of, g.date) + 1)})</span>
                  </span>
                  <span className="goal-hits">
                    {computed.map((c) => {
                      const r = c.result.goals.find((x) => x.name === g.name)
                      return (
                        <span key={c.id} className="goal-hit" style={{ color: c.color }} title={c.name}>
                          {r?.prob == null ? '—' : (r.prob >= 0.5 ? '✓ ' : '✗ ') + Math.round(r.prob * 100) + '%'}
                        </span>
                      )
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="caption">
            Bold lines = the typical (median) outcome of 500 simulated futures, so month-to-month bumps average out; thin wiggly lines = 6 single futures of the selected path, with real ups and downs; shaded = where 8 in 10 land for <b style={{ color: focus.color }}>{focus.name}</b>. 🎯 = goals from the data (amount and date): a path reaches one if its cash + investments are above it at that date; the % is the share of futures that do.
            {view === 'cash' && !updates.length ? ' Black dots = the real bank balance in the data (first 2 years).' : ''}
          </p>
        </section>

        {/* ---------------- the story ---------------- */}
        {explain && (
          <section className="card story">
            <span className="eyebrow">In plain words</span>
            <h2 className="story-head">{explain.data.headline}</h2>
            <p className="story-text">{explain.data.explanation}</p>
            {be && (
              <div className="insight">
                <span className="insight-icon">⚖</span>
                <div>
                  {be.pct >= 0 ? (
                    <>
                      <b>{focus.name}</b> catches up with <b>{baseline.name}</b> only if income from age {ageAt(be.month)} is <b>{be.pct.toFixed(0)}% higher</b> than we assumed (about {chf(be.incomeNeeded)} a month).
                    </>
                  ) : (
                    <>
                      <b>{focus.name}</b> stays ahead of <b>{baseline.name}</b> even if income from age {ageAt(be.month)} were <b>{Math.abs(be.pct).toFixed(0)}% lower</b> than we assumed (about {chf(be.incomeNeeded)} a month).
                    </>
                  )}
                </div>
              </div>
            )}
            <p className="caveat small">⚠ {explain.data.caveat}</p>
            <div className="story-meta">
              {explain.status === 'loading' && <span className="muted">updating…</span>}
              {explain.status === 'ai' && <span className="muted">written by AI ({explain.model?.split('/').pop()}){explain.cached ? ', cached' : ''}</span>}
              {explain.status === 'offline' && <span className="muted">written by a template (AI offline)</span>}
              {explain.status === 'ai' && explain.verify && (explain.verify.unmatched.length ? <span className="neg">⚠ {explain.verify.unmatched.length} number(s) not found in the model: {explain.verify.unmatched.join(', ')}</span> : <span className="ok">✓ all {explain.verify.total} numbers checked against the model</span>)}
              {explain.status !== 'loading' && (
                <button className="link-btn" onClick={() => setHowMade({ what: 'explanation', prompt: explain.prompt, answer: explain.data, model: explain.model, ms: explain.ms, offline: explain.status === 'offline', verify: explain.verify })}>
                  see the prompt
                </button>
              )}
              <button className="link-btn" onClick={() => runExplain(facts)}>
                rewrite
              </button>
            </div>
          </section>
        )}

        {/* ---------------- the numbers behind it ---------------- */}
        <details className="card fold" open={focus.id !== 'today'}>
          <summary>
            <h2>
              The numbers behind <span style={{ color: focus.color }}>{focus.name}</span>
            </h2>
            <span className="muted small">every number has a source · click a value to change it</span>
          </summary>
          <p className="made-by small">
            <span className="muted">What it does:</span> {describeSpec(focus.spec, profile.age)}. <span className="muted">Made by:</span>{' '}
            {focus.origin.kind === 'today' ? 'the data, unchanged' : focus.origin.kind === 'preset' ? `the “+ ${focus.origin.button}” button (no AI)` : focus.origin.kind === 'ai' ? `AI, from your question “${focus.origin.question}”` : `offline keyword rules, from “${focus.origin.question}”`}
            {focus.edits.length > 0 && `, then ${focus.edits.length} follow-up${focus.edits.length > 1 ? 's' : ''}`} ·{' '}
            <button className="link-btn" onClick={() => setHowMade({ what: 'path', name: focus.name, origin: focus.origin, spec: focus.spec, edits: focus.edits })}>
              {focus.origin.kind === 'ai' || focus.edits.length ? 'see the prompt' : 'see how'}
            </button>{' '}
            ·{' '}
            <button className="link-btn" title="the 15 fields UBS asks every scenario to document (scenario-modelling.md §20)" onClick={() => downloadJson(`scenario-${focus.name.replace(/\W+/g, '-').toLowerCase()}.json`, scenarioReport({ profile, path: focus, baseline: focus.id === baseline.id ? today : baseline, macro, years, drivers: drv, checks: liveChecks, params, breakEvenPct: be?.pct ?? null }))}>
              ⬇ scenario report (UBS template)
            </button>
          </p>
          {focus.plan.warnings.map((w) => (
            <p key={w} className="warn small">
              ⚠ {w}
            </p>
          ))}
          <AssumptionList
            items={focus.plan.assumptions}
            overrides={focus.overrides}
            onChange={(key, v) =>
              key.startsWith('m.')
                ? v != null && setMacro(editMacro(macro, key, v))
                : update(focus.id, (p) => {
                const o = { ...p.overrides }
                if (v == null) delete o[key]
                else o[key] = v
                return { ...p, overrides: o }
              })
            }
          />
          {drv.length > 0 && (
            <>
              <h3>What matters most</h3>
              <p className="muted small">Change each input by 10% and see how much the end result moves.</p>
              <Drivers drivers={drv} />
            </>
          )}
        </details>

        <details className="card fold">
          <summary>
            <h2>Can you trust this?</h2>
            <TrustSummary checks={liveChecks} params={params} verify={explain?.status === 'ai' ? explain.verify : undefined} />
          </summary>
          <TrustDetails params={params} checks={liveChecks} focusName={focus.name} />
        </details>

        <HowMade content={howMade} onClose={() => setHowMade(null)} />

        <footer className="muted small">
          Fictional people and synthetic data (UBS × LauzHack 2026 challenge). Results depend on the assumptions shown. Not a forecast, not financial advice.
        </footer>
      </main>
    </div>
  )
}

/** Editing an economy number (an "m." row) changes the shared economy, for every path. */
function editMacro(m: Macro, key: string, v: number): Macro {
  const n: Macro = { ...m, id: 'custom', name: 'Custom economy' }
  if (key === 'm.gap') n.inflation_pct = n.wage_growth_pct + v
  if (key === 'm.rate') n.rate_shift_pct = v
  if (key === 'm.ret') n.market_return_pct = v
  if (key === 'm.vol') n.market_vol_pct = v
  if (key === 'm.risk') n.recession_risk_per_year_pct = v
  if (key === 'm.rec' && n.recession) n.recession = { ...n.recession, income_drop_pct: Math.abs(v) }
  if (key === 'm.crash' && n.crash) n.crash = { ...n.crash, drop_pct: Math.abs(v) }
  if (key === 'm.house' && n.housing_drop) n.housing_drop = { ...n.housing_drop, drop_pct: Math.abs(v) }
  return n
}

/** "income CHF 1,200 → 1,500" style lines for what the person told the twin. */
function describeMemory(data: Profile, ups: TwinUpdate[]): string[] {
  const now = applyUpdates(data, ups)
  const out: string[] = []
  const line = (label: string, a: number, b: number, unit = '') => a !== b && out.push(`${label} ${chf(a)} → ${chf(b)}${unit}`)
  line('income', data.income, now.income, '/mo')
  line('rent', data.rent, now.rent, '/mo')
  line('savings', data.cash, now.cash)
  line('investments', data.investments, now.investments)
  line('usual spending', data.calib.other_mu, now.calib.other_mu, '/mo')
  return out
}
