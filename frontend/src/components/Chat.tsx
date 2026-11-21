import { useEffect, useRef, useState } from 'react'

export type ChatLine = { text: string; color?: string; pathId?: string }
export type ChatMsg =
  | { id: number; role: 'user'; text: string; target?: { name: string; color: string } }
  | {
      id: number
      role: 'twin'
      reply?: string // what the twin says in its own words
      lines: ChatLine[] // what the twin did, one per line ("Added path …", "Now I know: income …")
      answer?: { text: string; confidence: 'high' | 'medium' | 'low' } | null
      pending?: boolean
      muted?: string // small grey note (not modelled, offline…)
      details?: () => void // opens "how this was made"
    }

const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }

/** A chat with the twin: your messages on the right, the twin's replies on the left. */
export function Chat(p: { messages: ChatMsg[]; busy: boolean; placeholder: string; target: { name: string; color: string } | null; onClearTarget: () => void; onSend: (text: string) => void; onPath: (id: string) => void }) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const b = box.current
    if (b) b.scrollTop = b.scrollHeight // keep the newest message in view (without scrolling the whole page)
  }, [p.messages])
  const send = () => {
    if (!text.trim() || p.busy) return
    p.onSend(text.trim())
    setText('')
  }
  return (
    <div className="chat">
      <div className="thread" ref={box}>
        {p.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg me">
              {m.target && (
                <span className="msg-target" style={{ color: m.target.color }}>
                  ✏️ {m.target.name}
                </span>
              )}
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
                        <button className="msg-path" style={{ ['--c' as string]: l.color }} onClick={() => p.onPath(l.pathId!)}>
                          {l.text}
                        </button>
                      ) : (
                        l.text
                      )}
                    </div>
                  ))}
                  {m.answer && (
                    <div className="msg-answer">
                      {m.answer.text}
                      <span className={`msg-conf conf-${m.answer.confidence}`}>{CONF[m.answer.confidence]}</span>
                    </div>
                  )}
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
        <div ref={end} />
      </div>
      {p.target && (
        <div className="reply-to" style={{ ['--c' as string]: p.target.color }}>
          ✏️ Changing <b>{p.target.name}</b>: your message edits this path
          <button className="icon" onClick={p.onClearTarget} title="ask something new instead">
            ✕
          </button>
        </div>
      )}
      <form className="ask" onSubmit={(e) => (e.preventDefault(), send())}>
        <span className="ask-icon">✦</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={p.placeholder} disabled={p.busy} />
        <button type="submit" disabled={p.busy || !text.trim()}>
          {p.busy ? <span className="spinner" /> : p.target ? 'Change' : 'Send'}
        </button>
      </form>
    </div>
  )
}
