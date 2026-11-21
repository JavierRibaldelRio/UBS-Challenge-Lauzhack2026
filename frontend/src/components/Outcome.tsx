import { chfk } from '../lib/fmt'
import type { SimResult } from '../lib/sim'

/** One card per path: the headline result in plain words. Doubles as the chart legend. */
export function OutcomeCard(p: {
  name: string
  color: string
  result: SimResult
  baseline: { name: string; result: SimResult }
  isBaseline: boolean
  isFocus: boolean
  age: number
  endAge: number
  onFocus: () => void
  onBaseline: () => void
  onRemove?: () => void
}) {
  const r = p.result
  const diff = r.endNW.p50 - p.baseline.result.endNW.p50
  const goals = r.goals.filter((g) => g.prob != null)
  const reached = goals.filter((g) => (g.prob ?? 0) >= 0.5).length
  const runsOut = r.probNegCash >= 0.5 && r.firstNegMonth != null
  return (
    <button className={`outcome ${p.isFocus ? 'focus' : ''}`} style={{ ['--c' as string]: p.color }} onClick={p.onFocus}>
      <div className="outcome-top">
        <span className="swatch" style={{ background: p.color }} />
        <span className="outcome-name">{p.name}</span>
        {p.onRemove && (
          <span className="x" role="button" title="remove" onClick={(e) => (e.stopPropagation(), p.onRemove!())}>
            ×
          </span>
        )}
      </div>
      <div className="outcome-big">{chfk(r.endNW.p50)}</div>
      <div className="outcome-sub">net worth at {p.endAge}</div>
      <div className={`outcome-diff ${p.isBaseline ? '' : diff >= 0 ? 'pos' : 'neg'}`}>
        {p.isBaseline ? 'baseline (others compare to this)' : `${diff >= 0 ? '+' : '−'}${chfk(Math.abs(diff))} vs ${p.baseline.name}`}
      </div>
      <div className="outcome-flags">
        {runsOut ? (
          <span className="flag bad">⚠ cash runs out at {Math.floor(p.age + r.firstNegMonth! / 12)}</span>
        ) : r.probNegCash > 0.05 ? (
          <span className="flag warn">⚠ {Math.round(r.probNegCash * 100)}% risk of running short</span>
        ) : (
          <span className="flag good">✓ cash stays positive</span>
        )}
        {goals.length > 0 && (
          <span className={`flag ${reached === goals.length ? 'good' : reached ? 'warn' : 'bad'}`}>
            🎯 {reached}/{goals.length} goals
          </span>
        )}
      </div>
      {!p.isBaseline && (
        <span className="link-btn" role="button" onClick={(e) => (e.stopPropagation(), p.onBaseline())}>
          compare others to this
        </span>
      )}
    </button>
  )
}
