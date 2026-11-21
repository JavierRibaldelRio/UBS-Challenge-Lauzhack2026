import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectionChart } from './components/Chart'
import { AssumptionList, Drivers } from './components/Details'
import { OutcomeCard } from './components/Outcome'
import { TrustDetails, TrustSummary } from './components/Trust'
import { breakEven, buildFacts, drivers, templateExplanation, verifyNumbers } from './lib/analysis'
import { apiExplain, apiHealth, apiParse } from './lib/api'
import { offlineParse } from './lib/fallback'
import { chf, chfk } from './lib/fmt'
import { cities, medianLoanRate, presets, resolve, type Overrides } from './lib/resolve'
import { checks, simulate } from './lib/sim'
import type { ExplainResult, Params, Profile, ScenarioSpec } from './lib/types'
import paramsJson from './model/params.json'
import profilesJson from './model/profiles.json'

const COLORS = ['#64748b', '#2563eb', '#e11d48', '#059669', '#7c3aed', '#d97706', '#0891b2']
type PathState = { id: string; spec: ScenarioSpec; overrides: Overrides; color: string }
const TODAY = (): PathState => ({ id: 'today', spec: { name: 'If nothing changes', catalog_id: null, events: [] }, overrides: {}, color: COLORS[0] })
const EXAMPLES = ["Master's in Zurich, or start working at 22 for 6,000 a month?", 'Work now, lose my job for 6 months at 25, then buy a flat for 600k at 28', 'What if I have a baby at 28?']

type Explain = { status: 'loading' | 'ai' | 'offline'; data: ExplainResult; model?: string; cached?: boolean; error?: string; verify?: { total: number; unmatched: string[] } }

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
  }
  const addPaths = useCallback((specs: ScenarioSpec[]) => {
    const added = specs.map((spec) => {
      const n = nextId.current++
      return { id: `p${n}`, spec, overrides: {}, color: COLORS[((n - 1) % (COLORS.length - 1)) + 1] }
    })
    setPaths((ps) => [...ps, ...added])
    if (added.length) setFocusId(added[added.length - 1].id)
  }, [])

  // The challenge's own example: Alexia — start working (baseline) vs master's vs move abroad
  const loadDemo = useCallback(() => {
    const alexia = profiles.find((p) => p.id === 'P00001')!
    const ps = presets(alexia, params)
    const pick = (id: string, i: number): PathState => ({ id: `d${i}`, spec: ps.find((p) => p.id === id)!.spec, overrides: {}, color: COLORS[i] })
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

  // ------------------------------------------------------------ explanation: instant template, then the LLM (verified)
  const explainSeq = useRef(0)
  const runExplain = useCallback(async (f: typeof facts) => {
    const id = ++explainSeq.current
    const r = await apiExplain(f)
    if (id !== explainSeq.current) return // a newer request was sent meanwhile: drop this stale answer
    if (r.ok) setExplain({ status: 'ai', data: r.data, model: r.model, cached: r.cached, verify: verifyNumbers(`${r.data.headline} ${r.data.explanation} ${r.data.caveat}`, f) })
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
    addPaths(res.scenarios)
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
          <div className="chips">
            {quick.map((p) => (
              <button key={p.id} className="chip" onClick={() => addPaths([p.spec])}>
                + {p.label}
              </button>
            ))}
            {EXAMPLES.map((q) => (
              <button key={q} className="chip chip-ask" onClick={() => ask(q)} disabled={asking}>
                “{q}”
              </button>
            ))}
          </div>
          {note && (note.text || note.unsupported.length > 0) && (
            <p className="note small">
              {note.text} {note.unsupported.length > 0 && <span className="muted">Not modelled: {note.unsupported.join('; ')}.</span>}
            </p>
          )}
        </section>

        {/* ---------------- the futures ---------------- */}
        <section className="outcomes">
          {computed.map((c) => (
            <OutcomeCard
              key={c.id}
              name={c.name}
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
            <h2>{sameAsCash ? 'Money, year by year' : view === 'nw' ? 'Net worth (everything owned − debts)' : 'Cash in the bank'}</h2>
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
          <ProjectionChart paths={computed} focusId={focus.id} profile={profile} metric={view} months={H} />
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

        <footer className="muted small">
          Fictional people and synthetic data (UBS × LauzHack 2026 challenge). Results depend on the assumptions shown. Not a forecast, not financial advice.
        </footer>
      </main>
    </div>
  )
}
