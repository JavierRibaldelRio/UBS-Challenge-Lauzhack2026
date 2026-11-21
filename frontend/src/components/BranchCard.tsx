import { useState } from 'react'
import { chf, chfk, pct } from '../lib/fmt'
import type { Plan } from '../lib/resolve'
import type { SimResult } from '../lib/sim'
import type { Assumption, Source } from '../lib/types'

export const SOURCE_INFO: Record<Source, { label: string; title: string }> = {
  data: { label: 'DATA', title: 'Read from the challenge CSVs (or a median of them)' },
  learned: { label: 'LEARNED', title: 'Fitted by ml/train.py from the 24-month ledger' },
  you: { label: 'YOU', title: 'Set by you (typed, edited, or stated in the chat)' },
  assumption: { label: 'ASSUMPTION', title: 'Not in the data: a labelled default you can edit' },
  missing: { label: 'UNKNOWN', title: 'Nobody knows this. Default = no change. Please set it.' },
}

export function SourceTag({ s }: { s: Source }) {
  return (
    <span className={`tag tag-${s}`} title={SOURCE_INFO[s].title}>
      {SOURCE_INFO[s].label}
    </span>
  )
}

type Props = {
  name: string
  color: string
  origin: string
  plan: Plan
  result: SimResult
  baselineResult: SimResult
  isBaseline: boolean
  isFocus: boolean
  visible: boolean
  onFocus: () => void
  onBaseline: () => void
  onToggle: () => void
  onRemove?: () => void
  onOverride: (key: string, value: number | null) => void
  overrides: Record<string, number>
}

export function BranchCard(p: Props) {
  const d = p.result.endNW.p50 - p.baselineResult.endNW.p50
  return (
    <div className={`branch ${p.isFocus ? 'focus' : ''}`} style={{ borderLeftColor: p.color }} onClick={p.onFocus}>
      <div className="branch-head">
        <input type="checkbox" checked={p.visible} onChange={p.onToggle} onClick={(e) => e.stopPropagation()} title="show on chart" />
        <b style={{ color: p.color }}>{p.name}</b>
        <span className="origin">{p.origin}</span>
        <span className="spacer" />
        <label className="baseline-radio" onClick={(e) => e.stopPropagation()}>
          <input type="radio" checked={p.isBaseline} onChange={p.onBaseline} /> baseline
        </label>
        {p.onRemove && (
          <button className="icon" onClick={(e) => (e.stopPropagation(), p.onRemove!())} title="remove">
            ×
          </button>
        )}
      </div>
      <div className="branch-stats">
        <span>
          End net worth <b>{chfk(p.result.endNW.p50)}</b>
        </span>
        {!p.isBaseline && <span className={d >= 0 ? 'pos' : 'neg'}>{d >= 0 ? '+' : '−'}{chfk(Math.abs(d)).replace('CHF ', 'CHF ')} vs baseline</span>}
        <span className={p.result.probNegCash > 0.05 ? 'neg' : 'muted'}>cash &lt; 0 in {pct(p.result.probNegCash)} of paths</span>
      </div>
      {p.isFocus && (
        <div className="assumptions" onClick={(e) => e.stopPropagation()}>
          {p.plan.warnings.map((w) => (
            <div key={w} className="warn">
              ⚠ {w}
            </div>
          ))}
          {p.plan.assumptions.filter((a) => !a.key.startsWith('g.')).map((a) => (
            <AssumptionPill key={a.key} a={a} overridden={p.overrides[a.key] != null} onChange={(v) => p.onOverride(a.key, v)} />
          ))}
          <div className="hint">Profile numbers used by this path:</div>
          {p.plan.assumptions.filter((a) => a.key.startsWith('g.')).map((a) => (
            <AssumptionPill key={a.key} a={a} overridden={p.overrides[a.key] != null} onChange={(v) => p.onOverride(a.key, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

function AssumptionPill({ a, overridden, onChange }: { a: Assumption; overridden: boolean; onChange: (v: number | null) => void }) {
  const [edit, setEdit] = useState(false)
  const [val, setVal] = useState(String(Math.round(a.value * 100) / 100))
  const editable = a.key !== 'learned.delta'
  const commit = () => {
    const n = Number(val)
    if (Number.isFinite(n)) onChange(n)
    setEdit(false)
  }
  const shown = a.unit.startsWith('CHF') ? chf(a.value) + a.unit.replace('CHF', '') : `${Math.round(a.value * 100) / 100} ${a.unit}`
  return (
    <div className={`pill pill-${a.source}`} title={a.note}>
      <SourceTag s={a.source} />
      <span className="pill-label">{a.label}</span>
      {edit ? (
        <input autoFocus className="pill-input" value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      ) : (
        <button className="pill-value" disabled={!editable} onClick={() => (setVal(String(Math.round(a.value * 100) / 100)), setEdit(true))}>
          {shown} {editable && '✎'}
        </button>
      )}
      {overridden && (
        <button className="icon" title="reset to default" onClick={() => onChange(null)}>
          ↺
        </button>
      )}
      <div className="pill-note">{a.note}</div>
    </div>
  )
}
