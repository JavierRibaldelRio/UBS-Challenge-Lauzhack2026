import type { Verdict } from '../lib/answer'
import { belowFloor, breach, FIT_RULE, type Fit, type Story } from '../lib/compare'
import { chfk } from '../lib/fmt'
import type { SimResult } from '../lib/sim'
import { catchUp } from '../lib/valuation'

export type TileData = {
  key: 'a' | 'b'
  id: string
  name: string
  parentName: string | null
  timeline: { icon: string; age: number; text: string }[]
  result: SimResult
  warnings: string[]
  unknownFromAge: number | null
  canUndo: boolean
  removable: boolean
  /** how many numbers of this path were filled in for the person (not said by them) */
  assumed: number
  /** discount rate of the today's-money values (NPV), shared by every path; mine = set by the user (else the default) */
  discount: { pct: number; mine: boolean }
}

const discLabel = (d: TileData['discount']) => `NPV at ${Math.round(d.pct * 100) / 100}% a year, ${d.mine ? 'your rate' : 'default assumption'}`

type TextStatus = 'loading' | 'ai' | 'offline'

/** "What's going on" for one selected path: the numbers that matter, then the story in plain words. */
export function NodeTile(p: { t: TileData; age: number; endAge: number; floor?: number; story: Story | null; status: TextStatus; busy: boolean; onChange: () => void; onBranch: () => void; onUndo: () => void; onRemove: () => void; onNumbers: () => void }) {
  const { t } = p
  const r = t.result
  const goals = r.goals.filter((g) => g.prob != null)
  const reached = goals.filter((g) => (g.prob ?? 0) >= 0.5).length
  const runsOut = r.probNegCash >= 0.5 && r.firstNegMonth != null
  return (
    <section className={`tile tile-${t.key}`}>
      <header className="tile-head">
        <span className="tile-badge">{t.key.toUpperCase()}</span>
        <div className="tile-title">
          <h2>{t.name}</h2>
          {t.parentName && <span className="muted small">branch of {t.parentName}</span>}
        </div>
        {p.busy && <span className="spinner small-spin" />}
      </header>
      <div className="timeline">
        {t.timeline.length ? (
          t.timeline.map((e, i) => (
            <span key={i} className="tl-item" title={e.text}>
              {e.icon} <span className="tl-text">{e.text}</span> <small>{e.age}</small>
            </span>
          ))
        ) : (
          <span className="muted small">today’s numbers, nothing changes</span>
        )}
      </div>
      <div className="tile-stats">
        <div>
          <span className="stat-big">{chfk(r.endNW.p50)}</span>
          <span className="stat-label">net worth at {p.endAge}</span>
        </div>
        <div>
          <span className="stat-big">{chfk(r.endCash.p50)}</span>
          <span className="stat-label">cash in the bank at {p.endAge}</span>
        </div>
      </div>
      <p className="muted small tile-npv" title={`Worth in today’s money: every franc in or out discounted to today when it happens, plus what you own minus debts at ${p.endAge}, discounted (${discLabel(t.discount)}). Only a way to value the path.`}>
        ≈ {chfk(r.endNPV.p50)} in today’s money ({discLabel(t.discount)})
      </p>
      <div className="outcome-flags">
        {runsOut ? (
          <span className="flag bad">⚠ cash runs out at {Math.floor(p.age + r.firstNegMonth! / 12)}</span>
        ) : r.probNegCash > 0.05 ? (
          <span className="flag warn">⚠ {Math.round(r.probNegCash * 100)}% risk of running short</span>
        ) : (
          <span className="flag good">✓ cash stays positive</span>
        )}
        {r.homeBuys.map((h) =>
          h.shortShare >= 0.5 ? (
            <span key={h.month} className="flag bad">⚠ can’t pay the {chfk(h.down).replace('CHF ', '')} down payment at {Math.floor(p.age + h.month / 12)}</span>
          ) : h.shortShare > 0.05 ? (
            <span key={h.month} className="flag warn">⚠ down payment short in {Math.round(h.shortShare * 100)}%</span>
          ) : (
            <span key={h.month} className="flag good">{h.kind === 'home' ? '🏠' : '🚗'} down payment OK</span>
          ),
        )}
        {p.floor ? (
          belowFloor(r, p.floor) > 0.05 ? (
            <span className={`flag ${belowFloor(r, p.floor) >= 0.5 ? 'bad' : 'warn'}`}>⚠ below your {chfk(p.floor).replace('CHF ', '')} floor in {Math.round(belowFloor(r, p.floor) * 100)}%</span>
          ) : (
            <span className="flag good">✓ stays above your {chfk(p.floor).replace('CHF ', '')} floor</span>
          )
        ) : null}
        {goals.length > 0 && <span className={`flag ${reached === goals.length ? 'good' : reached ? 'warn' : 'bad'}`}>🎯 {reached}/{goals.length} goals likely</span>}
        {r.investCut.share > 0.05 && <span className="flag warn" title="UBS budget constraint: you can only invest money you have. The planned amount is skipped when cash runs out.">⚠ investing skipped when cash is short ({Math.round(r.investCut.share * 100)}% of futures, ~{chfk(r.investCut.p50).replace('CHF ', '')} in total)</span>}
        {t.unknownFromAge != null && <span className="flag fogflag">? depends on unknowns from {t.unknownFromAge}</span>}
        {t.warnings.map((w) => (
          <span key={w} className="flag warn">⚠ {w}</span>
        ))}
      </div>
      <div className={`tile-story ${p.status === 'loading' ? 'is-loading' : ''}`}>
        {p.story ? (
          <>
            <p>
              <span className="story-k">So far</span> {p.story.so_far}
            </p>
            <p>
              <span className="story-k">Ahead</span> {p.story.ahead}
            </p>
          </>
        ) : (
          <p className="muted">Writing…</p>
        )}
      </div>
      <footer className="tile-actions">
        <button className="chip chip-soft" onClick={p.onChange} title="describe a change in the chat; this path is rewritten (undo keeps the old version)">
          ✏️ Change
        </button>
        <button className="chip chip-soft" onClick={p.onBranch} title="keep this path as it is and branch off a new one with an extra decision">
          ⑂ Branch off
        </button>
        <button className="chip chip-soft" onClick={p.onNumbers} title="every number of this path, where it comes from, and why it was assumed">
          📋 Assumptions{t.assumed ? ` (${t.assumed})` : ''}
        </button>
        {t.canUndo && (
          <button className="chip chip-undo" onClick={p.onUndo}>
            ↶ Undo
          </button>
        )}
        <span className="spacer" />
        {t.removable && (
          <button className="icon danger-hover" onClick={p.onRemove} title="delete this path (its branches move up)">
            🗑
          </button>
        )}
      </footer>
    </section>
  )
}

/** Below the two tiles: the personal comparison, the four UBS measures side by side, and what decided it. */
export function Comparison(p: {
  a: TileData
  b: TileData
  age: number
  floor?: number
  text: string | null
  caveat: string | null
  status: TextStatus
  verify?: { total: number; unmatched: string[] }
  verdict: Verdict | null
  fit: Fit | null
  breakEven: { path: string; other: string; pct: number; fromAge: number } | null
  model?: string
  onPrompt?: () => void
  onRewrite: () => void
}) {
  const { a, b } = p
  const fitName = p.fit ? (p.fit.pick === 'first' ? a.name : p.fit.pick === 'second' ? b.name : null) : null
  const fitKey = p.fit?.pick === 'first' ? 'a' : p.fit?.pick === 'second' ? 'b' : null
  const goalRows = a.result.goals.filter((g) => g.prob != null)
  type Row = { label: string; hint: string; av: string; bv: string; better: 'a' | 'b' | null }
  const better = (x: number, y: number, higher = true, tol = 0): 'a' | 'b' | null => (Math.abs(x - y) <= tol ? null : (x > y) === higher ? 'a' : 'b')
  const rows: Row[] = [
    { label: 'Lowest cash', hint: 'liquidity: the tightest moment (typical future)', av: chfk(a.result.minCash.p50), bv: chfk(b.result.minCash.p50), better: better(a.result.minCash.p50, b.result.minCash.p50, true, 500) },
    { label: 'Cash trouble', hint: `constraint breach: share of futures with cash below zero${p.floor ? `, below your ${chfk(p.floor)} floor` : ''} or a down payment you can’t pay`, av: `${Math.round(breach(a.result, p.floor) * 100)}%`, bv: `${Math.round(breach(b.result, p.floor) * 100)}%`, better: better(breach(a.result, p.floor), breach(b.result, p.floor), false, 0.02) },
    { label: `Cash at ${p.age + a.result.nw.length / 12}`, hint: 'savings in the bank at the end (typical future)', av: chfk(a.result.endCash.p50), bv: chfk(b.result.endCash.p50), better: better(a.result.endCash.p50, b.result.endCash.p50, true, 1000) },
    { label: `Net worth at ${p.age + a.result.nw.length / 12}`, hint: 'everything owned − debts (typical future)', av: chfk(a.result.endNW.p50), bv: chfk(b.result.endNW.p50), better: better(a.result.endNW.p50, b.result.endNW.p50, true, 1000) },
    { label: 'In today’s money', hint: `worth in today’s money at the end (${discLabel(a.discount)}): every franc in or out discounted to today when it happens + what is owned − debts at the end, discounted. Shown only; “fits better” uses net worth`, av: chfk(a.result.endNPV.p50), bv: chfk(b.result.endNPV.p50), better: better(a.result.endNPV.p50, b.result.endNPV.p50, true, 1000) },
    ...goalRows.map((g) => {
      const gb = b.result.goals.find((x) => x.name === g.name)
      return { label: `🎯 ${g.name}`, hint: `goal: ${chfk(g.target)} by ${g.date.slice(0, 4)}, share of futures that reach it`, av: `${Math.round(g.prob! * 100)}%`, bv: gb?.prob == null ? '—' : `${Math.round(gb.prob * 100)}%`, better: gb?.prob == null ? null : better(g.prob!, gb.prob, true, 0.02) }
    }),
  ]
  return (
    <section className="card compare">
      <div className="compare-head">
        <h2>
          <span className="ab ab-a">A</span> {a.name} <span className="muted">vs</span> <span className="ab ab-b">B</span> {b.name}
        </h2>
        <span className="advice-tag" title="A simulation under the assumptions shown, about a fictional person. It describes what the numbers show; it does not tell anyone what to do.">
          Not financial advice
        </span>
      </div>

      <div className="compare-body">
        <div className="compare-text">
          {fitName ? (
            <div className={`fit fit-${fitKey}`}>
              <span className="fit-k">Fits your goals better, in this simulation</span>
              <span className="fit-v">
                <span className={`ab ab-${fitKey}`}>{fitKey!.toUpperCase()}</span> {fitName}
              </span>
            </div>
          ) : (
            p.fit && (
              <div className="fit">
                <span className="fit-k">Fits your goals better</span>
                <span className="fit-v">Too close to call</span>
              </div>
            )
          )}
          <p className={`compare-prose ${p.status === 'loading' ? 'is-loading' : ''}`}>{p.text ?? 'Writing…'}</p>
          {p.caveat && <p className="caveat small">⚠ {p.caveat}</p>}
          <div className="story-meta">
            {p.status === 'loading' && <span className="muted">updating…</span>}
            {p.status === 'ai' && <span className="muted">written by AI{p.model ? ` (${p.model.split('/').pop()})` : ''} from the simulator’s numbers</span>}
            {p.status === 'offline' && <span className="muted">written by a template (AI offline)</span>}
            {p.status === 'ai' && p.verify && (p.verify.unmatched.length ? <span className="neg">⚠ {p.verify.unmatched.length} number(s) not found in the model: {p.verify.unmatched.join(', ')}</span> : <span className="ok">✓ all {p.verify.total} numbers checked against the model</span>)}
            {p.onPrompt && (
              <button className="link-btn" onClick={p.onPrompt}>
                see the prompt
              </button>
            )}
            <button className="link-btn" onClick={p.onRewrite}>
              rewrite
            </button>
          </div>
        </div>

        <div className="compare-side">
          <table className="ab-table">
            <thead>
              <tr>
                <th />
                <th><span className="ab ab-a">A</span></th>
                <th><span className="ab ab-b">B</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} title={r.hint}>
                  <td>{r.label}</td>
                  <td className={r.better === 'a' ? 'win' : ''}>{r.av}</td>
                  <td className={r.better === 'b' ? 'win' : ''}>{r.bv}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="mini-fold">
            <summary>How “fits better” is judged</summary>
            <p className="small">{FIT_RULE} Computed by the app, not by the AI.</p>
            {p.fit && (
              <ul className="small">
                {p.fit.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            {p.verdict && (
              <div className={`conf conf-${p.verdict.confidence}`}>
                <div className="conf-head">
                  <span className="conf-badge">{p.verdict.confidence} confidence</span>
                  <span className="muted small">that “{p.verdict.leader.name}” ends with more net worth</span>
                </div>
                <ul>
                  {p.verdict.reasons.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </details>
          {(() => {
            const cu = catchUp(a.result.npv, b.result.npv, p.age)
            const [win, lose] = cu.ahead === 'a' ? [a.name, b.name] : [b.name, a.name]
            return (
              <div className="insight small" title="Rolling horizon: the two paths valued in today’s money at the end of every year (median NPV).">
                <span className="insight-icon">⏳</span>
                <div>
                  In today’s money ({discLabel(a.discount)}):{' '}
                  {cu.ahead === 'tie' ? (
                    <>both end about level.</>
                  ) : cu.fromAge == null ? (
                    <>
                      <b>{win}</b> is ahead at every year.
                    </>
                  ) : (
                    <>
                      <b>{win}</b> overtakes <b>{lose}</b> at {cu.fromAge} and stays ahead.
                    </>
                  )}
                </div>
              </div>
            )
          })()}
          {p.breakEven && (
            <div className="insight small">
              <span className="insight-icon">⚖</span>
              <div>
                <b>{p.breakEven.path}</b> catches up with <b>{p.breakEven.other}</b> only if its income from age {p.breakEven.fromAge} is <b>{Math.round(p.breakEven.pct)}% higher</b> than assumed.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
