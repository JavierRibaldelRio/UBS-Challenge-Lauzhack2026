import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chat, type ChatHandle, type ChatLine, type ChatMode, type ChatMsg } from './components/Chat'
import { CompareChart, type ChartSide } from './components/CompareChart'
import { AssumptionList } from './components/Details'
import { EconomyBar } from './components/Economy'
import { HowMade, type HowMadeContent } from './components/HowMade'
import { Sensitivity } from './components/Sensitivity'
import { Comparison, NodeTile, type TileData } from './components/Tiles'
import { Tree, type TreeItem } from './components/Tree'
import { TrustDetails, TrustSummary } from './components/Trust'
import { drivers, verifyNumbers } from './lib/analysis'
import { answerFacts, templateAnswer, verdict as computeVerdict, type ComparedPath } from './lib/answer'
import { apiAnswer, apiChat, apiCompare, apiHealth } from './lib/api'
import { breach, compareFacts, goalFit, templateCompare, type CompareResult, type Side } from './lib/compare'
import { offlineParse } from './lib/fallback'
import { chf, chfk, monthIndex } from './lib/fmt'
import { applyMacroUpdate, BASE_MACRO, describeMacro, MACRO_PRESETS, type Macro } from './lib/macro'
import { downloadJson, scenarioReport } from './lib/report'
import { cities, describeSpec, medianLoanRate, presets, resolve, type Overrides, type Plan, type Preset } from './lib/resolve'
import { checks, simulate, type SimResult } from './lib/sim'
import { DEFAULT_DISCOUNT_PCT } from './lib/valuation'
import { branchIdeas, followUpIdeas, suggestQuestions } from './lib/suggest'
import { addEvents, eventKey, inferParent, shiftBranch, withParentEvents } from './lib/tree'
import type { Origin, Params, ParseResult, Profile, ProfileUpdate, PromptInfo, ScenarioSpec, TwinEvent } from './lib/types'
import { unknownImpact } from './lib/unknowns'
import { effectIssues, incomeNeeded } from './lib/effects'
import { buildModel, type BaseParams, type BaseProfile } from './lib/model'
import type { Backtest, MacroModel, SpendingFile } from './lib/types'
import paramsJson from './model/params.json'
import profilesJson from './model/profiles.json'
import spendingJson from './model/spending.json'
import macroJson from './model/macro.json'
import backtestJson from './model/backtest.json'

/** What CHF 1 received `years` from now is worth today at an annual discount rate in % (e.g. 3% → 10 years ≈ CHF 0.74). */
const todayValueOf1 = (ratePct: number, years: number) => `CHF ${Math.pow(1 + ratePct / 100, -years).toFixed(2)}`

type Version = { spec: ScenarioSpec; overrides: Overrides }
type PathEdit = { instruction: string; changes: string[]; model?: string; ms?: number; prompt?: PromptInfo }
type NewMsg = ChatMsg extends infer T ? (T extends ChatMsg ? Omit<T, 'id'> : never) : never
/** One node of the scenario tree. A branch keeps its parent's decisions (copied into its own events). */
type PathState = { id: string; parentId: string | null; spec: ScenarioSpec; overrides: Overrides; origin: Origin; history: Version[]; edits: PathEdit[] }
type Computed = PathState & { name: string; plan: Plan; result: SimResult }
type Sel = { a: string | null; b: string | null }

const TODAY = (): PathState => ({ id: 'today', parentId: null, spec: { name: 'If nothing changes', catalog_id: null, events: [] }, overrides: {}, origin: { kind: 'today' }, history: [], edits: [] })
const fromPreset = (p: Preset): Origin => ({ kind: 'preset', button: p.label, desc: p.desc })

// icons for life events (tree, tiles, chart markers)
const ICON: Record<string, string> = { start_job: '💼', study: '🎓', relocate: '🚚', income_change: '📉', household_change: '👶', recurring_expense: '🔁', one_off: '💸', invest: '📈', market_shock: '📉', take_loan: '🏦', buy_home: '🏠', buy_asset: '🚗' }
const iconOf = (e: TwinEvent) => (e.type === 'household_change' && e.household_type === 'couple' ? '💑' : e.type === 'income_change' && (e.income_change_pct ?? 0) > 0 ? '📈' : e.type === 'one_off' && (e.amount_chf ?? 0) < 0 ? '🎁' : ICON[e.type])
const sortedEvents = (spec: ScenarioSpec) => [...spec.events].sort((a, b) => (a.start_month ?? 0) - (b.start_month ?? 0))

/**
 * The time on a tree link: when the branch's first NEW decision happens, counted from its parent's last decision
 * ("+8 yrs"). The tree itself is not a timeline, so the time lives on the links.
 */
function linkGap(c: { spec: ScenarioSpec }, parent: { id: string; name: string; spec: ScenarioSpec } | undefined, age0: number) {
  if (!parent) return null
  const known = new Set(parent.spec.events.map(eventKey))
  const fresh = c.spec.events.filter((e) => !known.has(eventKey(e)))
  if (!fresh.length) return null
  const first = Math.min(...fresh.map((e) => e.start_month ?? 0))
  const ref = Math.max(0, ...parent.spec.events.map((e) => e.start_month ?? 0))
  const d = first - ref
  const age = Math.floor(age0 + first / 12)
  const yrs = Math.round(d / 6) / 2 // to the half year
  const label = d < 0 ? `at ${age}` : d < 6 ? (parent.id === 'today' ? 'now' : 'right after') : `+${yrs} yr${yrs === 1 ? '' : 's'}`
  const title = parent.id === 'today' ? `first decision at age ${age}${first < 6 ? ' (now)' : `, in ${yrs} year${yrs === 1 ? '' : 's'}`}` : d < 0 ? `its new decision (age ${age}) comes before “${parent.name}”’s last one` : `its new decision comes ${d < 6 ? 'right after' : `${yrs} year${yrs === 1 ? '' : 's'} after`} “${parent.name}”’s last one (age ${age})`
  return { label, title, years: d / 12 }
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
      home: u.home_value_chf != null ? u.home_value_chf : q.home,
      minCash: u.min_cash_chf != null ? u.min_cash_chf : q.minCash,
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
const madeBy = (o: Origin) => (o.kind === 'today' ? 'the data, unchanged' : o.kind === 'preset' ? `the “${o.button}” button` : o.kind === 'ai' ? `the chat (“${o.question}”)` : `offline rules (“${o.question}”)`)

type CompareState = { key: string; status: 'ai' | 'offline'; data: CompareResult; model?: string; prompt?: PromptInfo; ms?: number; verify?: { total: number; unmatched: string[] } }

// Model artifacts are bundled (see lib/model.ts) -> no runtime fetch that could fail during a demo.
const MODEL = buildModel(paramsJson as unknown as BaseParams, profilesJson as unknown as BaseProfile[], spendingJson as unknown as SpendingFile, macroJson as unknown as MacroModel, backtestJson as unknown as Backtest)
export default function App() {
  return <Twin params={MODEL.params} profiles={MODEL.profiles} />
}

function Twin({ params, profiles }: { params: Params; profiles: Profile[] }) {
  // ------------------------------------------------------------ the person (data + what they told the twin)
  const [profileId, setProfileId] = useState('P00001')
  const [updates, setUpdates] = useState<TwinUpdate[]>([])
  const dataProfile = profiles.find((p) => p.id === profileId) ?? profiles[0]
  const [goalEdits, setGoalEdits] = useState<{ added: Profile['goals']; removed: string[] }>({ added: [], removed: [] })
  const profile = useMemo(() => {
    const p = applyUpdates(dataProfile, updates)
    return { ...p, goals: [...p.goals.filter((g) => !goalEdits.removed.includes(g.name)), ...goalEdits.added.filter((g) => !goalEdits.removed.includes(g.name))] }
  }, [dataProfile, updates, goalEdits])
  const [years, setYears] = useState(10)
  const [macro, setMacro] = useState<Macro>(BASE_MACRO) // the economy: shared by every path
  const [discountPct, setDiscountPct] = useState<number | null>(null) // NPV discount rate, shared by every path; null = DEFAULT_DISCOUNT_PCT
  const H = years * 12

  // ------------------------------------------------------------ the tree and the A/B selection
  const [paths, setPaths] = useState<PathState[]>([TODAY()])
  const [sel, setSel] = useState<Sel>({ a: 'today', b: null })
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null) // "+ New path" panel open, branching from this node
  const nextId = useRef(1)
  const updId = useRef(1)

  // ------------------------------------------------------------ chat
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [mode, setMode] = useState<ChatMode>(null)
  const [asking, setAsking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [llm, setLlm] = useState<{ model: string } | null | undefined>(undefined)
  const [howMade, setHowMade] = useState<HowMadeContent | null>(null)
  const [asked, setAsked] = useState<{ question: string; ids: string[]; msg: number } | null>(null)
  const msgId = useRef(1)
  const chat = useRef<ChatHandle>(null)

  // ------------------------------------------------------------ layout
  const [chatW, setChatW] = useState(() => {
    try {
      return Number(localStorage.getItem('twin-chat-w')) || 420
    } catch {
      return 420
    }
  })
  const [numbers, setNumbers] = useState<{ open: boolean; tab: 'a' | 'b' }>({ open: false, tab: 'a' })
  const numbersRef = useRef<HTMLDetailsElement>(null)

  const examples = useMemo(() => suggestQuestions(profile, params), [profile, params])
  const loanRate = useMemo(() => medianLoanRate(profiles), [profiles])
  const cityList = useMemo(() => cities(params), [params])
  const quick = useMemo(() => presets(profile, params), [profile, params])

  useEffect(() => {
    apiHealth().then((h) => setLlm(h.ok ? h.llm : null))
  }, [])

  // ------------------------------------------------------------ compute: one cached simulation per node
  // The tree can grow without limit, so only nodes whose inputs changed are simulated again.
  const simCache = useRef<{ env: unknown[]; map: Map<string, { plan: Plan; result: SimResult }> }>({ env: [], map: new Map() })
  const computed: Computed[] = useMemo(() => {
    const env = [profile, params, H, loanRate, macro, discountPct]
    const c = simCache.current
    // anything shared by every path changed (person, economy, horizon) -> start over; also cap the memory
    if (env.some((x, i) => x !== c.env[i]) || c.map.size > 400) {
      c.env = env
      c.map = new Map()
    }
    return paths.map((p) => {
      const key = JSON.stringify([p.spec, p.overrides])
      let hit = c.map.get(key)
      if (!hit) {
        const plan = resolve(profile, params, p.spec, p.overrides, H, loanRate, macro, discountPct)
        hit = { plan, result: simulate(plan, params, profile) }
        c.map.set(key, hit)
      }
      return { ...p, name: p.spec.name, ...hit }
    })
  }, [paths, profile, params, H, loanRate, macro, discountPct])
  const byId = useMemo(() => new Map(computed.map((c) => [c.id, c])), [computed])
  const today = byId.get('today') ?? computed[0]
  const A = sel.a ? byId.get(sel.a) : undefined
  const B = sel.b ? byId.get(sel.b) : undefined
  const ageAt = useCallback((m: number) => Math.floor(profile.age + m / 12), [profile.age])
  const endAge = profile.age + years
  const unkA = useMemo(() => (A ? unknownImpact(A.spec, A.overrides, A.plan, profile, params, H, loanRate, macro) : null), [A, profile, params, H, loanRate, macro])
  const unkB = useMemo(() => (B ? unknownImpact(B.spec, B.overrides, B.plan, profile, params, H, loanRate, macro) : null), [B, profile, params, H, loanRate, macro])

  // ------------------------------------------------------------ selection: 1st click = A (green), 2nd = B (blue)
  const pick = useCallback((id: string) => {
    setSel((s) => {
      if (s.a === id) return { a: null, b: s.b }
      if (s.b === id) return { a: s.a, b: null }
      if (!s.a) return { a: id, b: s.b }
      return { a: s.a, b: id } // a third click replaces B; A stays as the reference
    })
  }, [])
  const swap = () => setSel((s) => ({ a: s.b, b: s.a }))
  const toggleFold = useCallback((id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n }), [])

  // ------------------------------------------------------------ adding / removing nodes
  /** Add paths to the tree. With a parent: they are branches of it (and keep its decisions). Without: the parent is found from their decisions. */
  const addPaths = (specs: ScenarioSpec[], origin: Origin, parentId: string | null | (string | null)[] = null) => {
    const others = computed.map((c) => ({ id: c.id, spec: c.spec }))
    const parents: string[] = []
    const added: PathState[] = []
    specs.forEach((s, i) => {
      const pid = Array.isArray(parentId) ? parentId[i] : parentId
      // "new:2" = the 3rd path created in this same turn (a chain of new nodes)
      const chained = pid?.startsWith('new:') ? added[Number(pid.slice(4))] : undefined
      const parent = chained ?? (pid ? byId.get(pid) : undefined)
      const spec = parent ? withParentEvents(s, parent.spec) : s // a branch keeps every decision of its parent
      if (parent && !chained) parents.push(parent.id)
      added.push({ id: `p${nextId.current++}`, parentId: parent?.id ?? inferParent(spec, others, 'today'), spec, overrides: {}, origin, history: [], edits: [] })
    })
    if (!added.length) return [] as PathState[]
    setPaths((ps) => [...ps, ...added])
    const ids = added.map((a) => a.id)
    setSel((s) => (ids.length >= 2 ? { a: ids[0], b: ids[1] } : { a: s.a ?? s.b ?? 'today', b: ids[0] }))
    if (parents.length) setCollapsed((c) => { if (!parents.some((x) => c.has(x))) return c; const n = new Set(c); parents.forEach((x) => n.delete(x)); return n })
    return added
  }
  const remove = (id: string) => {
    if (id === 'today') return
    setPaths((ps) => {
      const gone = ps.find((p) => p.id === id)
      return ps.filter((p) => p.id !== id).map((p) => (p.parentId === id ? { ...p, parentId: gone?.parentId ?? 'today' } : p))
    })
    setSel((s) => {
      const n = { a: s.a === id ? null : s.a, b: s.b === id ? null : s.b }
      return n.a || n.b ? n : { a: 'today', b: null }
    })
    if (mode?.id === id) setMode(null)
  }
  const branchPreset = (p: Preset, parentId: string) => {
    const parent = byId.get(parentId)
    const spec: ScenarioSpec = parent && parent.id !== 'today' ? { ...p.spec, name: `+ ${p.label}`, events: [...parent.spec.events, ...p.spec.events] } : p.spec
    addPaths([spec], fromPreset(p), parentId)
    setAdding(null)
  }
  const undoEdit = (id: string) =>
    setPaths((ps) => ps.map((x) => (x.id === id && x.history.length ? { ...x, spec: x.history.at(-1)!.spec, overrides: x.history.at(-1)!.overrides, history: x.history.slice(0, -1), edits: x.edits.slice(0, -1) } : x)))
  const update = (id: string, f: (p: PathState) => PathState) => setPaths((ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  /** The time on a link was edited: move that branch's own decisions (and their copies further down the tree). Undo-able. */
  const editGap = useCallback((id: string, years: number) => {
    setPaths((ps) => {
      const changed = shiftBranch(ps, id, years)
      if (!changed?.size) return ps
      const note = { instruction: `time on the link set to ${years >= 0 ? '+' : ''}${years} yrs`, changes: [`moved to ${years >= 0 ? '+' : ''}${years} years after the path it continues`] }
      return ps.map((x) => (changed.has(x.id) ? { ...x, spec: changed.get(x.id)!, history: [...x.history, { spec: x.spec, overrides: x.overrides }], edits: [...x.edits, note] } : x))
    })
  }, [])

  const reset = (id: string, next: PathState[] = [TODAY()], s: Sel = { a: 'today', b: null }) => {
    setProfileId(id)
    setMacro(BASE_MACRO)
    setUpdates([])
    setGoalEdits({ added: [], removed: [] })
    setPaths(next)
    setSel(s)
    setCollapsed(new Set())
    setAsked(null)
    setMode(null)
    setAdding(null)
    setMessages([])
  }
  // The challenge's own example: Alexia: start working (A) vs master's (B), plus move abroad
  const loadDemo = useCallback(() => {
    const alexia = profiles.find((p) => p.id === 'P00001')!
    const ps = presets(alexia, params)
    const node = (id: string, i: number): PathState => {
      const p = ps.find((x) => x.id === id)!
      return { id: `d${i}`, parentId: 'today', spec: p.spec, overrides: {}, origin: fromPreset(p), history: [], edits: [] }
    }
    setYears(10)
    reset('P00001', [TODAY(), node('work', 1), node('master', 2), node('abroad', 3)], { a: 'd1', b: 'd2' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, params])
  useEffect(() => {
    if (new URLSearchParams(location.search).has('demo')) loadDemo()
  }, [loadDemo])

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
      { text: `Hi, I'm ${dataProfile.name}'s financial twin. I start from UBS's data about ${dataProfile.name} (age ${dataProfile.age}, ${dataProfile.city}, income, rent, savings, goals). Spending comes from a model of 24 months of bank history of all 1,200 people: what someone in ${dataProfile.name}'s situation (status, city, month) spends.` },
      { text: 'Ask me “what if…”, tell me what changed (“I now earn 1,500”), or add a path with “+ New path”. Every path is a node: click two to compare them (first = A, green; second = B, blue).' },
    ],
  }
  const thread = [welcome, ...messages]

  // ------------------------------------------------------------ the direct answer to the last question (computed verdict, AI words)
  const verdictAsked = useMemo(() => {
    if (!asked) return null
    const mine = asked.ids.map((id) => byId.get(id)).filter((c): c is Computed => !!c)
    if (!mine.length) return null
    const asPath = (c: Computed): ComparedPath => ({ id: c.id, name: c.name, spec: c.spec, overrides: c.overrides, plan: c.plan, result: c.result })
    let pair: Computed[]
    if (mine.length === 1) {
      const parent = mine[0].parentId ? byId.get(mine[0].parentId) : undefined
      pair = [mine[0], parent && parent.id !== mine[0].id ? parent : today]
    } else pair = [...mine].sort((x, y) => y.result.endNW.p50 - x.result.endNW.p50).slice(0, 2)
    if (pair[0].id === pair[1].id) return null
    return computeVerdict(asked.question, asPath(pair[0]), asPath(pair[1]), profile, params, H, loanRate, macro)
  }, [asked, byId, today, profile, params, H, loanRate, macro])
  const economy = useMemo(() => ({ name: macro.name, ubs_scenario: macro.catalog, conditions: describeMacro(macro, profile.age), note: macro.id === 'base' ? 'today’s economy, nothing special' : macro.forecast ? 'inflation and unemployment drawn from a model of Swiss data (1991–2025): each simulated future has its own economy, the same for every path; employees can lose their job (national rate, not a personal risk)' : 'illustrative economy scenario, shared by every path' }), [macro, profile.age])
  const ansKey = useMemo(() => (verdictAsked ? JSON.stringify({ ...answerFacts(verdictAsked, profile, params, H), economy }) : ''), [verdictAsked, profile, params, H, economy])
  const answerSeq = useRef(0)
  const askedRef = useRef(asked)
  askedRef.current = asked
  const reasonsRef = useRef<string[]>([])
  reasonsRef.current = verdictAsked?.reasons ?? []
  useEffect(() => {
    if (!ansKey) return
    const f = JSON.parse(ansKey)
    const id = ++answerSeq.current
    const t = setTimeout(async () => {
      const r = await apiAnswer(f)
      if (id !== answerSeq.current || !askedRef.current) return
      const data = r.ok ? r.data : templateAnswer(f)
      const verify = r.ok ? verifyNumbers(`${data.short_answer} ${data.reasoning} ${data.confidence_sentence}`, f) : undefined
      const onPrompt = () => setHowMade({ what: 'answer', prompt: r.ok ? r.prompt : undefined, answer: data, model: r.ok ? r.model : undefined, ms: r.ok ? r.ms : undefined, offline: !r.ok, verify })
      replace(askedRef.current.msg, { answer: { text: data.short_answer, confidence: f.confidence, why: data.reasoning, reasons: reasonsRef.current, onPrompt } } as Partial<ChatMsg>)
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ansKey])

  // ------------------------------------------------------------ what the AI gets to see
  const r100 = (x: number) => Math.round(x / 100) * 100
  const ageOut = (m: number | null) => (m == null ? null : ageAt(m))
  const compactEvents = (spec: ScenarioSpec) => spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)))
  const ctxFor = (text: string) => ({
    text,
    name: profile.name,
    age: profile.age,
    start_date: profile.as_of,
    profile: { age: profile.age, city: profile.city, status: profile.status, household: profile.household, net_income_chf: profile.income, rent_chf: profile.rent, cash_chf: profile.cash, investments_chf: profile.investments, usual_spending_without_rent_chf: Math.round(profile.calib.other_mu), goals: profile.goals.map((g) => g.name) },
    cities: cityList,
    catalog: params.catalog.map((c) => ({ id: c.id, name: c.name })),
  })
  const stateFor = () => ({
    name: profile.name, age: profile.age, city: profile.city, job_status: profile.status, household: profile.household,
    net_income_chf_per_month: Math.round(profile.income), rent_chf_per_month: Math.round(profile.rent), cash_chf: Math.round(profile.cash), investments_chf: Math.round(profile.investments),
    usual_spending_without_rent_chf_per_month: Math.round(profile.calib.other_mu), spending_ups_and_downs_chf: Math.round(profile.calib.other_sd),
    usual_monthly_balance_chf: Math.round(profile.income - profile.rent - profile.calib.other_mu), // income − rent − usual spending (negative = losing money each month)
    loans: profile.loans.map((l) => ({ principal_chf: Math.round(l.principal), rate_pct: Math.round(l.annual_rate * 10000) / 100 })),
    home_already_owned_chf: profile.home ? Math.round(profile.home) : 0,
    net_worth_today_chf: Math.round(profile.cash + profile.investments + (profile.home ?? 0) - profile.loans.reduce((a, l) => a + l.principal, 0)),
    minimum_cash_floor_chf: profile.minCash ? Math.round(profile.minCash) : null,
    goals: profile.goals.map((g) => ({ goal: g.name, target_chf: Math.round(g.target), by: g.date.slice(0, 7), priority: g.priority })),
    told_the_twin: describeMemory(dataProfile, updates),
    economy: { current: macro.name, conditions: describeMacro(macro, profile.age), presets: MACRO_PRESETS.map((p) => `${p.id}: ${p.name}${p.catalog ? ` (${p.catalog})` : ''}`) },
    todays_money: {
      discount_rate_pct: discountPct ?? DEFAULT_DISCOUNT_PCT,
      source: discountPct == null ? `default assumption (${DEFAULT_DISCOUNT_PCT}% for every path unless the user sets one)` : 'set by the user',
      meaning: "worth in today's money (NPV): every franc in or out discounted to today when it happens + what you own minus debts at the horizon, discounted. Only a way to value paths; it never changes the simulation",
    },
    if_nothing_changes_income_needed: needFor(today.plan),
    // every path INCLUDING the baseline, ranked by the engine (for "which is best?")
    all_paths_ranked_by_net_worth_at_end: [...computed].sort((a, b) => b.result.endNW.p50 - a.result.endNW.p50).map((c, i) => ({ rank: i + 1, path: c.id === 'today' ? 'BASELINE (if nothing changes)' : c.name, net_worth_at_end_median_chf: r100(c.result.endNW.p50), worth_in_todays_money_at_end_median_chf: r100(c.result.endNPV.p50), chance_cash_below_zero_pct: Math.round(c.result.probNegCash * 100) })),
    if_nothing_changes: {
      years_simulated: years, age_at_end: endAge, net_worth_at_end_median_chf: r100(today.result.endNW.p50), worth_in_todays_money_at_end_median_chf: r100(today.result.endNPV.p50),
      chance_cash_below_zero_pct: Math.round(today.result.probNegCash * 100), cash_runs_out_at_age: ageOut(today.result.firstNegMonth),
      goals: today.result.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, chance_pct: Math.round(g.prob! * 100) })),
    },
    where_numbers_come_from: 'UBS synthetic data; usual spending from a model estimated in R on 24 months of all 1,200 people (status, city, calendar month + a small personal offset)',
  })
  /** every path the AI may need, capped so the prompt stays small even with a huge tree */
  const pathsFor = (extra: (string | null | undefined)[] = []) => {
    const must = new Set([sel.a, sel.b, ...extra].filter(Boolean) as string[])
    const rest = computed.filter((c) => c.id !== 'today' && !must.has(c.id)).slice(-20)
    return [...computed.filter((c) => c.id !== 'today' && must.has(c.id)), ...rest].map((c) => ({
      id: c.id, name: c.name, parent_id: c.parentId, events: compactEvents(c.spec),
      last_change: c.edits.at(-1) ? { asked: c.edits.at(-1)!.instruction, changes: c.edits.at(-1)!.changes } : null, can_undo: c.history.length > 0,
      undo_would_restore: c.history.length ? describeSpec(c.history.at(-1)!.spec, profile.age) : null,
      net_worth_at_end_median_chf: r100(c.result.endNW.p50), worth_in_todays_money_at_end_median_chf: r100(c.result.endNPV.p50), chance_cash_below_zero_pct: Math.round(c.result.probNegCash * 100), cash_runs_out_at_age: ageOut(c.result.firstNegMonth),
      goals: c.result.goals.filter((g) => g.prob != null).map((g) => ({ goal: g.name, chance_pct: Math.round(g.prob! * 100) })),
      unknown_inputs: c.plan.assumptions.filter((a) => a.source === 'missing').map((a) => a.label),
      home_down_payment_missing_pct: c.result.homeBuys.map((h) => Math.round(h.shortShare * 100)),
      planned_investing_skipped_pct: Math.round(c.result.investCut.share * 100),
      warnings: c.plan.warnings,
      income_needed: needFor(c.plan),
    }))
  }
  /** goal-seeking, computed by the engine: what income (in every month) keeps cash >= 0 (or >= the floor) on a path */
  const needFor = (pl: Plan) => {
    const n = incomeNeeded(pl, params, profile.minCash ?? 0)
    if (!n) return 'already enough: cash never goes below zero with today\'s income'
    if (!Number.isFinite(n.pct)) return 'not reachable by income alone (even 5x the income is not enough)'
    return { income_change_needed_pct: n.pct, monthly_income_needed_now_chf: n.monthlyNow, meaning: 'smallest income (in every month, same % change) for which cash never goes below zero on this path (and planned investing can happen)' }
  }
  const historyFor = () =>
    messages.slice(-12).map((m) =>
      m.role === 'user'
        ? { role: 'user', text: m.target ? `[${m.target.mode === 'fork' ? 'new branch of' : 'about'} path “${m.target.name}”] ${m.text}` : m.text }
        : { role: 'twin', text: [m.reply, m.lines.length ? `[actions applied: ${m.lines.map((l) => l.text).join(' ')}]` : '[no path, fact or economy was changed in this turn]', m.answer?.text].filter(Boolean).join(' ') },
    )

  /** One chat turn: the twin answers AND acts (update today's facts, goals, economy; add / branch / edit / remove paths). */
  const talk = async (text: string, m: ChatMode = mode) => {
    if (!text.trim() || asking || editing) return
    const tgt = m?.kind === 'edit' ? byId.get(m.id) : undefined
    const fork = m?.kind === 'fork' ? byId.get(m.id) : undefined
    setAsking(true)
    setMode(null)
    if (tgt) setEditing(tgt.id)
    say({ role: 'user', text, target: tgt ? { name: tgt.name, mode: 'edit' } : fork ? { name: fork.name, mode: 'fork' } : undefined })
    const reply = say({ role: 'twin', lines: [], pending: true })
    const state = stateFor()
    const pathsNow = pathsFor([tgt?.id, fork?.id])
    const r = await apiChat({ ...ctxFor(text), history: historyFor(), state, paths: pathsNow, focus_path_id: sel.b ?? sel.a, target_path_id: tgt?.id ?? null, fork_from_path_id: fork?.id ?? null, compare: { A: sel.a, B: sel.b } })

    if (!r.ok) {
      // AI unreachable: simple keyword rules (new paths and "I earn / I have / my rent is" only)
      const res = offlineParse(text, profile, cityList)
      const lines: ChatLine[] = []
      if (res.profile_update) {
        lines.push({ text: `🧠 Updated what I know: ${describeMemory(profile, [{ id: 0, said: text, update: res.profile_update }]).join(', ')}.` })
        setUpdates((us) => [...us, { id: updId.current++, said: text, update: res.profile_update! }])
      }
      const ids = addPaths(res.scenarios, { kind: 'offline', question: text, reason: r.error, answer: res }, fork?.id ?? null).map((a) => a.id)
      res.scenarios.forEach((sc, i) => lines.push({ text: `＋ ${sc.name}: ${describeSpec(sc, profile.age)}`, pathId: ids[i] }))
      if (res.discount_rate_pct != null) {
        const disc = Math.max(0, Math.min(20, res.discount_rate_pct))
        setDiscountPct(disc)
        lines.push({ text: `⏳ Today’s-money values (NPV) now use a ${disc}% discount rate a year, for every path. The simulation itself does not change.` })
      }
      // "offline" only when the AI really can't be reached; otherwise its answer failed (say so, and how to get around it)
      const unreachable = /not reachable|timed out|No LLM_API_KEY/i.test(r.error)
      const why = unreachable ? `AI offline (${r.error}): understood with simple keyword rules` : `The AI's answer couldn't be used (${r.error}). I fell back to simple keyword rules${ids.length ? '' : '; try asking for fewer things at once'}`
      replace(reply, { pending: false, reply: lines.length ? undefined : res.note ?? undefined, lines, muted: `${why}${tgt ? '; changing a path needs the AI, but you can change any number under “Assumptions”' : ''}.`, answer: ids.length ? null : undefined } as Partial<ChatMsg>)
      if (ids.length) setAsked({ question: text, ids, msg: reply })
      setAsking(false)
      setEditing(null)
      return
    }

    const d = r.data
    const lines: ChatLine[] = []
    // 1) facts about today -> the twin updates itself
    const u = d.profile_update
    if (u && [u.monthly_net_income_chf, u.monthly_rent_chf, u.cash_chf, u.investments_chf, u.monthly_spending_chf, u.home_value_chf, u.min_cash_chf].some((x) => x != null)) {
      const ch = describeMemory(profile, [{ id: 0, said: text, update: u }])
      setUpdates((us) => [...us, { id: updId.current++, said: text, update: u }])
      if (ch.length) lines.push({ text: `🧠 Updated what I know: ${ch.join(', ')}. Every path now starts from this.` })
    }
    // 1a) goals added / removed in the chat (apply to every path)
    const dateAt = (mm: number) => {
      const [y, mo] = profile.as_of.split('-').map(Number)
      return new Date(Date.UTC(y, mo - 1 + Math.max(1, Math.round(mm)), 0)).toISOString().slice(0, 10) // "by 30" = end of the month before turning 30
    }
    const newGoals = (d.new_goals ?? []).filter((g) => g.target_chf > 0).map((g) => ({ name: g.name, target: g.target_chf, date: dateAt(g.by_month), priority: 'yours' }))
    const dropGoals = (d.remove_goals ?? []).filter((n) => profile.goals.some((g) => g.name === n))
    if (newGoals.length || dropGoals.length) {
      setGoalEdits((ge) => ({ added: [...ge.added.filter((g) => !newGoals.some((n) => n.name === g.name)), ...newGoals], removed: [...ge.removed.filter((n) => !newGoals.some((g) => g.name === n)), ...dropGoals] }))
      for (const g of newGoals) lines.push({ text: `🎯 New goal: ${g.name}, ${chf(g.target)} by ${g.date.slice(0, 7)} (age ${Math.floor(profile.age + (monthIndex(profile.as_of, g.date) + 1) / 12)}). Every path shows its chance of reaching it.` })
      for (const n of dropGoals) lines.push({ text: `🗑 Removed goal: ${n}` })
      const furthest = Math.max(0, ...newGoals.map((g) => monthIndex(profile.as_of, g.date) + 1))
      if (furthest > H) setYears(Math.min(40, Math.ceil(furthest / 12))) // make sure the goal is on the chart
    }
    // 1b) the economy (macro, shared by every path)
    if (d.macro_update && Object.values(d.macro_update).some((x) => x != null)) {
      const next = applyMacroUpdate(macro, d.macro_update)
      setMacro(next)
      lines.push({ text: `🌍 Economy for every path: ${next.name}${describeMacro(next, profile.age).length ? ` (${describeMacro(next, profile.age).join(', ')})` : ''}` })
    }
    // 2) remove paths the user says were wrong
    const removable = d.remove_path_ids.filter((id) => id !== 'today' && byId.has(id))
    for (const id of removable) {
      lines.push({ text: `🗑 Removed “${byId.get(id)!.name}”` })
      remove(id)
    }
    // 2b) undo changes the user did not want ("I didn't want any changes to the others"): back to the previous version
    const undone = (d.undo_path_ids ?? []).filter((id) => (byId.get(id)?.history.length ?? 0) > 0 && !removable.includes(id))
    for (const id of undone) {
      lines.push({ text: `↶ Restored “${byId.get(id)!.history.at(-1)!.spec.name}” to how it was before`, pathId: id })
      undoEdit(id)
    }
    // 3) edit existing paths (one or several, e.g. "add a house to all paths"); old versions kept for undo
    const editedIds: string[] = []
    const editRecords: Record<string, PathEdit[]> = {}
    const editedSpecs: Record<string, ScenarioSpec> = {}
    const norm = (x: string) => x.trim().toLowerCase()
    for (const ed of d.edits ?? []) {
      const p = byId.get(ed.path_id) ?? computed.find((c) => c.id !== 'today' && norm(c.name) === norm(ed.path_id)) // by id, or by name if the AI used the name
      if (!p || p.id === 'today') {
        lines.push({ text: `⚠ I tried to change a path I couldn't find (“${ed.path_id}”), so nothing was changed there.` })
        continue
      }
      if (removable.includes(p.id) || editedIds.includes(p.id)) continue
      // the full new version, or (shorter) only events to add, everything else unchanged
      const base = undone.includes(p.id) ? p.history.at(-1)!.spec : p.spec // an undo in the same turn happens first
      const spec = ed.path ? keepSources(base, ed.path) : ed.add_events?.length ? { ...base, events: addEvents(base.events, ed.add_events) } : null
      if (!spec) continue
      if (JSON.stringify(spec.events) === JSON.stringify(base.events) && spec.name === base.name) {
        lines.push({ text: `⛔ No change: “${p.name}” already looked like that, so nothing was changed there.`, pathId: p.id })
        continue
      }
      editedSpecs[p.id] = spec
      const keepGlobal = Object.fromEntries(Object.entries(p.overrides).filter(([k]) => k.startsWith('g.')))
      const edits = [...p.edits, { instruction: text, changes: ed.changes, model: r.model, ms: r.ms, prompt: r.prompt }]
      editRecords[p.id] = edits
      update(p.id, (x) => ({ ...x, spec, overrides: keepGlobal, history: [...x.history, { spec: x.spec, overrides: x.overrides }], edits }))
      editedIds.push(p.id)
      lines.push({ text: `✏️ Changed ${spec.name}:`, pathId: p.id }, ...ed.changes.map((c) => ({ text: `✓ ${c}` })))
    }
    // an edited path that is not on screen joins the comparison as B
    if (editedIds.length) setSel((s) => (editedIds.some((id) => id === s.a || id === s.b) ? s : { a: s.a ?? 'today', b: editedIds.at(-1)! }))
    const editedId = editedIds[0] ?? null
    // 4) new paths and branches (they get a computed answer)
    const newSpecs: ScenarioSpec[] = d.new_paths.map(({ parent_id: _p, ...sc }) => sc)
    // a branch: the AI names its parent (or the chat is in branch mode); only valid ids count
    const parentIds = d.new_paths.map((np, i) => (np.parent_id && (byId.has(np.parent_id) || (/^new:\d+$/.test(np.parent_id) && Number(np.parent_id.slice(4)) < i)) ? np.parent_id : (fork?.id ?? null)))
    const res: ParseResult = { profile_update: u, scenarios: newSpecs, horizon_years: d.horizon_years, unsupported: d.unsupported, note: d.reply }
    const origin: Origin = { kind: 'ai', question: text, model: r.model, ms: r.ms, cached: r.cached, prompt: r.prompt, answer: res }
    const addedPaths = addPaths(newSpecs, origin, parentIds)
    const ids = addedPaths.map((a) => a.id)
    newSpecs.forEach((sc, i) => {
      const pid = parentIds[i]
      const parentName = pid?.startsWith('new:') ? newSpecs[Number(pid.slice(4))]?.name : pid && pid !== 'today' ? byId.get(pid)?.name : undefined
      lines.push({ text: `＋ ${sc.name}${parentName ? ` (branch of ${parentName})` : ''}: ${describeSpec(sc, profile.age)}`, pathId: ids[i] })
    })
    // the horizon only changes when the user talks about time, or a new event would fall off the chart
    const touchedEvents = [...newSpecs.flatMap((x) => x.events), ...Object.values(editedSpecs).flatMap((x) => x.events)]
    const needMonths = Math.max(0, ...touchedEvents.map((e) => (e.start_month ?? 0) + (e.duration_months ?? 0)))
    const talksAboutTime = /\b(years?|until|horizon|retire\w*|old|aged?|long[- ]term)\b|\b(at|by|until|till) \d{2}\b/i.test(text)
    const wantYears = talksAboutTime && d.horizon_years ? d.horizon_years : needMonths >= H ? Math.ceil(needMonths / 12) + 2 : null
    if (wantYears) setYears(Math.max(1, Math.min(40, wantYears)))
    // the discount rate for today's-money values (NPV): one for every path; only changes how paths are valued
    if (d.discount_rate_pct != null && Number.isFinite(d.discount_rate_pct)) {
      const disc = Math.max(0, Math.min(20, d.discount_rate_pct))
      setDiscountPct(disc)
      lines.push({ text: `⏳ Today’s-money values (NPV) now use a ${disc}% discount rate a year, for every path (was ${discountPct ?? DEFAULT_DISCOUNT_PCT}%). The simulation itself does not change.` })
    }

    // ---- does it actually take effect? Re-simulate what this turn touched, in the NEW state, and say it formally.
    // (The AI wrote its reply before any simulation; these notices come from the engine.)
    const profNext = u ? applyUpdates(profile, [{ id: 0, said: text, update: u }]) : profile
    const macroNext = d.macro_update && Object.values(d.macro_update).some((x) => x != null) ? applyMacroUpdate(macro, d.macro_update) : macro
    const Hnext = (wantYears ? Math.max(1, Math.min(40, wantYears)) : years) * 12
    const stateChanged = profNext !== profile || macroNext !== macro || Hnext !== H
    const toCheck = [
      ...addedPaths.map((a) => ({ name: a.spec.name, spec: a.spec, overrides: a.overrides })),
      ...Object.entries(editedSpecs).map(([id, sp]) => ({ name: sp.name, spec: sp, overrides: byId.get(id)?.overrides ?? {} })),
      ...(stateChanged ? computed.filter((c) => !editedSpecs[c.id] && !removable.includes(c.id)).map((c) => ({ name: c.id === 'today' ? 'the baseline' : c.name, spec: c.spec, overrides: c.overrides })) : []),
    ]
    const issues = new Map<string, 'blocked' | 'risk'>()
    let blockedNew = false
    toCheck.forEach((x, i) => {
      const pl = resolve(profNext, params, x.spec, x.overrides, Hnext, loanRate, macroNext)
      for (const is of effectIssues(x.name, x.spec, pl, simulate(pl, params, profNext, 200), profNext)) {
        if (is.level === 'risk' && i >= addedPaths.length + Object.keys(editedSpecs).length) continue // untouched paths: only what stops working
        issues.set(is.text, is.level)
        if (is.level === 'blocked' && i < addedPaths.length) blockedNew = true
      }
    })
    const notes = [...issues.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] === 'blocked' ? -1 : 1))
    for (const [t, lvl] of notes.slice(0, 6)) lines.push({ text: `${lvl === 'blocked' ? '⛔ Not taking effect: ' : '⚠ '}${t}` })
    if (notes.length > 6) lines.push({ text: `(+${notes.length - 6} more notices: see the warnings on the paths)` })
    // the twin's own words may only use numbers it was given (also typed numbers per month / per year)
    const typed = [...text.matchAll(/(\d[\d'’,.]*)\s*(k|m|million)?\b/gi)].map((mm) => Number(mm[1].replace(/['’,]/g, '')) * (/^k$/i.test(mm[2] ?? '') ? 1e3 : mm[2] ? 1e6 : 1)).filter(Number.isFinite)
    // ages and years of the decisions on screen / just made ("a flat at 28") are facts too
    const seenEvents = [...touchedEvents, ...computed.flatMap((c) => c.spec.events)]
    const startYear = Number(profile.as_of.slice(0, 4))
    const ages = seenEvents.flatMap((e) => [ageAt(e.start_month ?? 0), ageAt((e.start_month ?? 0) + (e.duration_months ?? 0))])
    const calendar = seenEvents.map((e) => startYear + Math.floor((e.start_month ?? 0) / 12))
    // numbers inside a question ("want me to test 4,000?") are suggestions, not claims
    const claimsOnly = d.reply.split(/(?<=[.!?])\s+/).filter((x) => !x.trim().endsWith('?')).join(' ')
    const months = seenEvents.flatMap((e) => [e.start_month ?? 0, e.duration_months ?? 0])
    const balanceNext = Math.round(profNext.income - profNext.rent - profNext.calib.other_mu)
    const v = verifyNumbers(claimsOnly, { state, paths: pathsNow, text, typed, perMonth: typed.map((x) => x / 12), perYear: typed.map((x) => x * 12), history: historyFor().map((h) => h.text), ages, calendar, endAge, months, balanceNext })
    // honesty guard: the twin says it did something, but nothing was applied in this turn
    const claims = /\b(done|fixed|fixing (it )?now|i'?ve (added|changed|set|moved|split|rebuilt|put|updated|made|created|removed|replaced|renamed)|i (added|changed|set|moved|rebuilt|updated|made|created|replaced)|is now (set|at|in)|are now (set|at))\b/i.test(d.reply)
    const acted = lines.length > 0 || undone.length > 0
    const muted = [d.unsupported.length ? `Not modelled: ${d.unsupported.join('; ')}.` : '', v.unmatched.length ? `ℹ calculated by the twin (not from the simulator): ${v.unmatched.join(', ')}` : '', claims && !acted ? '⚠ Nothing was actually changed in this turn. Ask again, or change it yourself in the tile (✏️ Change) or under “Assumptions”.' : ''].filter(Boolean).join(' ')
    // a direct answer only makes sense for a question, not for "add 10 paths"
    const bulk = ids.length >= 3 || (/^\s*(please\s+)?(add|create|make|generate|branch|give|put|build|spin|show|draw)\b/i.test(text) && !text.includes('?'))
    const answerIt = ids.length > 0 && !bulk && !blockedNew // never "answer" about a decision that cannot take effect
    replace(reply, {
      pending: false,
      reply: d.reply,
      lines,
      muted: muted || undefined,
      answer: answerIt ? null : undefined,
      details: ids.length
        ? () => setHowMade({ what: 'path', name: newSpecs[0].name, origin, spec: newSpecs[0] })
        : editedId
          ? () => { const sp = editedSpecs[editedId]; const p = paths.find((x) => x.id === editedId); if (sp && p) setHowMade({ what: 'path', name: sp.name, origin: p.origin, spec: sp, edits: editRecords[editedId] }) }
          : lines.length
            ? () => setHowMade({ what: 'answer', prompt: r.prompt, answer: { short_answer: d.reply, reasoning: '', confidence_level: 'medium', confidence_sentence: '' }, model: r.model, ms: r.ms, offline: false, verify: v })
            : undefined, // a plain chat reply: nothing to explain
    } as Partial<ChatMsg>)
    if (answerIt) setAsked({ question: text, ids, msg: reply })
    setAsking(false)
    setEditing(null)
  }
  const startMode = (kind: 'edit' | 'fork', id: string) => {
    const c = byId.get(id)
    if (!c) return
    setMode({ kind, id, name: c.name, ideas: kind === 'edit' ? followUpIdeas(c.spec) : branchIdeas(c.spec, profile) })
    setAdding(null)
    setTimeout(() => chat.current?.focus(), 30)
  }

  // ------------------------------------------------------------ the A/B comparison: computed first, then the AI's words
  const side = useCallback(
    (c: Computed, unk: typeof unkA): Side => ({ id: c.id, name: c.name, spec: c.spec, plan: c.plan, result: c.result, parentName: c.parentId ? (byId.get(c.parentId)?.name ?? null) : null, madeBy: madeBy(c.origin), unknownFromAge: unk ? ageAt(unk.from) : null }),
    [byId, ageAt],
  )
  const sideA = useMemo(() => (A ? side(A, unkA) : null), [A, unkA, side])
  const sideB = useMemo(() => (B ? side(B, unkB) : null), [B, unkB, side])
  const pair = sideA && sideB && sideA.id !== sideB.id
  const vAB = useMemo(() => {
    if (!A || !B || A.id === B.id) return null
    const asPath = (c: Computed): ComparedPath => ({ id: c.id, name: c.name, spec: c.spec, overrides: c.overrides, plan: c.plan, result: c.result })
    return computeVerdict('Which path ends with more net worth?', asPath(A), asPath(B), profile, params, H, loanRate, macro)
  }, [A, B, profile, params, H, loanRate, macro])
  const fitAB = useMemo(() => (pair ? goalFit(sideA!, sideB!, profile) : null), [pair, sideA, sideB, profile])
  const told = useMemo(() => [...describeMemory(dataProfile, updates), ...goalEdits.added.map((g) => `new goal: ${g.name} ${chfk(g.target)} by ${g.date.slice(0, 4)}`), ...goalEdits.removed.map((n) => `goal removed: ${n}`)], [dataProfile, updates, goalEdits])
  const beAB = useMemo(() => (vAB?.flip && vAB.flip.pct > 0 ? { path: vAB.other.name, other: vAB.leader.name, pct: vAB.flip.pct, fromAge: vAB.flip.fromAge } : null), [vAB])
  // canonical order (by id) -> swapping A and B does not cost a new AI call
  const facts = useMemo(() => {
    const ss = [sideA, sideB].filter((x): x is Side => !!x).filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i).sort((x, y) => (x.id < y.id ? -1 : 1))
    if (!ss.length) return null
    const [first, second = null] = ss
    return compareFacts({ profile, H, first, second, verdict: vAB, fit: second ? goalFit(first, second, profile) : null, breakEven: beAB, economy, told })
  }, [sideA, sideB, profile, H, vAB, beAB, economy, told])
  const factsKey = facts ? JSON.stringify(facts) : ''
  const firstId = facts ? [sideA, sideB].filter((x): x is Side => !!x).sort((x, y) => (x.id < y.id ? -1 : 1))[0].id : null
  const [cmp, setCmp] = useState<CompareState | null>(null)
  const cmpSeq = useRef(0)
  const runCompare = useCallback(async (key: string) => {
    const f = JSON.parse(key)
    const id = ++cmpSeq.current
    const r = await apiCompare(f)
    if (id !== cmpSeq.current) return // a newer request was sent meanwhile
    if (r.ok) {
      const d = r.data
      setCmp({ key, status: 'ai', data: d, model: r.model, prompt: r.prompt, ms: r.ms, verify: verifyNumbers([d.first.so_far, d.first.ahead, d.second?.so_far, d.second?.ahead, d.comparison, d.caveat].filter(Boolean).join(' '), f) })
    } else setCmp({ key, status: 'offline', data: templateCompare(f) })
  }, [])
  useEffect(() => {
    if (!factsKey) return
    const t = setTimeout(() => runCompare(factsKey), 600)
    return () => clearTimeout(t)
  }, [factsKey, runCompare])
  const tmpl = useMemo(() => (factsKey ? templateCompare(JSON.parse(factsKey)) : null), [factsKey])
  const shown = cmp && cmp.key === factsKey ? cmp : null
  const text = shown?.data ?? tmpl
  const textStatus: 'loading' | 'ai' | 'offline' = shown ? shown.status : 'loading'
  const storyOf = (id: string) => (text ? (id === firstId ? text.first : text.second) : null)

  // ------------------------------------------------------------ view data
  const treeItems: TreeItem[] = useMemo(
    () =>
      computed.map((c) => {
        const b = breach(c.result, profile.minCash)
        return { id: c.id, parentId: c.parentId, name: c.id === 'today' ? 'Today · no change' : c.name, icons: sortedEvents(c.spec).slice(0, 6).map(iconOf).join(''), endNW: c.result.endNW.p50, risk: b >= 0.5 ? 'bad' : b > 0.05 ? 'warn' : 'ok', busy: editing === c.id, gap: linkGap(c, c.parentId ? byId.get(c.parentId) : undefined, profile.age) }
      }),
    [computed, byId, editing, profile.age, profile.minCash],
  )
  const tileOf = (c: Computed, key: 'a' | 'b', unk: typeof unkA): TileData => ({
    key, id: c.id, name: c.id === 'today' ? 'If nothing changes' : c.name, parentName: c.parentId && c.parentId !== 'today' ? (byId.get(c.parentId)?.name ?? null) : null,
    timeline: sortedEvents(c.spec).map((e) => ({ icon: iconOf(e), age: ageAt(e.start_month ?? 0), text: e.label })),
    result: c.result, warnings: c.plan.warnings, unknownFromAge: unk ? ageAt(unk.from) : null, canUndo: c.history.length > 0, removable: c.id !== 'today',
    assumed: c.plan.assumptions.filter((a) => !a.key.startsWith('g.') && !a.key.startsWith('m.') && !a.key.startsWith('v.') && a.source !== 'you' && !a.key.endsWith('.info') && a.key !== 'learned.delta').length,
    discount: { pct: c.plan.discountRate * 100, mine: discountPct != null },
  })
  const tA = A ? tileOf(A, 'a', unkA) : null
  const tB = B && B.id !== A?.id ? tileOf(B, 'b', unkB) : null
  const chartSides: ChartSide[] = [
    ...(A ? [{ key: 'a' as const, name: A.name, plan: A.plan, result: A.result, unknownFrom: unkA?.from ?? null, markers: sortedEvents(A.spec).map((e) => ({ month: e.start_month ?? 0, icon: iconOf(e), text: e.label })) }] : []),
    ...(B && B.id !== A?.id ? [{ key: 'b' as const, name: B.name, plan: B.plan, result: B.result, unknownFrom: unkB?.from ?? null, markers: sortedEvents(B.spec).map((e) => ({ month: e.start_month ?? 0, icon: iconOf(e), text: e.label })) }] : []),
  ]
  const numFor = numbers.tab === 'b' && B ? B : (A ?? B ?? today)
  const liveChecks = useMemo(() => checks(numFor.plan, params, profile), [numFor, params, profile])
  const openNumbers = (tab: 'a' | 'b') => {
    setNumbers({ open: true, tab })
    setTimeout(() => numbersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
  }
  const runsOut = today.result.probNegCash >= 0.5 && today.result.firstNegMonth != null
  const branchFrom = adding ? byId.get(adding) : undefined

  // ------------------------------------------------------------ the divider between chat and the rest
  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    document.body.classList.add('dragging')
    let w = chatW
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(Math.max(ev.clientX, 300), window.innerWidth * 0.6))
      setChatW(w)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
      try {
        localStorage.setItem('twin-chat-w', String(w))
      } catch {
        /* storage blocked: the width just isn't remembered */
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="app" style={{ ['--chat-w' as string]: `${chatW}px` }}>
      <nav className="nav">
        <span className="brand">
          <span className="logo" /> Financial Twin
        </span>
        <span className="spacer" />
        <select className="person-pick" value={profileId} onChange={(e) => reset(e.target.value)} title="pick another fictional person">
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}, {p.age}, {p.city}, {p.status}
            </option>
          ))}
        </select>
        <button className="btn-ghost" onClick={loadDemo}>
          ▶ Demo
        </button>
      </nav>

      <div className="work">
        <aside className="chat-pane">
          <Chat ref={chat} messages={thread} busy={asking || editing != null} llm={llm} mode={mode} ideas={examples} onClearMode={() => setMode(null)} onSend={(t) => talk(t)} onPath={(id) => setSel((s) => (id === s.a || id === s.b ? s : { a: s.a ?? 'today', b: id }))} />
        </aside>
        <div className="splitter" onPointerDown={drag} onDoubleClick={() => setChatW(420)} title="drag to resize · double-click to reset" role="separator" aria-orientation="vertical" />

        <main className="main">
          {/* ---------------- who ---------------- */}
          <section className="person-bar">
            <div className="avatar">{profile.name[0]}</div>
            <div className="person-text">
              <div className="person-name">
                {profile.name}, {profile.age} <span className="muted">· {profile.city} · {profile.status.replace('_', ' ')} · {profile.household.replace('_', ' ')}</span>
              </div>
              <div className="person-facts">
                <span>{chf(profile.cash)} saved</span>
                <span>earns {chf(profile.income)}/mo</span>
                <span>rent {chf(profile.rent)}/mo</span>
                {profile.investments > 0 && <span>invested {chfk(profile.investments)}</span>}
                {profile.goals.map((g) => (
                  <span key={g.name} title={`${g.priority} priority`}>
                    🎯 {g.name} {chfk(g.target)} by {g.date.slice(0, 4)}
                  </span>
                ))}
              </div>
            </div>
            <p className="hook">
              If nothing changes,{' '}
              {runsOut ? (
                <>
                  cash <span className="neg">runs out at {ageAt(today.result.firstNegMonth!)}</span>.
                </>
              ) : (
                <>
                  about <span className="pos">{chfk(today.result.endNW.p50)}</span> at {endAge}.
                </>
              )}
            </p>
          </section>
          {told.length > 0 && (
            <div className="memory">
              <span className="eyebrow">The twin knows</span>
              {told.map((m) => (
                <span key={m} className="mem-chip">
                  {m}
                </span>
              ))}
              <button className="link-btn" onClick={() => (setUpdates([]), setGoalEdits({ added: [], removed: [] }))} title="forget everything you told the twin">
                ↶ reset to the data
              </button>
            </div>
          )}

          {/* ---------------- the tree ---------------- */}
          <section className="card tree-card">
            <div className="card-head">
              <h2>Your paths</h2>
              <span className="muted small">
                click two to compare: 1st = <span className="ab ab-a">A</span> 2nd = <span className="ab ab-b">B</span> · <b>+</b> on a node branches off it (keeps its decisions, adds one)
              </span>
              <span className="spacer" />
              {A && B && (
                <button className="chip chip-soft" onClick={swap} title="swap A and B">
                  ⇄ Swap
                </button>
              )}
              <button className="chip chip-new" onClick={() => setAdding(adding ? null : (sel.b ?? sel.a ?? 'today'))}>
                + New path
              </button>
            </div>
            <Tree
              key={profileId}
              items={treeItems}
              a={sel.a}
              b={sel.b}
              collapsed={collapsed}
              onPick={pick}
              onBranch={(id) => setAdding((cur) => (cur === id ? null : id))}
              onToggle={toggleFold}
              onEditGap={editGap}
              onCloseAdd={() => setAdding(null)}
              addCard={
                branchFrom
                  ? {
                      id: branchFrom.id,
                      title: branchFrom.id === 'today' ? 'New path from today' : <>Branch off <b>{branchFrom.name}</b></>,
                      body: (
                        <>
                          <p className="add-lead">{branchFrom.id === 'today' ? 'Starts from today’s numbers. Pick one, or describe your own.' : `Keeps every decision of “${branchFrom.name}” and adds one more.`}</p>
                          <button className="add-chat" onClick={() => startMode('fork', branchFrom.id)}>
                            <span>✦</span> Describe it in the chat…
                          </button>
                          <div className="add-sub">Ready-made · instant, no AI</div>
                          <div className="add-list">
                            {quick.map((q) => (
                              <button key={q.id} className="add-item" title={q.desc} onClick={() => branchPreset(q, branchFrom.id)}>
                                <b>+ {q.label}</b>
                                <small>{q.desc}</small>
                              </button>
                            ))}
                          </div>
                        </>
                      ),
                    }
                  : null
              }
            />
          </section>

          {/* ---------------- A and B: a clear break between the tree (exploring) and the text (understanding) ---------------- */}
          <div className="section-rule" role="separator">
            <span>
              {tA && tB ? (
                <>
                  Comparing <span className="ab ab-a">A</span> {tA.name} <span className="muted">vs</span> <span className="ab ab-b">B</span> {tB.name}
                </>
              ) : (
                <>What’s going on {tA ? <>in <span className="ab ab-a">A</span> {tA.name}</> : tB ? <>in <span className="ab ab-b">B</span> {tB.name}</> : ''}</>
              )}
            </span>
          </div>
          {(tA || tB) && (
            <div className={`tiles ${tA && tB ? '' : 'tiles-one'}`}>
              {[tA, tB].map((t, i) =>
                t ? (
                  <NodeTile
                    key={t.key}
                    t={t}
                    age={profile.age}
                    endAge={endAge}
                    floor={profile.minCash}
                    story={storyOf(t.id)}
                    status={textStatus}
                    busy={editing === t.id}
                    onChange={() => (t.id === 'today' ? startMode('fork', 'today') : startMode('edit', t.id))}
                    onBranch={() => startMode('fork', t.id)}
                    onUndo={() => undoEdit(t.id)}
                    onRemove={() => remove(t.id)}
                    onNumbers={() => openNumbers(t.key)}
                  />
                ) : (
                  <div key={`empty${i}`} className="tile tile-empty">
                    <span className={`ab ab-${i ? 'b' : 'a'}`}>{i ? 'B' : 'A'}</span>
                    <p>Click {i ? 'another' : 'a'} path in the tree to compare it here, or add one with <b>+ New path</b>.</p>
                  </div>
                ),
              )}
            </div>
          )}
          {tA && tB && (
            <Comparison
              a={tA}
              b={tB}
              age={profile.age}
              floor={profile.minCash}
              text={text?.comparison || null}
              caveat={text?.caveat ?? null}
              status={textStatus}
              verify={shown?.verify}
              verdict={vAB}
              fit={fitAB}
              breakEven={beAB}
              model={shown?.model}
              onPrompt={shown?.status === 'ai' ? () => setHowMade({ what: 'explanation', prompt: shown.prompt, answer: { headline: `${tA.name} vs ${tB.name}`, explanation: [shown.data.first.so_far, shown.data.first.ahead, shown.data.second?.so_far, shown.data.second?.ahead, shown.data.comparison].filter(Boolean).join(' '), caveat: shown.data.caveat }, model: shown.model, ms: shown.ms, offline: false, verify: shown.verify }) : undefined}
              onRewrite={() => factsKey && runCompare(factsKey)}
            />
          )}
          {!(tA && tB) && text && (
            <p className="muted small solo-meta">
              {textStatus === 'loading' ? 'writing…' : textStatus === 'ai' ? `written by AI from the simulator’s numbers${shown?.verify ? (shown.verify.unmatched.length ? ` · ⚠ ${shown.verify.unmatched.length} number(s) not found` : ` · ✓ all ${shown.verify.total} numbers checked`) : ''}` : 'written by a template (AI offline)'} · ⚠ {text.caveat}
            </p>
          )}

          {/* ---------------- by year ---------------- */}
          {chartSides.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Year by year</h2>
                <span className="chart-legend">
                  {chartSides.map((s) => (
                    <span key={s.key}>
                      <i className={`sw sw-${s.key}`} /> <b>{s.key.toUpperCase()}</b> {s.name}
                    </span>
                  ))}
                  <span className="muted">shaded = where 8 in 10 futures land{chartSides.some((s) => s.unknownFrom != null) ? ' · dotted = depends on unknown numbers' : ''}</span>
                </span>
                <span className="spacer" />
                <select className="mini" value={years} onChange={(e) => setYears(Number(e.target.value))}>
                  {[...new Set([3, 5, 10, 20, 30, years])].sort((a, b) => a - b).map((y) => (
                    <option key={y} value={y}>
                      {y} years
                    </option>
                  ))}
                </select>
              </div>
              <div className="charts">
                <div>
                  <h3 className="chart-title">
                    Net worth <span className="muted small">everything you own − debts</span>
                  </h3>
                  <CompareChart sides={chartSides} metric="nw" profile={profile} years={years} observed={false} />
                </div>
                <div>
                  <h3 className="chart-title">
                    Cash in the bank <span className="muted small">money you can spend</span>
                  </h3>
                  <CompareChart sides={chartSides} metric="cash" profile={profile} years={years} observed={!updates.length} />
                </div>
                <div>
                  <h3
                    className="chart-title"
                    title={`Each point = what the path is worth today if you stopped counting at that age. It is net worth, except that money arriving or leaving later counts a bit less: at ${discountPct ?? DEFAULT_DISCOUNT_PCT}% a year, CHF 1 in 1 year ≈ ${todayValueOf1(discountPct ?? DEFAULT_DISCOUNT_PCT, 1)} today and CHF 1 in 10 years ≈ ${todayValueOf1(discountPct ?? DEFAULT_DISCOUNT_PCT, 10)}. So costs paid early weigh more than gains that come late. At 0% this chart equals the net worth chart. It only changes how paths are valued, not the simulation. (Finance name: net present value, NPV.)`}
                  >
                    What each path is worth today{' '}
                    <span className="muted small">
                      later money counts less: CHF 1 in 10 years ≈ {todayValueOf1(discountPct ?? DEFAULT_DISCOUNT_PCT, 10)} today ({discountPct ?? DEFAULT_DISCOUNT_PCT}% a year, {discountPct == null ? 'default assumption' : 'your rate'}; change it under “Assumptions” or in the chat)
                    </span>
                  </h3>
                  <CompareChart sides={chartSides} metric="npv" profile={profile} years={years} observed={false} />
                </div>
              </div>
              {profile.goals.length > 0 && (
                <div className="goals">
                  {profile.goals.map((g) => (
                    <div key={g.name} className="goal">
                      <span className="goal-title">
                        🎯 <b>{g.name}</b>: {chf(g.target)} by {g.date.slice(0, 7)} <span className="muted">(age {ageAt(monthIndex(profile.as_of, g.date) + 1)} · {g.priority === 'yours' ? 'added by you' : `${g.priority} priority`})</span>
                      </span>
                      <span className="goal-hits">
                        {chartSides.map((s) => {
                          const r = s.result.goals.find((x) => x.name === g.name)
                          return (
                            <span key={s.key} className={`goal-hit gh-${s.key}`} title={s.name}>
                              {s.key.toUpperCase()} {r?.prob == null ? '—' : (r.prob >= 0.5 ? '✓ ' : '✗ ') + Math.round(r.prob * 100) + '%'}
                            </span>
                          )
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <details className="mini-fold caption">
                <summary>How to read these charts</summary>
                Lines = the typical (median) outcome of 500 simulated futures, one point per year; both paths use the same random months, so differences come from the decisions. Shaded = where 8 in 10 futures land. Black dots = the real bank balance in UBS’s data (observed, not simulated). 🎯 = a goal (amount and date); a path reaches it if cash + investments are above it at that date, and the % is the share of futures that do. Buying a home drops cash by the down payment but not net worth: the money becomes part of the home. “What each path is worth today” is the net worth chart with later money counting a bit less (at {discountPct ?? DEFAULT_DISCOUNT_PCT}% a year, CHF 1 in 10 years ≈ {todayValueOf1(discountPct ?? DEFAULT_DISCOUNT_PCT, 10)} today), so a path that pays early and earns late looks worse there than in plain net worth. In constant 2025 francs, income after tax.
              </details>
            </section>
          )}

          {/* ---------------- sensitivity: what if an assumption is off? ---------------- */}
          {chartSides.length > 0 && <Sensitivity sides={chartSides.map((s) => ({ key: s.key, name: s.name, plan: s.plan }))} params={params} endAge={endAge} />}

          {/* ---------------- everything else, folded ---------------- */}
          <details className="card fold" ref={numbersRef} open={numbers.open} onToggle={(e) => setNumbers((n) => ({ ...n, open: (e.target as HTMLDetailsElement).open }))}>
            <summary>
              <h2>Assumptions</h2>
              <span className="muted small">what the twin filled in for you and why · every number has a source · click a value to change it</span>
            </summary>
            {A && B && A.id !== B.id && (
              <div className="seg">
                <button className={numbers.tab === 'a' ? 'on' : ''} onClick={() => setNumbers({ open: true, tab: 'a' })}>
                  A · {A.name}
                </button>
                <button className={numbers.tab === 'b' ? 'on' : ''} onClick={() => setNumbers({ open: true, tab: 'b' })}>
                  B · {B.name}
                </button>
              </div>
            )}
            <p className="made-by small">
              <span className="muted">What it does:</span> {describeSpec(numFor.spec, profile.age)}. <span className="muted">Made by:</span> {madeBy(numFor.origin)}
              {numFor.edits.length > 0 && `, then ${numFor.edits.length} follow-up${numFor.edits.length > 1 ? 's' : ''}`} ·{' '}
              <button className="link-btn" onClick={() => setHowMade({ what: 'path', name: numFor.name, origin: numFor.origin, spec: numFor.spec, edits: numFor.edits })}>
                {numFor.origin.kind === 'ai' || numFor.edits.length ? 'see the prompt' : 'see how'}
              </button>{' '}
              ·{' '}
              <button
                className="link-btn"
                title="the 15 fields UBS asks every scenario to document (scenario-modelling.md §20)"
                onClick={() => {
                  const ref = numFor.id === A?.id ? (B && B.id !== A.id ? B : today) : (A ?? today)
                  downloadJson(`scenario-${numFor.name.replace(/\W+/g, '-').toLowerCase()}.json`, scenarioReport({ profile, path: numFor, baseline: ref, macro, years, drivers: drivers(numFor.plan, params), checks: liveChecks, params, breakEvenPct: null }))
                }}
              >
                ⬇ scenario report (UBS template)
              </button>
            </p>
            {numFor.plan.warnings.map((w) => (
              <p key={w} className="warn small">
                ⚠ {w}
              </p>
            ))}
            <AssumptionList
              items={numFor.plan.assumptions}
              overrides={numFor.overrides}
              onChange={(key, v) =>
                key.startsWith('v.')
                  ? setDiscountPct(v == null ? null : Math.max(0, Math.min(20, v)))
                  : key.startsWith('m.')
                  ? v != null && setMacro(editMacro(macro, key, v))
                  : update(numFor.id, (p) => {
                      const o = { ...p.overrides }
                      if (v == null) delete o[key]
                      else o[key] = v
                      return { ...p, overrides: o }
                    })
              }
            />
            <p className="muted small" style={{ marginTop: 10 }}>What matters most, and what if an assumption is off: see <b>Sensitivity</b> above.</p>
          </details>

          <details className="card fold">
            <summary>
              <h2>The economy</h2>
              <span className="muted small">
                {macro.name} · the same for every path, so decisions are compared fairly
              </span>
            </summary>
            <EconomyBar macro={macro} age={profile.age} onPick={setMacro} />
          </details>

          <details className="card fold">
            <summary>
              <h2>How the model & simulations work</h2>
              <TrustSummary checks={liveChecks} params={params} verify={shown?.status === 'ai' ? shown.verify : undefined} />
            </summary>
            <TrustDetails params={params} checks={liveChecks} focusName={numFor.name} />
          </details>

          <HowMade content={howMade} onClose={() => setHowMade(null)} />

          <footer className="muted small">
            Fictional people and synthetic data (UBS × LauzHack 2026 challenge). Results depend on the assumptions shown. A simulation, not a forecast. Not financial advice.
          </footer>
        </main>
      </div>
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
  if (key === 'm.dur' && n.forecast) n.forecast = { ...n.forecast, job_search_months: Math.max(1, v) }
  if (key === 'm.wage' && n.forecast) n.forecast = { ...n.forecast, real_wage_growth_pct: v }
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
  line('home you own', data.home ?? 0, now.home ?? 0)
  if ((now.minCash ?? 0) !== (data.minCash ?? 0)) out.push(now.minCash ? `cash never below ${chf(now.minCash)} (your floor)` : 'no cash floor')
  return out
}
