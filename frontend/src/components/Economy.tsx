import { describeMacro, MACRO_PRESETS, type Macro } from '../lib/macro'

/** The economy (macroeconomic variables): ONE setting shared by every path. Paths hold the person's own (idiosyncratic) choices. */
export function EconomyBar({ macro, age, onPick }: { macro: Macro; age: number; onPick: (m: Macro) => void }) {
  const lines = describeMacro(macro, age)
  return (
    <section className="economy">
      <div className="economy-head">
        <span className="eyebrow">🌍 The economy</span>
        <span className="muted small">macroeconomic · the same for every path, so decisions are compared fairly</span>
      </div>
      <div className="chips">
        {MACRO_PRESETS.map((p) => (
          <button key={p.id} className={`chip eco-chip ${macro.id === p.id ? 'on' : ''}`} title={p.desc} onClick={() => onPick(p)}>
            {p.name}
            {p.catalog && <small> {p.catalog}</small>}
          </button>
        ))}
        {macro.id === 'custom' && <span className="chip eco-chip on">Custom economy</span>}
      </div>
      <p className="small economy-desc">
        {macro.id === 'custom' ? 'Your own economy settings.' : macro.desc}
        {lines.length > 0 && <span className="muted"> · {lines.join(' · ')}</span>}
      </p>
    </section>
  )
}
