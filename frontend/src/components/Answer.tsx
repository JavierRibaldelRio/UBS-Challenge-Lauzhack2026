import type { Verdict } from '../lib/answer'
import type { AnswerResult } from '../lib/types'

const LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }

/** The direct answer to the user's question. Separate from the general explanation card. */
export function AnswerCard(p: {
  verdict: Verdict
  answer: AnswerResult | null
  status: 'loading' | 'ai' | 'offline'
  verify?: { total: number; unmatched: string[] }
  onSeePrompt: () => void
  onClose: () => void
}) {
  const v = p.verdict
  return (
    <section className="card answer">
      <div className="answer-head">
        <span className="answer-q">“{v.question}”</span>
        <button className="icon" onClick={p.onClose} title="close">
          ✕
        </button>
      </div>
      {p.answer ? (
        <>
          <p className="answer-short">{p.answer.short_answer}</p>
          <p className="answer-why">{p.answer.reasoning}</p>
        </>
      ) : (
        <p className="muted">Answering…</p>
      )}
      <div className={`conf conf-${v.confidence}`}>
        <div className="conf-head">
          <span className="conf-badge">{LABEL[v.confidence]}</span>
          <span className="muted small">computed by the simulator, not by the AI</span>
        </div>
        <ul>
          {v.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      <div className="story-meta">
        {p.status === 'loading' && <span className="muted">updating…</span>}
        {p.status === 'ai' && p.verify && (p.verify.unmatched.length ? <span className="neg">⚠ {p.verify.unmatched.length} number(s) not found in the model: {p.verify.unmatched.join(', ')}</span> : <span className="ok">✓ all {p.verify.total} numbers checked against the model</span>)}
        {p.status === 'offline' && <span className="muted">written by a template (AI offline)</span>}
        {p.status === 'ai' && p.answer && p.answer.confidence_level !== v.confidence && <span className="neg">⚠ the AI wrote a different confidence level; the badge above (computed) is the right one</span>}
        <button className="link-btn" onClick={p.onSeePrompt}>
          see the prompt
        </button>
      </div>
    </section>
  )
}
