import { useState } from 'react'
import type { Driver } from '../lib/analysis'
import { chf, chfk } from '../lib/fmt'
import type { Assumption, Source } from '../lib/types'

export const SOURCE: Record<Source, { label: string; help: string }> = {
  data: { label: 'from data', help: 'Read from the challenge CSV files (or a median of them).' },
  learned: { label: 'learned', help: 'Estimated in R from 24 months of ledger data of all 1,200 people (by status, city and month, with a small personal adjustment).' },
  you: { label: 'you', help: 'Set by you (typed, edited, or said in the question).' },
  assumption: { label: 'assumption', help: 'Not in the data. A labelled default you can change.' },
  missing: { label: 'unknown', help: 'Nobody knows this. We use "no change". Click to set it.' },
  macro: { label: 'economy', help: 'Shared by every path: set by the economy you choose (macroeconomic, not in the data).' },
}

export function SourceChip({ s }: { s: Source }) {
  return (
    <span className={`src src-${s}`} title={SOURCE[s].help}>
      {SOURCE[s].label}
    </span>
  )
}

/** The numbers behind one path. Every one is editable; edits recompute instantly. */
export function AssumptionList({ items, overrides, onChange }: { items: Assumption[]; overrides: Record<string, number>; onChange: (key: string, v: number | null) => void }) {
  const own = items.filter((a) => !a.key.startsWith('g.') && !a.key.startsWith('m.') && !a.key.startsWith('v.'))
  const prof = items.filter((a) => a.key.startsWith('g.'))
  const eco = items.filter((a) => a.key.startsWith('m.'))
  const val = items.filter((a) => a.key.startsWith('v.')) // valuation (NPV discount rate): shared by every path
  const [showProfile, setShowProfile] = useState(false)
  return (
    <div className="alist">
      {own.length === 0 && <p className="muted">This path changes nothing: it uses the person’s numbers as they are today.</p>}
      {own.some((a) => a.source !== 'you') && <div className="alist-sub">Filled in for you: you didn’t say it, so the twin assumed it. The grey line says why.</div>}
      {own.filter((a) => a.source !== 'you').map((a) => (
        <Row key={a.key} a={a} overridden={overrides[a.key] != null} onChange={(v) => onChange(a.key, v)} />
      ))}
      {own.some((a) => a.source === 'you') && <div className="alist-sub">You said</div>}
      {own.filter((a) => a.source === 'you').map((a) => (
        <Row key={a.key} a={a} overridden={overrides[a.key] != null} onChange={(v) => onChange(a.key, v)} />
      ))}
      {eco.length > 0 && (
        <>
          <div className="alist-sub">🌍 The economy (same for every path)</div>
          {eco.map((a) => (
            <Row key={a.key} a={a} overridden={false} onChange={(v) => onChange(a.key, v)} />
          ))}
        </>
      )}
      {val.length > 0 && (
        <>
          <div className="alist-sub">⏳ Today’s money (same for every path; values paths, never changes them)</div>
          {val.map((a) => (
            <Row key={a.key} a={a} overridden={a.source === 'you'} onChange={(v) => onChange(a.key, v)} />
          ))}
        </>
      )}
      <button className="link-btn" onClick={() => setShowProfile((x) => !x)}>
        {showProfile ? 'hide' : 'show'} the person’s own numbers ({prof.length})
      </button>
      {showProfile && prof.map((a) => <Row key={a.key} a={a} overridden={overrides[a.key] != null} onChange={(v) => onChange(a.key, v)} />)}
    </div>
  )
}

function Row({ a, overridden, onChange }: { a: Assumption; overridden: boolean; onChange: (v: number | null) => void }) {
  const [edit, setEdit] = useState(false)
  const [val, setVal] = useState('')
  const editable = a.key !== 'learned.delta' && !a.key.endsWith('.info') // computed lines are read-only
  const shown = a.unit.startsWith('CHF') ? `${chf(a.value)}${a.unit.slice(3)}` : `${Math.round(a.value * 100) / 100} ${a.unit}`
  const commit = () => {
    const n = Number(val.replace(/['’,\s]/g, ''))
    if (val.trim() !== '' && Number.isFinite(n)) onChange(n)
    setEdit(false)
  }
  return (
    <div className={`arow ${a.source === 'missing' ? 'arow-missing' : ''}`}>
      <div className="arow-main">
        <span className="arow-label">{a.label}</span>
        <span className="arow-note">{a.note}</span>
      </div>
      <SourceChip s={a.source} />
      {edit ? (
        <input autoFocus className="arow-input" value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      ) : (
        <button className="arow-value" disabled={!editable} onClick={() => (setVal(String(Math.round(a.value * 100) / 100)), setEdit(true))} title={editable ? 'click to change' : undefined}>
          {shown}
          {editable && <span className="pen">✎</span>}
        </button>
      )}
      {overridden ? (
        <button className="icon" title="back to default" onClick={() => onChange(null)}>
          ↺
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

export function Drivers({ drivers }: { drivers: Driver[] }) {
  const max = Math.max(1, ...drivers.map((d) => d.range / 2))
  return (
    <div className="drivers">
      {drivers.map((d) => (
        <div key={d.name} className="drow">
          <span>{d.name}</span>
          <div className="dbar">
            <div style={{ width: `${(d.range / 2 / max) * 100}%` }} />
          </div>
          <span className="muted">±{chfk(d.range / 2)}</span>
        </div>
      ))}
    </div>
  )
}
