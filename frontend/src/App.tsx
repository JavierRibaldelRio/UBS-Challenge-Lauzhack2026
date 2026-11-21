import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectionChart, type Marker } from './components/Chart'
import { AssumptionList, Drivers } from './components/Details'
import { AnswerCard } from './components/Answer'
import { HowMade, type HowMadeContent } from './components/HowMade'
import { answerFacts, templateAnswer, verdict as computeVerdict, type ComparedPath } from './lib/answer'
import { suggestQuestions } from './lib/suggest'
import { OutcomeCard } from './components/Outcome'
import { TrustDetails, TrustSummary } from './components/Trust'
import { breakEven, buildFacts, drivers, templateExplanation, verifyNumbers } from './lib/analysis'
import { apiAnswer, apiExplain, apiHealth, apiParse } from './lib/api'
import { offlineParse } from './lib/fallback'
import { chf, chfk, monthIndex } from './lib/fmt'
import { cities, describeSpec, medianLoanRate, presets, resolve, type Overrides, type Preset } from './lib/resolve'
import { checks, simulate } from './lib/sim'
import type { AnswerResult, ExplainResult, Origin, Params, Profile, PromptInfo, ScenarioSpec } from './lib/types'
import paramsJson from './model/params.json'
import profilesJson from './model/profiles.json'

const COLORS = ['#64748b', '#2563eb', '#e11d48', '#059669', '#7c3aed', '#d97706', '#0891b2']
type PathState = { id: string; spec: ScenarioSpec; overrides: Overrides; color: string; origin: Origin }
const TODAY = (): PathState => ({ id: 'today', spec: { name: 'If nothing changes', catalog_id: null, events: [] }, overrides: {}, color: COLORS[0], origin: { kind: 'today' } })
// small icons on the chart where the selected path's life events happen
const ICON: Record<string, string> = { start_job: '💼', study: '🎓', relocate: '🚚', income_change: '📉', household_change: '👶', recurring_expense: '🔁', one_off: '💸', invest: '📈', market_shock: '📉', take_loan: '🏦', buy_home: '🏠' }
function markersFor(spec: ScenarioSpec, H: number): Marker[] {
  return spec.events
    .map((e) => ({ month: Math.max(0, Math.min(H - 1, e.start_month ?? 0)), icon: e.type === 'household_change' && e.household_type === 'couple' ? '💑' : e.type === 'income_change' && (e.income_change_pct ?? 0) > 0 ? '📈' : e.type === 'one_off' && (e.amount_chf ?? 0) < 0 ? '🎁' : ICON[e.type], text: e.label }))
    .filter((m) => m.month > 0) // events "now" sit on the axis; no marker needed
}
const fromPreset = (p: Preset): Origin => ({ kind: 'preset', button: p.label, desc: p.desc })

type Explain = { status: 'loading' | 'ai' | 'offline'; data: ExplainResult; model?: string; cached?: boolean; error?: string; verify?: { total: number; unmatched: string[] }; prompt?: PromptInfo; ms?: number }

// Model artifacts are bundled (built by ml/train.py) -> no runtime fetch that could fail during a demo.
export default function App() {
  return <Twin params={paramsJson as unknown as Params} profiles={profilesJson as unknown as Profile[]} />
}

function Twin({ params, profiles }: { params: Params; profiles: Profile[] }) {
  const [profileId, setProfileId] = useState('P00001')
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]
  const [years, setYears] = useState(10)
  const H = years * 12
  const [paths, setPaths] = useState<PathState[]>([TODAY()])
  const [baselineId, setBaselineId] = useState('today')
  const [focusId, setFocusId] = useState('today')
  const [metric, setMetric] = useState<'nw' | 'cash'>('nw')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState<{ text: string; unsupported: string[]; by: string } | null>(null)
  const [llm, setLlm] = useState<{ model: string } | null | undefined>(undefined)
  const [explain, setExplain] = useState<Explain | null>(null)
  const [howMade, setHowMade] = useState<HowMadeContent | null>(null)
  // the last question and the paths it created -> a direct answer (separate from the explanation card)
  const [asked, setAsked] = useState<{ question: string; ids: string[] } | null>(null)
  const [answer, setAnswer] = useState<{ status: 'loading' | 'ai' | 'offline'; data: AnswerResult | null; prompt?: PromptInfo; model?: string; ms?: number; verify?: { total: number; unmatched: string[] } } | null>(null)
  const examples = useMemo(() => suggestQuestions(profile, params), [profile, params])
  const nextId = useRef(1)
  const loanRate = useMemo(() => medianLoanRate(profiles), [profiles])
  const cityList = useMemo(() => cities(params), [params])
  const quick = useMemo(() => presets(profile, params), [profile, params])

  useEffect(() => {
    apiHealth().then((h) => setLlm(h.ok ? h.llm : null))
  }, [])

  const reset = (id: string, next: PathState[] = [TODAY()], base = 'today', focus = 'today') => {
    setProfileId(id)
    setPaths(next)
    setBaselineId(base)
    setFocusId(focus)
    setNote(null)
    setExplain(null)
    setAsked(null)
    setAnswer(null)
  }
  const addPaths = useCallback((specs: ScenarioSpec[], origin: Origin) => {
    const added = specs.map((spec) => {
      const n = nextId.current++
      return { id: `p${n}`, spec, overrides: {}, color: COLORS[((n - 1) % (COLORS.length - 1)) + 1], origin }
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
      return { id: `d${i}`, spec: p.spec, overrides: {}, color: COLORS[i], origin: fromPreset(p) }
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
        const plan = resolve(profile, params, p.spec, p.overrides, H, loanRate)
        return { ...p, name: p.spec.name, plan, result: simulate(plan, params, profile), isBaseline: p.id === baselineId }
      }),
    [paths, profile, params, H, loanRate, baselineId],
  )
  const baseline = computed.find((c) => c.isBaseline) ?? computed[0]
  const focus = computed.find((c) => c.id === focusId) ?? baseline
  const today = computed.find((c) => c.id === 'today') ?? computed[0]
  const drv = useMemo(() => drivers(focus.plan, params), [focus, params])
  const be = useMemo(() => (focus.id !== baseline.id ? breakEven(focus.plan, baseline.plan, params) : null), [focus, baseline, params])
  const liveChecks = useMemo(() => checks(focus.plan, params, profile), [focus, params, profile])
  const facts = useMemo(() => buildFacts(profile, params, computed, drv, be, focus.id), [profile, params, computed, drv, be, focus.id])
  const factsKey = JSON.stringify(facts)

  // ------------------------------------------------------------ the direct answer to the last question (computed verdict + AI wording)
  const verdict = useMemo(() => {
    if (!asked) return null
    const mine = asked.ids.map((id) => computed.find((c) => c.id === id)).filter((c): c is (typeof computed)[number] => !!c)
    if (!mine.length) return null
    const asPath = (c: (typeof computed)[number]): ComparedPath => ({ id: c.id, name: c.name, spec: c.spec, overrides: c.overrides, plan: c.plan, result: c.result })
    // one new path -> compare with the baseline; several -> compare the two that end highest
    let pair: (typeof computed)[number][]
    if (mine.length === 1) {
      const ref = baseline.id !== mine[0].id ? baseline : (computed.find((c) => c.id !== mine[0].id) ?? baseline)
      pair = [mine[0], ref]
    } else pair = [...mine].sort((x, y) => y.result.endNW.p50 - x.result.endNW.p50).slice(0, 2)
    if (pair[0].id === pair[1].id) return null
    return computeVerdict(asked.question, asPath(pair[0]), asPath(pair[1]), profile, params, H, loanRate)
  }, [asked, computed, baseline, profile, params, H, loanRate])
  const ansFacts = useMemo(() => (verdict ? answerFacts(verdict, profile, params, H) : null), [verdict, profile, params, H])
  const ansKey = ansFacts ? JSON.stringify(ansFacts) : ''
  const answerSeq = useRef(0)
  useEffect(() => {
    if (!ansKey) return
    const f = JSON.parse(ansKey) 
    const id = ++answerSeq.current
    setAnswer((s) => (s?.data ? { ...s, status: 'loading' } : { status: 'loading', data: null }))
    const t = setTimeout(async () => {
      const r = await apiAnswer(f)
      if (id !== answerSeq.current) return
      if (r.ok) setAnswer({ status: 'ai', data: r.data, prompt: r.prompt, model: r.model, ms: r.ms, verify: verifyNumbers(`${r.data.short_answer} ${r.data.reasoning} ${r.data.confidence_sentence}`, f) })
      else setAnswer({ status: 'offline', data: templateAnswer(f) })
    }, 300)
    return () => clearTimeout(t)
  }, [ansKey])

  // ------------------------------------------------------------ explanation: instant template, then the LLM (verified)
  const explainSeq = useRef(0)
  const runExplain = useCallback(async (f: typeof facts) => {
    const id = ++explainSeq.current
    const r = await apiExplain(f)
    if (id !== explainSeq.current) return // a newer request was sent meanwhile: drop this stale answer
    if (r.ok) setExplain({ status: 'ai', data: r.data, model: r.model, cached: r.cached, prompt: r.prompt, ms: r.ms, verify: verifyNumbers(`${r.data.headline} ${r.data.explanation} ${r.data.caveat}`, f) })
    else setExplain({ status: 'offline', data: templateExplanation(f), error: r.error })
  }, [])
  useEffect(() => {
    const f = JSON.parse(factsKey)
    setExplain((s) => (s ? { ...s, status: 'loading' } : { status: 'loading', data: templateExplanation(f) }))
    const t = setTimeout(() => runExplain(f), 700)
    return () => clearTimeout(t)
  }, [factsKey, runExplain])

  // ------------------------------------------------------------ ask
  const ask = async (text: string) => {
    if (!text.trim() || asking) return
    setAsking(true)
    setQuestion(text)
    const ctx = {
      text,
      name: profile.name,
      age: profile.age,
      start_date: profile.as_of,
      profile: { age: profile.age, city: profile.city, status: profile.status, household: profile.household, net_income_chf: profile.income, rent_chf: profile.rent, cash_chf: profile.cash, investments_chf: profile.investments, goals: profile.goals.map((g) => g.name) },
      cities: cityList,
      catalog: params.catalog.map((c) => ({ id: c.id, name: c.name })),
    }
    const r = await apiParse(ctx)
    let res = r.ok ? r.data : offlineParse(text, profile, cityList)
    if (r.ok && !res.scenarios.length) res = offlineParse(text, profile, cityList)
    if (res.horizon_years) setYears(Math.max(1, Math.min(40, res.horizon_years)))
    const ids = addPaths(res.scenarios, r.ok ? { kind: 'ai', question: text, model: r.model, ms: r.ms, cached: r.cached, prompt: r.prompt, answer: res } : { kind: 'offline', question: text, reason: r.error, answer: res })
    if (ids.length) {
      setAsked({ question: text, ids })
      setAnswer(null)
    }
    setNote({ text: res.note ?? (res.scenarios.length ? '' : 'Nothing to add.'), unsupported: res.unsupported, by: r.ok ? 'AI' : 'offline rules' })
    setAsking(false)
    setQuestion('')
  }

  const update = (id: string, f: (p: PathState) => PathState) => setPaths((ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  const remove = (id: string) => {
    setPaths((ps) => ps.filter((p) => p.id !== id))
    if (id === baselineId) setBaselineId('today')
    if (id === focusId) setFocusId('today')
  }

  const endAge = profile.age + years
  // Net worth = cash + investments + home − debts. If nothing but cash exists in any path, the two views are identical -> one chart.
  const sameAsCash = computed.every((c) => c.result.nw.every((b, i) => Math.abs(b.p50 - c.result.cash[i].p50) < 1))
  const view = sameAsCash ? 'cash' : metric
  const runsOut = today.result.probNegCash >= 0.5 && today.result.firstNegMonth != null
  const hook = runsOut ? (
    <>
      If nothing changes, {profile.name}’s cash <span className="neg">runs out at age {Math.floor(profile.age + today.result.firstNegMonth! / 12)}</span>.
    </>
  ) : (
    <>
      If nothing changes, {profile.name} has about <b>{chfk(today.result.endNW.p50)}</b> at {endAge}.
    </>
  )

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
        <section className="hero">
          <div className="person">
            <div className="avatar">{profile.name[0]}</div>
            <div>
              <div className="person-name">
                {profile.name}, {profile.age} <span className="muted">· {profile.city} · {profile.status.replace('_', ' ')}</span>
              </div>
              <div className="muted small">
                {chf(profile.cash)} saved · earns {chf(profile.income)}/mo · rent {chf(profile.rent)}/mo
                {profile.investments > 0 && ` · invested ${chfk(profile.investments)}`}
                {profile.goals.length > 0 && ` · goals: ${profile.goals.map((g) => g.name.toLowerCase()).join(', ')}`}
              </div>
            </div>
            <span className="spacer" />
            <select className="person-pick" value={profileId} onChange={(e) => reset(e.target.value)} title="pick another fictional person">
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, {p.age}, {p.city}, {p.status}
                </option>
              ))}
            </select>
          </div>

          <h1 className="hook">{hook}</h1>

          <form className="ask" onSubmit={(e) => (e.preventDefault(), ask(question))}>
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What if… (e.g. I do a master’s, or move to Zurich?)" disabled={asking} />
            <button type="submit" disabled={asking || !question.trim()}>
              {asking ? <span className="spinner" /> : 'Explore'}
            </button>
          </form>
          <div className="chip-group">
            <span className="chip-label">
              Add a ready-made path <span className="muted">· instant, no AI · hover to see what it does</span>
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
              Or try a question <span className="muted">· the AI turns it into a path</span>
            </span>
            <div className="chips">
              {examples.map((q) => (
                <button key={q} className="chip chip-ask" onClick={() => ask(q)} disabled={asking}>
                  “{q}”
                </button>
              ))}
            </div>
          </div>
          {note && (note.text || note.unsupported.length > 0) && (
            <p className="note small">
              {note.text} {note.unsupported.length > 0 && <span className="muted">Not modelled: {note.unsupported.join('; ')}.</span>}
            </p>
          )}
        </section>

        {/* ---------------- the futures ---------------- */}
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

        <section className="outcomes">
          {computed.map((c) => (
            <OutcomeCard
              key={c.id}
              name={c.name}
              summary={describeSpec(c.spec, profile.age)}
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

        <section className="card">
          <div className="card-head">
            <h2>{sameAsCash ? 'Money by age' : view === 'nw' ? 'Net worth by age (everything owned − debts)' : 'Cash in the bank by age'}</h2>
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
              {[3, 5, 10, 20, 30].map((y) => (
                <option key={y} value={y}>
                  {y} years
                </option>
              ))}
            </select>
          </div>
          <ProjectionChart paths={computed} focusId={focus.id} profile={profile} metric={view} months={H} markers={markersFor(focus.spec, focus.plan.months)} />
          {focus.result.homeBuys.map((h) => (
            <p key={h.month} className={`home-note small ${h.shortShare >= 0.5 ? 'neg' : ''}`}>
              🏠 <b>{focus.name}</b>, age {Math.floor(profile.age + h.month / 12)}: {chf(h.down)} of own money goes into the home, so <b>cash drops by that amount</b>, but <b>net worth does not</b> (the money becomes part of the home; the mortgage covers the rest).
              {h.shortShare >= 0.5
                ? ` But just before buying, cash is only about ${chf(h.cashBeforeP50)} (typical future): in ${Math.round(h.shortShare * 100)}% of futures there is NOT enough own money. A bank would not lend; the chart shows cash going below zero instead.`
                : h.shortShare > 0.05
                  ? ` In ${Math.round(h.shortShare * 100)}% of futures cash is not enough for the down payment at that moment.`
                  : ` Cash just before buying: about ${chf(h.cashBeforeP50)}, enough in all futures.`}
              {view === 'nw' && ' The dotted line is cash.'}
            </p>
          ))}
          {profile.goals.length > 0 && (
            <div className="goals">
              {profile.goals.map((g) => {
                const m = monthIndex(profile.as_of, g.date)
                return (
                  <div key={g.name} className="goal">
                    <span className="goal-title">
                      🎯 <b>{g.name}</b>: {chf(g.target)} by {g.date.slice(0, 7)} <span className="muted">(age {Math.floor(profile.age + (m + 1) / 12)})</span>
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
                )
              })}
              <p className="caption">
                Goals come from the data (synthetic-goals.csv). On the chart, each 🎯 sits at the goal’s amount and date. A path reaches a goal if, at that date, its cash + investments are above the 🎯 (a home doesn’t count: you can’t spend it). The % is the share of the 500 futures that reach it; colours match the paths.
              </p>
            </div>
          )}
          <p className="caption">
            Lines = the typical outcome of 500 simulated futures. Shaded = where 8 in 10 of them land for <b style={{ color: focus.color }}>{focus.name}</b>.
            {view === 'cash' ? ' Dots = the real bank balance from the data (first 2 years).' : ' Switch to Cash to see the real data.'}
          </p>
        </section>

        {/* ---------------- the story ---------------- */}
        {explain && (
          <section className="card story">
            <h2 className="story-head">{explain.data.headline}</h2>
            <p className="story-text">{explain.data.explanation}</p>
            {be && (
              <div className="insight">
                <span className="insight-icon">⚖</span>
                <div>
                  {be.pct >= 0 ? (
                    <>
                      <b>{focus.name}</b> catches up with <b>{baseline.name}</b> only if income from age {Math.floor(profile.age + be.month / 12)} is <b>{be.pct.toFixed(0)}% higher</b> than we assumed (about {chf(be.incomeNeeded)} a month).
                    </>
                  ) : (
                    <>
                      <b>{focus.name}</b> stays ahead of <b>{baseline.name}</b> even if income from age {Math.floor(profile.age + be.month / 12)} were <b>{Math.abs(be.pct).toFixed(0)}% lower</b> than we assumed (about {chf(be.incomeNeeded)} a month).
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

        {/* ---------------- the numbers behind it (collapsed) ---------------- */}
        <details className="card fold" open={focus.id !== 'today'}>
          <summary>
            <h2>
              The numbers behind <span style={{ color: focus.color }}>{focus.name}</span>
            </h2>
            <span className="muted small">every number has a source · click any value to change it</span>
          </summary>
          <p className="made-by small">
            <span className="muted">What it does:</span> {describeSpec(focus.spec, profile.age)}.{' '}
            <span className="muted">Made by:</span>{' '}
            {focus.origin.kind === 'today' ? 'the data, unchanged' : focus.origin.kind === 'preset' ? `the “+ ${focus.origin.button}” button (no AI)` : focus.origin.kind === 'ai' ? `AI, from your question “${focus.origin.question}”` : `offline keyword rules, from “${focus.origin.question}”`}{' '}
            · <button className="link-btn" onClick={() => setHowMade({ what: 'path', name: focus.name, origin: focus.origin, spec: focus.spec })}>{focus.origin.kind === 'ai' ? 'see the prompt' : 'see how'}</button>
          </p>
          {focus.plan.warnings.map((w) => (
            <p key={w} className="warn small">
              ⚠ {w}
            </p>
          ))}
          <AssumptionList items={focus.plan.assumptions} overrides={focus.overrides} onChange={(key, v) => update(focus.id, (p) => {
            const o = { ...p.overrides }
            if (v == null) delete o[key]
            else o[key] = v
            return { ...p, overrides: o }
          })} />
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
