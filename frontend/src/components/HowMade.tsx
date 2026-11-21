import { useEffect, useRef, useState } from 'react'
import type { ExplainResult, Origin, PromptInfo, ScenarioSpec } from '../lib/types'

export type HowMadeContent =
  | { what: 'path'; name: string; origin: Origin; spec: ScenarioSpec }
  | { what: 'explanation'; prompt?: PromptInfo; answer: ExplainResult; model?: string; ms?: number; offline: boolean; verify?: { total: number; unmatched: string[] } }

/** A simple window that shows exactly how a path (or the explanation) was produced: question, prompt, raw answer. */
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
            <h2>{content.what === 'path' ? `How “${content.name}” was made` : 'How the explanation was written'}</h2>
            <button className="icon" onClick={onClose} title="close">
              ✕
            </button>
          </div>
          {content.what === 'path' ? <PathStory c={content} /> : <ExplainStory c={content} />}
        </div>
      )}
    </dialog>
  )
}

function PathStory({ c }: { c: Extract<HowMadeContent, { what: 'path' }> }) {
  const o = c.origin
  return (
    <ol className="steps">
      {o.kind === 'today' && (
        <li>
          <b>No AI, no button.</b> This path is the person exactly as the data describes them today, with nothing changed. Every other path is compared with something.
        </li>
      )}
      {o.kind === 'preset' && (
        <li>
          <b>Made by the “+ {o.button}” button. No AI was used.</b> The button always adds the same recipe: <i>{o.desc}</i>
        </li>
      )}
      {o.kind === 'offline' && (
        <>
          <li>
            Your question: <Quote>{o.question}</Quote>
          </li>
          <li>
            <b>The AI could not be reached</b> ({o.reason}), so simple keyword rules turned your question into the recipe below.
          </li>
        </>
      )}
      {o.kind === 'ai' && (
        <>
          <li>
            Your question: <Quote>{o.question}</Quote>
          </li>
          <li>
            <b>We sent it to the AI</b> ({o.model}
            {o.ms != null ? `, answered in ${(o.ms / 1000).toFixed(1)} s` : ''}
            {o.cached ? ', replayed from cache' : ''}) with fixed instructions. The AI may only <b>describe</b> the decision. It must leave every amount you did not say empty.
            {o.prompt ? <PromptBlock p={o.prompt} /> : <p className="muted small">(The prompt was not stored for this answer. Ask again to see it.)</p>}
          </li>
          <li>
            <b>The AI answered with this JSON</b>
            {o.answer.scenarios.length > 1 && ` (${o.answer.scenarios.length} paths from one question; this is one of them)`}:
            <Code text={JSON.stringify(o.answer, null, 2)} />
          </li>
        </>
      )}
      <li>
        <b>The recipe for this path</b> (the list of life events):
        <Code text={JSON.stringify(c.spec.events.map(({ _source, ...e }) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))), null, 2)} />
      </li>
      <li>
        <b>The app filled every empty number from the data</b> and labelled where it came from. See <i>The numbers behind this path</i>. Then it simulated 500 possible futures. <b>The AI never calculates money.</b>
      </li>
    </ol>
  )
}

function ExplainStory({ c }: { c: Extract<HowMadeContent, { what: 'explanation' }> }) {
  if (c.offline)
    return (
      <ol className="steps">
        <li>
          <b>No AI was used.</b> The AI was not reachable, so a fixed template turned the computed results into sentences.
        </li>
      </ol>
    )
  return (
    <ol className="steps">
      <li>
        <b>The app computed the results first</b> (500 simulated futures per path). It packed only the final numbers into a small “facts” list.
      </li>
      <li>
        <b>We sent the facts to the AI</b> ({c.model}
        {c.ms != null ? `, ${(c.ms / 1000).toFixed(1)} s` : ''}) with fixed instructions: plain English, use only these numbers, no advice.
        {c.prompt ? <PromptBlock p={c.prompt} userLabel="the facts it received" /> : <p className="muted small">(Prompt not stored for this answer.)</p>}
      </li>
      <li>
        <b>The AI answered:</b>
        <Code text={JSON.stringify(c.answer, null, 2)} />
      </li>
      {c.verify && (
        <li>
          <b>The app checked every number in the answer against the facts:</b>{' '}
          {c.verify.unmatched.length ? <span className="neg">{c.verify.unmatched.length} not found ({c.verify.unmatched.join(', ')})</span> : <span className="ok">all {c.verify.total} found ✓</span>}
        </li>
      )}
    </ol>
  )
}

function PromptBlock({ p, userLabel = 'your question, as sent' }: { p: PromptInfo; userLabel?: string }) {
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

const Quote = ({ children }: { children: string }) => <span className="quote">“{children}”</span>
