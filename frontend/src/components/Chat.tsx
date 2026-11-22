import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'

export type ChatLine = { text: string; color?: string; pathId?: string }
export type ChatAnswer = { text: string; confidence: 'high' | 'medium' | 'low'; why?: string; reasons?: string[]; onPrompt?: () => void }
export type ChatMsg =
  | { id: number; role: 'user'; text: string; target?: { name: string; mode: 'edit' | 'fork' } }
  | {
      id: number
      role: 'twin'
      reply?: string // what the twin says in its own words
      lines: ChatLine[] // what the twin did, one per line ("＋ path …", "🧠 updated …")
      answer?: ChatAnswer | null // null = being answered
      pending?: boolean
      muted?: string // small grey note (not modelled, offline…)
      details?: () => void // opens "how did the twin get this?"
    }
/** "Change this path" or "branch off this path": the next message is about that path. */
export type ChatMode = { kind: 'edit' | 'fork'; id: string; name: string; ideas: string[] } | null
export type ChatHandle = { focus: () => void }

const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }

export function Chat(p: {
  ref?: Ref<ChatHandle>
  messages: ChatMsg[]
  busy: boolean
  llm: { model: string } | null | undefined
  mode: ChatMode
  ideas: string[]
  onClearMode: () => void
  onSend: (text: string) => void
  onPath: (id: string) => void
}) {
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(p.ref, () => ({ focus: () => input.current?.focus() }), [])
  useEffect(() => {
    const b = box.current
    if (b) b.scrollTop = b.scrollHeight // newest message in view, without scrolling the page
  }, [p.messages])
  const send = (t = text) => {
    if (!t.trim() || p.busy) return
    p.onSend(t.trim())
    setText('')
  }
  const started = p.messages.some((m) => m.role === 'user')
  return (
    <div className="chat">
      <div className="chat-head">
        <span className="eyebrow">Talk to your twin</span>
        <span className="spacer" />
        <span className={`status ${p.llm ? 'on' : ''}`} title={p.llm ? p.llm.model : 'No AI: messages use simple offline rules'}>
          {p.llm === undefined ? '…' : p.llm ? 'AI on' : 'AI offline'}
        </span>
      </div>
      <div className="thread" ref={box}>
        {p.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg me">
              {m.target && <span className="msg-target">{m.target.mode === 'fork' ? '⑂ branch of' : '✏️'} {m.target.name}</span>}
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="msg twin">
              {m.pending ? (
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <>
                  {m.reply && <div className="msg-reply">{m.reply}</div>}
                  {m.lines.map((l, i) => (
                    <div key={i} className="msg-line">
                      {l.pathId ? (
                        <button className="msg-path" onClick={() => p.onPath(l.pathId!)} title="compare this path">
                          {l.text}
                        </button>
                      ) : (
                        l.text
                      )}
                    </div>
                  ))}
                  {m.answer && <Answer a={m.answer} />}
                  {m.answer === null && <div className="muted small">answering…</div>}
                  {m.muted && <div className="msg-muted">{m.muted}</div>}
                  {m.details && (
                    <button className="msg-details" onClick={m.details}>
                      how did the twin get this?
                    </button>
                  )}
                </>
              )}
            </div>
          ),
        )}
      </div>

      <div className="chat-foot">
        {p.mode ? (
          <div className={`reply-to mode-${p.mode.kind}`}>
            <div className="reply-row">
              <span>
                {p.mode.kind === 'fork' ? '⑂ New branch of' : '✏️ Changing'} <b>{p.mode.name}</b>
                <span className="muted"> · {p.mode.kind === 'fork' ? 'it keeps every decision; say what to add' : 'your message rewrites this path (undo keeps the old one)'}</span>
              </span>
              <button className="icon" onClick={p.onClearMode} title="cancel">
                ✕
              </button>
            </div>
            {p.mode.ideas.length > 0 && (
              <div className="chips">
                {p.mode.ideas.map((i) => (
                  <button key={i} className="chip chip-soft" disabled={p.busy} onClick={() => send(i)}>
                    {i}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          p.ideas.length > 0 && (
            <details className="ideas" open={!started}>
              <summary>Ideas to ask</summary>
              <div className="chips">
                {p.ideas.map((q) => (
                  <button key={q} className="chip chip-ask" disabled={p.busy} onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </details>
          )
        )}
        <form className="ask" onSubmit={(e) => (e.preventDefault(), send())}>
          <textarea
            ref={input}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={p.mode ? (p.mode.kind === 'fork' ? `What happens next on “${p.mode.name}”?` : `How should “${p.mode.name}” change?`) : 'Ask “what if…”, or tell me what changed (“I now earn 1,500”)'}
            disabled={p.busy}
          />
          <button type="submit" disabled={p.busy || !text.trim()}>
            {p.busy ? <span className="spinner" /> : p.mode?.kind === 'edit' ? 'Change' : p.mode?.kind === 'fork' ? 'Branch' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Answer({ a }: { a: ChatAnswer }) {
  return (
    <div className="msg-answer">
      {a.text}
      <span className={`msg-conf conf-${a.confidence}`}>{CONF[a.confidence]}</span>
      {(a.why || a.reasons?.length) && (
        <details className="mini-fold">
          <summary>why?</summary>
          {a.why && <p className="small">{a.why}</p>}
          {a.reasons && (
            <ul className="small">
              {a.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className="muted small">The confidence is computed by the simulator, not by the AI.</p>
          {a.onPrompt && (
            <button className="link-btn" onClick={a.onPrompt}>
              see the prompt
            </button>
          )}
        </details>
      )}
    </div>
  )
}
