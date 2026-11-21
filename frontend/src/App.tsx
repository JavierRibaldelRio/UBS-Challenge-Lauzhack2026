import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BranchCard } from './components/BranchCard'
import { ProjectionChart } from './components/Chart'
import { DriversPanel, ExplanationPanel, ProfileCard, ResultsTable, TrustPanel, type ExplainState } from './components/Panels'
import { breakEven, buildFacts, drivers, templateExplanation, verifyNumbers } from './lib/analysis'
import { apiExplain, apiHealth, apiParse } from './lib/api'
import { offlineParse } from './lib/fallback'
import { cities, medianLoanRate, presets, resolve, type Overrides } from './lib/resolve'
import { checks, simulate } from './lib/sim'
import type { Params, Profile, ScenarioSpec } from './lib/types'
import paramsJson from './model/params.json'
import profilesJson from './model/profiles.json'

const COLORS = ['#64748b', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2']
type BranchState = { id: string; spec: ScenarioSpec; overrides: Overrides; visible: boolean; origin: string; color: string }
const STATUS_QUO = (): BranchState => ({ id: 'quo', spec: { name: 'Status quo', catalog_id: null, events: [] }, overrides: {}, visible: true, origin: 'nothing changes', color: COLORS[0] })

// Model artifacts are bundled (built by ml/train.py) -> no runtime fetch that could fail during a demo.
export default function App() {
  return <Twin params={paramsJson as unknown as Params} profiles={profilesJson as unknown as Profile[]} />
}

function Twin({ params, profiles }: { params: Params; profiles: Profile[] }) {
  const [profileId, setProfileId] = useState('P00001')
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]
  const [horizonYears, setHorizonYears] = useState(10)
  const H = horizonYears * 12
  const [branches, setBranches] = useState<BranchState[]>([STATUS_QUO()])
  const [baselineId, setBaselineId] = useState('quo')
  const [focusId, setFocusId] = useState('quo')
  const [metric, setMetric] = useState<'nw' | 'cash'>('nw')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [parseNote, setParseNote] = useState<{ text: string; unsupported: string[]; source: string } | null>(null)
  const [llm, setLlm] = useState<{ model: string } | null | undefined>(undefined)
  const [explain, setExplain] = useState<ExplainState>({ status: 'idle', data: null })
  const nextId = useRef(1)
  const loanRate = useMemo(() => medianLoanRate(profiles), [profiles])
  const cityList = useMemo(() => cities(params), [params])
  const presetList = useMemo(() => presets(profile, params), [profile, params])

  useEffect(() => {
    apiHealth().then((h) => setLlm(h.ok ? h.llm : null))
  }, [])

  // reset branches when the person changes
  useEffect(() => {
    setBranches([STATUS_QUO()])
    setBaselineId('quo')
    setFocusId('quo')
    setParseNote(null)
  }, [profileId])

  const addBranches = useCallback((specs: ScenarioSpec[], origin: string) => {
    const added: BranchState[] = specs.map((spec) => {
      const id = `b${nextId.current++}`
      return { id, spec, overrides: {}, visible: true, origin, color: COLORS[(nextId.current - 1) % (COLORS.length - 1) + 1] }
    })
    setBranches((bs) => [...bs, ...added])
    if (added[0]) setFocusId(added[0].id)
  }, [])

  // ------------------------------------------------------------ compute (pure, fast, deterministic)
  const computed = useMemo(
    () =>
      branches.map((b) => {
        const plan = resolve(profile, params, b.spec, b.overrides, H, loanRate)
        return { ...b, name: b.spec.name, plan, result: simulate(plan, params, profile), isBaseline: b.id === baselineId }
      }),
    [branches, profile, params, H, loanRate, baselineId],
  )
  const baseline = computed.find((c) => c.isBaseline) ?? computed[0]
  const focus = computed.find((c) => c.id === focusId) ?? baseline
  const drv = useMemo(() => drivers(focus.plan, params), [focus, params])
  const be = useMemo(() => (focus.id !== baseline.id ? breakEven(focus.plan, baseline.plan, params) : null), [focus, baseline, params])
  const liveChecks = useMemo(() => checks(focus.plan, params, profile), [focus, params, profile])
  const facts = useMemo(() => buildFacts(profile, params, computed.filter((c) => c.visible || c.isBaseline), drv, be, focus.id), [profile, params, computed, drv, be, focus.id])
  const factsKey = JSON.stringify(facts)

  // ------------------------------------------------------------ LLM explanation (debounced, verified, with fallback)
  const runExplain = useCallback(async (f: typeof facts) => {
    setExplain((s) => ({ ...s, status: 'loading' }))
    const r = await apiExplain(f)
    if (r.ok) setExplain({ status: r.cached ? 'cached' : 'ai', data: r.data, model: r.model, verify: verifyNumbers(`${r.data.headline} ${r.data.explanation} ${r.data.caveat}`, f) })
    else setExplain({ status: 'offline', data: templateExplanation(f), error: r.error })
  }, [])
  useEffect(() => {
    // instant template text while the LLM is thinking, so the panel is never empty
    setExplain((s) => (s.data ? { ...s, status: 'loading' } : { status: 'loading', data: templateExplanation(JSON.parse(factsKey)) }))
    const t = setTimeout(() => runExplain(JSON.parse(factsKey)), 900)
    return () => clearTimeout(t)
  }, [factsKey, runExplain])

  // ------------------------------------------------------------ ask
  const ask = async (text: string) => {
    if (!text.trim()) return
    setAsking(true)
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
    const source = r.ok ? `${r.model}${r.cached ? ' (cached)' : ''}` : `offline rules (${r.error})`
    if (r.ok && !res.scenarios.length) res = offlineParse(text, profile, cityList)
    if (res.horizon_years) setHorizonYears(Math.max(1, Math.min(40, res.horizon_years)))
    if (res.scenarios.length) addBranches(res.scenarios, r.ok ? 'AI' : 'offline')
    setParseNote({ text: res.note ?? (res.scenarios.length ? `Added ${res.scenarios.length} path(s).` : 'Nothing to add.'), unsupported: res.unsupported, source })
    setAsking(false)
    setQuestion('')
  }

  // The challenge's own example: Alexia, start working (baseline) vs master's vs move abroad
  const loadDemo = useCallback(() => {
    const alexia = profiles.find((p) => p.id === 'P00001')!
    const ps = presets(alexia, params)
    const pick = (id: string) => ps.find((p) => p.id === id)!.spec
    setProfileId('P00001')
    setHorizonYears(10)
    setTimeout(() => {
      setBranches([
        STATUS_QUO(),
        { id: 'd1', spec: pick('work'), overrides: {}, visible: true, origin: 'demo', color: COLORS[1] },
        { id: 'd2', spec: pick('master'), overrides: {}, visible: true, origin: 'demo', color: COLORS[2] },
        { id: 'd3', spec: pick('abroad'), overrides: {}, visible: true, origin: 'demo', color: COLORS[3] },
      ])
      setBaselineId('d1')
      setFocusId('d2')
    }, 0)
  }, [profiles, params])
  useEffect(() => {
    if (new URLSearchParams(location.search).has('demo')) loadDemo()
  }, [loadDemo])

  const update = (id: string, f: (b: BranchState) => BranchState) => setBranches((bs) => bs.map((b) => (b.id === id ? f(b) : b)))
  const visible = computed.filter((c) => c.visible)

  return (
    <main className="app">
      <header className="top">
        <div>
          <h1>Financial Twin</h1>
          <p className="muted">One choice, many possible futures. Don't predict the future, make it explorable.</p>
        </div>
        <div className="top-right">
          <button className="ghost" onClick={loadDemo}>
            ▶ Alexia demo
          </button>
          <span className={`badge ${llm ? 'ok' : 'muted'}`}>{llm === undefined ? 'checking AI…' : llm ? `AI: ${llm.model.split('/').pop()}` : 'AI offline → rule-based fallback'}</span>
          <span className="badge">Fictional data · not advice</span>
        </div>
      </header>

      <div className="layout">
        <aside className="side">
          <section className="card">
            <div className="row">
              <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.age} · {p.city} · {p.status} ({p.id})
                  </option>
                ))}
              </select>
              <button className="ghost" title="random profile" onClick={() => setProfileId(profiles[Math.floor(Math.random() * profiles.length)].id)}>
                🎲
              </button>
            </div>
            <ProfileCard p={profile} />
          </section>

          <section className="card">
            <h2>Ask "what if…"</h2>
            <form onSubmit={(e) => (e.preventDefault(), ask(question))}>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`e.g. "What if I do a master's in Zurich, or start working at 22 for 6000 a month?"`} rows={3} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), ask(question))} />
              <button type="submit" disabled={asking || !question.trim()}>
                {asking ? 'Thinking…' : 'Explore'}
              </button>
            </form>
            {parseNote && (
              <div className="parse-note small">
                <div>{parseNote.text}</div>
                {parseNote.unsupported.length > 0 && <div className="muted">Not modelled: {parseNote.unsupported.join('; ')}</div>}
                <div className="muted">understood by: {parseNote.source}</div>
              </div>
            )}
            <div className="chips">
              {presetList.map((p) => (
                <button key={p.id} className="chip" onClick={() => addBranches([p.spec], 'preset')}>
                  + {p.label}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>Paths</h2>
            <p className="hint">Click a path to see and edit every number it uses.</p>
            {computed.map((b) => (
              <BranchCard
                key={b.id}
                name={b.name}
                color={b.color}
                origin={b.origin}
                plan={b.plan}
                result={b.result}
                baselineResult={baseline.result}
                isBaseline={b.isBaseline}
                isFocus={b.id === focus.id}
                visible={b.visible}
                overrides={b.overrides}
                onFocus={() => setFocusId(b.id)}
                onBaseline={() => setBaselineId(b.id)}
                onToggle={() => update(b.id, (x) => ({ ...x, visible: !x.visible }))}
                onRemove={b.id === 'quo' ? undefined : () => (setBranches((bs) => bs.filter((x) => x.id !== b.id)), b.isBaseline && setBaselineId('quo'), b.id === focusId && setFocusId('quo'))}
                onOverride={(key, v) =>
                  update(b.id, (x) => {
                    const o = { ...x.overrides }
                    if (v == null) delete o[key]
                    else o[key] = v
                    return { ...x, overrides: o }
                  })
                }
              />
            ))}
          </section>
        </aside>

        <div className="mainc">
          <section className="card">
            <div className="row">
              <h2>{metric === 'nw' ? 'Net worth' : 'Cash'} over {horizonYears} years</h2>
              <span className="spacer" />
              <div className="seg">
                <button className={metric === 'nw' ? 'on' : ''} onClick={() => setMetric('nw')}>
                  Net worth
                </button>
                <button className={metric === 'cash' ? 'on' : ''} onClick={() => setMetric('cash')}>
                  Cash
                </button>
              </div>
              <select value={horizonYears} onChange={(e) => setHorizonYears(Number(e.target.value))}>
                {[3, 5, 10, 15, 20, 30].map((y) => (
                  <option key={y} value={y}>
                    {y} years
                  </option>
                ))}
              </select>
            </div>
            <ProjectionChart branches={visible} profile={profile} metric={metric} months={H} />
            <ResultsTable rows={visible} months={H} age={profile.age} />
          </section>

          <section className="card">
            <h2>What does this mean?</h2>
            <ExplanationPanel s={explain} onRetry={() => runExplain(facts)} />
          </section>

          <section className="card">
            <h2>Why: what matters most for "{focus.name}"</h2>
            {drv.length ? <DriversPanel drivers={drv} name={focus.name} breakEven={be} baselineName={baseline.name} age={profile.age} /> : <p className="muted">No inputs to vary.</p>}
          </section>

          <section className="card">
            <h2>Can you trust it?</h2>
            <TrustPanel params={params} checks={liveChecks} focusName={focus.name} />
          </section>
        </div>
      </div>
      <footer className="muted small">
        Educational prototype for the UBS × LauzHack 2026 AI Financial Twin challenge. All profiles are fictional; results are conditional on the shown assumptions and are not forecasts or financial advice.
      </footer>
    </main>
  )
}
