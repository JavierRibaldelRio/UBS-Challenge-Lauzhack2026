import type { PromptInfo, ScenarioSpec, TwinEvent } from '../lib/types'

export type PathEdit = { instruction: string; changes: string[]; model?: string; ms?: number; prompt?: PromptInfo }

/** Follow-ups for the selected path: one-click ideas, "write your own" (goes to the chat), undo, last change. */
export function PathEditor(p: {
  name: string
  color: string
  spec: ScenarioSpec
  age: number
  busy: boolean
  edits: PathEdit[]
  canUndo: boolean
  onEdit: (text: string) => void
  onWrite: () => void
  onUndo: () => void
}) {
  const ideas = followUpIdeas(p.spec, p.age)
  const last = p.edits.at(-1)
  return (
    <section className="editor" style={{ ['--c' as string]: p.color }}>
      <div className="editor-title">
        <span className="eyebrow">Change this path</span>
        <b style={{ color: p.color }}>{p.name}</b>
        {p.busy && <span className="spinner small-spin" />}
      </div>
      <div className="chips">
        <button className="chip chip-write" onClick={p.onWrite} disabled={p.busy}>
          ✏️ write your own change…
        </button>
        {ideas.map((i) => (
          <button key={i} className="chip chip-soft" onClick={() => p.onEdit(i)} disabled={p.busy}>
            {i}
          </button>
        ))}
        {p.canUndo && (
          <button className="chip chip-undo" onClick={p.onUndo} disabled={p.busy}>
            ↶ undo last change
          </button>
        )}
      </div>
      {last && (
        <div className="editor-changes small">
          <span className="muted">Last change:</span>
          {last.changes.map((c) => (
            <span key={c} className="change">
              ✓ {c}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/** A few follow-ups that make sense for this path (rules, instant). */
function followUpIdeas(spec: ScenarioSpec, age: number): string[] {
  const out: string[] = []
  const has = (t: TwinEvent['type']) => spec.events.find((e) => e.type === t)
  const study = has('study')
  const home = has('buy_home')
  const move = has('relocate')
  const job = has('start_job')
  const loss = spec.events.find((e) => e.type === 'income_change' && e.income_change_pct === -100)
  if (study) out.push(study.income_change_pct == null ? 'what if the degree raises my salary by 20%?' : 'start it one year later')
  if (home) out.push(home.amount_chf ? `make the flat ${Math.round((home.amount_chf * 0.8) / 1000)}k instead` : 'the flat costs 500k')
  if (move && /abroad/i.test(move.city ?? '')) out.push('rent there is 1,500 a month')
  if (job && !study) out.push('earn 1,000 more a month')
  if (loss) out.push('make the job loss 12 months')
  if (!home) out.push(`also buy a flat for 500k at ${age + 8}`)
  if (spec.events.length > 1) out.push(`remove “${spec.events[spec.events.length - 1].label}”`)
  return out.slice(0, 3)
}
