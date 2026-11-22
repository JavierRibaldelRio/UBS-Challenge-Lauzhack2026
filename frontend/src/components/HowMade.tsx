import { useEffect, useRef, useState } from 'react'
import type { AnswerResult, ExplainResult, Origin, PromptInfo, ScenarioSpec, TwinEvent } from '../lib/types'

export type HowMadeContent =
  | { what: 'path'; name: string; origin: Origin; spec: ScenarioSpec; edits?: { instruction: string; changes: string[]; model?: string; ms?: number; prompt?: PromptInfo }[] }
  | { what: 'explanation' | 'answer'; prompt?: PromptInfo; answer: ExplainResult | AnswerResult; model?: string; ms?: number; offline: boolean; verify?: { total: number; unmatched: string[] } }

/** "How did the twin get this?" — plain story first, the exact prompts and raw JSON folded under "technical details". */
export function HowMade({ content, onClose }: { content: HowMadeContent | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (content && !d.open) d.showModal()
    if (!content && d.open) d.close()
  }, [content])
  return (
    <dialog ref={ref} className="howmade" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      {content && (
        <div className="howmade-body">
          <div className="howmade-head">
            <h2>{content.what === 'path' ? `How “${content.name}” was made` : content.what === 'answer' ? 'How the answer was made' : 'How the explanation was written'}</h2>
            <button className="icon" onClick={onClose} title="close">
              ✕
            </button>
          </div>
          {content.what === 'path' ? <PathStory c={content} /> : <TextStory c={content} />}
        </div>
      )}
    </dialog>
  )
}

const DESCRIBE: Record<TwinEvent['type'], string> = {
  start_job: 'start a job',
  study: 'study, then a job',
  relocate: 'move',
  income_change: 'income changes',
  household_change: 'household changes',
  recurring_expense: 'a new monthly cost',
  one_off: 'a one-time amount',
  invest: 'invest',
  market_shock: 'markets fall',
  take_loan: 'borrow money',
  buy_home: 'buy a home',
  buy_asset: 'buy something you keep (car, equipment…)',
}
const AMOUNTS: [keyof TwinEvent, string][] = [
  ['monthly_net_income_chf', 'net income CHF {}/mo'],
  ['income_change_pct', 'income {}%'],
  ['monthly_amount_chf', 'CHF {}/mo'],
  ['amount_chf', 'CHF {}'],
  ['annual_tuition_chf', 'tuition CHF {}/yr'],
  ['down_payment_pct', 'down payment {}%'],
  ['annual_rate_pct', 'rate {}%'],
  ['drop_pct', 'drop {}%'],
  ['depreciation_pct', 'loses {}%/yr'],
  ['duration_months', 'for {} months'],
]

/** One readable line per event: what, when, and only the numbers the user actually gave. */
function EventList({ spec }: { spec: ScenarioSpec }) {
  return (
    <ul className="events">
      {spec.events.map((e, i) => {
        const given = AMOUNTS.filter(([k]) => e[k] != null).map(([k, t]) => t.replace('{}', Number(e[k]).toLocaleString('de-CH')))
        return (
          <li key={i}>
            <b>{e.label}</b> <span className="muted">· {DESCRIBE[e.type]}{e.city ? ` (${e.city})` : ''}{e.household_type ? ` (${e.household_type.replace('_', ' ')})` : ''} · month {e.start_month ?? 0}</span>
            {given.length > 0 && <span className="given"> · you said: {given.join(', ')}</span>}
          </li>
        )
      })}
      {!spec.events.length && <li className="muted">no events: today’s numbers</li>}
    </ul>
  )
}

function PathStory({ c }: { c: Extract<HowMadeContent, { what: 'path' }> }) {
  const o = c.origin
  return (
    <div className="story-steps">
      {(o.kind === 'ai' || o.kind === 'offline') && <div className="bubble-q">“{o.question}”</div>}
      {o.kind === 'today' && <p>This path is the person exactly as the data describes them today, nothing changed. No AI involved.</p>}
      {o.kind === 'preset' && (
        <p>
          Made by the <b>“+ {o.button}”</b> button, no AI. It always adds the same recipe: <i>{o.desc}</i>
        </p>
      )}
      {o.kind === 'offline' && <p>The AI could not be reached ({o.reason}), so simple keyword rules understood it as:</p>}
      {o.kind === 'ai' && (
        <p>
          The AI turned your words into life events{o.answer.scenarios.length > 1 ? ` (${o.answer.scenarios.length} paths from one message; this is one)` : ''}. It only <b>describes</b> them; every amount you didn’t say is filled in by the app from the data.
        </p>
      )}
      <EventList spec={c.spec} />
      {(c.edits ?? []).map((e, i) => (
        <div key={i} className="followup">
          <div className="bubble-q">✏️ “{e.instruction}”</div>
          <ul className="events">
            {e.changes.map((x) => (
              <li key={x}>✓ {x}</li>
            ))}
          </ul>
        </div>
      ))}
      <p className="muted small">Then the app filled every empty number from the data (see “Assumptions”, each with its source) and simulated 500 futures. The AI never calculates money.</p>
      <details className="tech">
        <summary>Technical details: the exact instructions and the AI’s raw answer</summary>
        {o.kind === 'ai' && (
          <>
            {o.prompt ? <PromptBlock p={o.prompt} /> : <p className="muted small">The prompt was not stored for this answer.</p>}
            <h4>Raw answer ({o.model}{o.ms != null ? `, ${(o.ms / 1000).toFixed(1)} s` : ''}{o.cached ? ', from cache' : ''})</h4>
            <Code text={JSON.stringify(o.answer, null, 2)} />
          </>
        )}
        {(c.edits ?? []).map((e, i) =>
          e.prompt ? (
            <div key={i}>
              <h4>Follow-up {i + 1}</h4>
              <PromptBlock p={e.prompt} />
            </div>
          ) : null,
        )}
        <h4>The path as data</h4>
        <Code text={JSON.stringify(c.spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))), null, 2)} />
      </details>
    </div>
  )
}

function TextStory({ c }: { c: Exclude<HowMadeContent, { what: 'path' }> }) {
  const text = 'short_answer' in c.answer ? `${c.answer.short_answer} ${c.answer.reasoning}` : `${c.answer.headline}. ${c.answer.explanation}`
  if (c.offline) return <p>No AI was used: the AI was not reachable, so a fixed template turned the computed results into sentences.</p>
  return (
    <div className="story-steps">
      <p>
        <b>1.</b> The app computed everything first: 500 simulated futures per path{c.what === 'answer' ? ', which path ends higher, and how confident that is' : ''}.
      </p>
      <p>
        <b>2.</b> Only the final numbers (a small “facts” list) went to the AI, with fixed rules: plain words, use only these numbers, no advice.
      </p>
      <p>
        <b>3.</b> The AI wrote:
      </p>
      <div className="bubble-a">{text}</div>
      {c.verify && (
        <p>
          <b>4.</b> The app checked every number in that text against the facts:{' '}
          {c.verify.unmatched.length ? <span className="neg">{c.verify.unmatched.length} not found ({c.verify.unmatched.join(', ')})</span> : <span className="ok">all {c.verify.total} found ✓</span>}
        </p>
      )}
      <details className="tech">
        <summary>Technical details: the exact instructions, the facts and the raw answer</summary>
        {c.prompt ? <PromptBlock p={c.prompt} userLabel="the facts it received" /> : <p className="muted small">Prompt not stored for this answer.</p>}
        <h4>Raw answer ({c.model}{c.ms != null ? `, ${(c.ms / 1000).toFixed(1)} s` : ''})</h4>
        <Code text={JSON.stringify(c.answer, null, 2)} />
      </details>
    </div>
  )
}

function PromptBlock({ p, userLabel = 'the message, as sent' }: { p: PromptInfo; userLabel?: string }) {
  return (
    <div className="prompt">
      <details>
        <summary>the instructions the AI got ({p.system.split('\n').length} lines)</summary>
        <Code text={p.system} />
      </details>
      <details>
        <summary>{userLabel}</summary>
        <Code text={p.user} />
      </details>
      <details>
        <summary>settings</summary>
        <Code text={JSON.stringify(p.settings, null, 2)} />
      </details>
    </div>
  )
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code">
      <button
        className="copy"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)), () => {})
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre>{text}</pre>
    </div>
  )
}
