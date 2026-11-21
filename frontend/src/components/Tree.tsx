import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { chfk } from '../lib/fmt'
import { layoutTree, NODE_H, NODE_W } from '../lib/tree'

export type TreeItem = {
  id: string
  parentId: string | null
  name: string
  icons: string
  endNW: number
  risk: 'ok' | 'warn' | 'bad'
  busy?: boolean
  /** time on the link from the parent: "+8 yrs" (the tree is not a timeline) */
  gap?: { label: string; title: string; years: number } | null
}
/** The "new path" card, shown next to the node it branches from. */
export type AddCard = { id: string; title: ReactNode; body: ReactNode }

type View = { x: number; y: number; k: number }
type Pt = { x: number; y: number }
const PAD = 36 // room around the tree when fitting (the BASELINE label sits above the root)
const HINT_H = 44 // the explanation line at the bottom of the canvas
const MIN_K = 0.25
const MAX_K = 2.5
const DRAG_START = 4 // px the pointer must move before a click becomes a drag
const CARD_W = 330
const CARD_GAP = 44 // between a node and its card
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), Math.max(lo, hi))

/**
 * The scenario tree on a pan & zoom canvas. Left to right = what builds on what (a branch continues its parent),
 * NOT a timeline: the time is written on the links.
 * Scroll = zoom · drag empty space / middle button = move the view · drag a node = move it with its branch · click = compare.
 */
export const Tree = memo(function Tree(p: {
  items: TreeItem[]
  a: string | null
  b: string | null
  collapsed: ReadonlySet<string>
  onPick: (id: string) => void
  onBranch: (id: string) => void
  onToggle: (id: string) => void
  /** set the time on a link (years after the parent's last decision) */
  onEditGap?: (id: string, years: number) => void
  addCard?: AddCard | null
  onCloseAdd?: () => void
}) {
  const { placed } = useMemo(() => layoutTree(p.items, p.collapsed), [p.items, p.collapsed])
  const sel = (id: string) => (id === p.a ? 'a' : id === p.b ? 'b' : '')
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: PAD, y: PAD, k: 1 })
  const kRef = useRef(1)
  kRef.current = view.k
  const [size, setSize] = useState({ w: 0, h: 0 })
  const touched = useRef(false) // the user moved / zoomed: stop auto-fitting
  const [panning, setPanning] = useState(false)

  // ------------------------------------------------ nodes the user moved: an offset per node, carried by its whole branch
  const [moved, setMoved] = useState<Record<string, Pt>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const justDragged = useRef(false)
  const parentOf = useMemo(() => new Map(p.items.map((n) => [n.id, n.parentId])), [p.items])
  const pos = useMemo(() => {
    const m = new Map<string, Pt>()
    for (const [id, at] of placed) {
      let x = at.x
      let y = at.y
      for (let cur: string | null | undefined = id, guard = 0; cur && guard < 1000; cur = parentOf.get(cur), guard++) {
        const o = moved[cur]
        if (o) {
          x += o.x
          y += o.y
        }
      }
      m.set(id, { x, y })
    }
    return m
  }, [placed, moved, parentOf])
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const q of pos.values()) {
      minX = Math.min(minX, q.x)
      minY = Math.min(minY, q.y - 26) // the BASELINE label
      maxX = Math.max(maxX, q.x + NODE_W + 34) // the fold button
      maxY = Math.max(maxY, q.y + NODE_H)
    }
    return pos.size ? { minX, minY, w: maxX - minX, h: maxY - minY } : { minX: 0, minY: 0, w: 1, h: 1 }
  }, [pos])
  const links = useMemo(
    () =>
      p.items.flatMap((n) => {
        const a = n.parentId ? pos.get(n.parentId) : undefined
        const b = pos.get(n.id)
        if (!a || !b) return []
        const x1 = a.x + NODE_W
        const y1 = a.y + NODE_H / 2
        const x2 = b.x
        const y2 = b.y + NODE_H / 2
        const c = Math.max(36, Math.abs(x2 - x1) / 2) // smooth even when a node is pulled behind its parent
        return [{ id: n.id, d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, len: Math.hypot(x2 - x1, y2 - y1), gap: n.gap }]
      }),
    [p.items, pos],
  )

  // the canvas can be resized (bottom-right corner) and follows the window
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Everything visible, starting near the left (the tree grows to the right); never zoomed in beyond 100%. */
  const fit = useCallback(() => {
    if (!size.w || !size.h) return
    const usableH = size.h - HINT_H
    const k = clampK(Math.min(1, (size.w - 2 * PAD) / bounds.w, (usableH - 2 * PAD) / bounds.h))
    const left = Math.max(PAD, Math.min((size.w - bounds.w * k) / 2, 72))
    setView({ k, x: left - bounds.minX * k, y: (usableH - bounds.h * k) / 2 - bounds.minY * k + 6 })
  }, [size, bounds])
  useEffect(() => {
    if (!touched.current) fit() // auto-fit until the user takes over
  }, [fit])

  /** Pan just enough to show a node (and, if asked, room for its card on the right). */
  const reveal = useCallback(
    (id: string, roomRight = 0) => {
      const at = pos.get(id)
      if (!at || !size.w) return
      setView((v) => {
        const x0 = v.x + at.x * v.k
        const y0 = v.y + at.y * v.k
        const x1 = x0 + NODE_W * v.k + roomRight
        const y1 = y0 + NODE_H * v.k
        let { x, y } = v
        if (x1 > size.w - 12) x -= x1 - (size.w - 12)
        if (x0 + (x - v.x) < 12) x += 12 - (x0 + (x - v.x))
        if (y0 < 28) y += 28 - y0
        else if (y1 > size.h - HINT_H) y -= y1 - (size.h - HINT_H)
        if (roomRight) x = Math.max(x, 12 - bounds.minX * v.k) // making room for a card never hides the start of the tree
        return x === v.x && y === v.y ? v : { ...v, x, y }
      })
    },
    [pos, size, bounds],
  )
  const focusId = p.b ?? p.a
  useEffect(() => {
    if (touched.current && focusId) reveal(focusId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, placed])

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    touched.current = true
    setView((v) => {
      const k = clampK(v.k * factor)
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
    })
  }, [])

  // wheel = zoom (not over the card). Needs a non-passive listener to stop the page from scrolling at the same time.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.add-card')) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY // lines -> pixels (Firefox)
      zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  /** Track a pointer from pointerdown until release (pointer capture keeps it even outside the element). */
  const follow = (e: React.PointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void, onEnd: () => void) => {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let lx = e.clientX
    let ly = e.clientY
    const move = (ev: PointerEvent) => {
      onMove(ev.clientX - lx, ev.clientY - ly, ev)
      lx = ev.clientX
      ly = ev.clientY
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onEnd()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // drag the view: middle button anywhere, or left button on empty canvas
  const onCanvasDown = (e: React.PointerEvent) => {
    const onEmpty = !(e.target as Element).closest('.node, .tree-tools, .add-card, .edge-hit, .edge-label, .gap-edit')
    if (!(e.button === 1 || (e.button === 0 && onEmpty))) return
    e.preventDefault() // no middle-click autoscroll / paste
    touched.current = true
    setPanning(true)
    follow(e, (dx, dy) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })), () => setPanning(false))
  }

  // drag a node: it moves with its whole branch; the link to its parent stretches. A click without movement = compare.
  const onNodeDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    follow(
      e,
      (dx, dy, ev) => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START) return
          started = true
          touched.current = true
          setDragging(id)
          dx = ev.clientX - sx // include the first few pixels
          dy = ev.clientY - sy
        }
        const k = kRef.current
        setMoved((m) => ({ ...m, [id]: { x: (m[id]?.x ?? 0) + dx / k, y: (m[id]?.y ?? 0) + dy / k } }))
      },
      () => {
        if (!started) return
        setDragging(null)
        justDragged.current = true // swallow the click that follows the drag
        setTimeout(() => (justDragged.current = false), 0)
      },
    )
  }
  // ------------------------------------------------ editing the time on a link (click its pill, or the link itself)
  const [gapEdit, setGapEdit] = useState<{ id: string; value: string } | null>(null)
  const openGap = (id: string) => {
    const g = p.items.find((n) => n.id === id)?.gap
    if (g && p.onEditGap) setGapEdit({ id, value: String(g.years) })
  }
  const commitGap = () => {
    if (!gapEdit) return
    const v = Number(gapEdit.value.replace(',', '.'))
    const g = p.items.find((n) => n.id === gapEdit.id)?.gap
    if (Number.isFinite(v) && g && v !== g.years) p.onEditGap?.(gapEdit.id, Math.round(v * 2) / 2)
    setGapEdit(null)
  }

  const resetLayout = () => {
    setMoved({})
    touched.current = false
  }

  /**
   * Opening a card: the node and its card should sit side by side, with nothing covered.
   * Pan if that is enough; otherwise zoom out just enough (never below a readable 45%) so the tree up to the node + the card fit.
   */
  const makeRoom = useCallback(
    (id: string) => {
      const at = pos.get(id)
      if (!at || !size.w) return
      setView((v) => {
        const limit = size.w - CARD_GAP - CARD_W - 12 // where the node's right edge may be at most
        const span = at.x + NODE_W - bounds.minX // tree units: start of the tree -> right edge of the node
        const k = Math.min(v.k, clampK((limit - 12) / span))
        if (k < 0.45) return v // would be too small to read: leave it, the card goes on the other side
        const midY = v.y + (at.y + NODE_H / 2) * v.k
        let x = Math.min(v.x + (at.x + NODE_W) * v.k, limit) - (at.x + NODE_W) * k // keep the node where it is if possible
        x = Math.max(x, 12 - bounds.minX * k)
        const y = clamp(midY, 34 + (NODE_H / 2) * k, size.h - HINT_H - (NODE_H / 2) * k) - (at.y + NODE_H / 2) * k
        return { k, x, y }
      })
    },
    [pos, size, bounds],
  )

  // ------------------------------------------------ the "new path" card next to its node (movable by its header)
  const card = p.addCard ?? null
  const cardRef = useRef<HTMLDivElement>(null)
  const [cardH, setCardH] = useState(260)
  const [cardOff, setCardOff] = useState<Pt>({ x: 0, y: 0 })
  useEffect(() => {
    setCardOff({ x: 0, y: 0 }) // a new card starts in its natural place
    if (card) {
      touched.current = true
      makeRoom(card.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id])
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCardH(el.offsetHeight)) // keeps the card inside the canvas
    ro.observe(el)
    return () => ro.disconnect()
  }, [card?.id])
  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onCloseAdd?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, p])
  const anchor = card ? pos.get(card.id) : undefined
  const cardBox = (() => {
    if (!card || !size.w) return null
    if (!anchor) return { left: clamp(size.w / 2 - CARD_W / 2, 8, size.w - CARD_W - 8) + cardOff.x, top: 12 + cardOff.y, link: null }
    const nl = view.x + anchor.x * view.k
    const nr = nl + NODE_W * view.k
    const ny = view.y + (anchor.y + NODE_H / 2) * view.k
    const right = nr + CARD_GAP + CARD_W <= size.w - 8 || nl - CARD_GAP - CARD_W < 8 // prefer the right side
    const left = clamp(right ? nr + CARD_GAP : nl - CARD_GAP - CARD_W, 8, size.w - CARD_W - 8) + cardOff.x
    const top = clamp(ny - 34, 8, size.h - HINT_H - cardH - 8) + cardOff.y // stays above the zoom controls
    // the connector: from the node's side to the card's nearest side, at the card's header
    const fromRight = left + CARD_W / 2 >= (nl + nr) / 2
    const x1 = fromRight ? nr : nl
    const x2 = fromRight ? left : left + CARD_W
    const y2 = top + 26
    const c = Math.max(24, Math.abs(x2 - x1) / 2) * (fromRight ? 1 : -1)
    return { left, top, link: { d: `M${x1},${ny} C${x1 + c},${ny} ${x2 - c},${y2} ${x2},${y2}`, x1, y1: ny, x2, y2 } }
  })()
  const onCardDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    follow(e, (dx, dy) => setCardOff((o) => ({ x: o.x + dx, y: o.y + dy })), () => {})
  }

  const grid = 18 * view.k
  return (
    <div
      ref={box}
      className={`tree-canvas ${panning ? 'panning' : ''} ${dragging ? 'node-dragging' : ''}`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onCanvasDown}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
    >
      <div className="tree" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="tree-edges" width={Math.max(1, bounds.minX + bounds.w + 200)} height={Math.max(1, bounds.minY + bounds.h + 200)} aria-hidden>
          {links.map((l) => {
            const s = sel(l.id)
            return <path key={l.id} d={l.d} className={`edge ${s ? `edge-${s}` : ''}`} />
          })}
          {/* a wider invisible line on top: easy to click to change the time */}
          {p.onEditGap && links.filter((l) => l.gap).map((l) => <path key={`h${l.id}`} d={l.d} className="edge-hit" onClick={() => openGap(l.id)}><title>{`${l.gap!.title} · click to change`}</title></path>)}
        </svg>
        {links.map((l) =>
          gapEdit?.id === l.id ? (
            <span key={`g${l.id}`} className="gap-edit" style={{ left: l.mx, top: l.my }}>
              <span>+</span>
              <input
                autoFocus
                type="number"
                step={0.5}
                value={gapEdit.value}
                onChange={(e) => setGapEdit({ id: l.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitGap()
                  if (e.key === 'Escape') setGapEdit(null)
                }}
                onBlur={commitGap}
                aria-label="years after the previous decision"
              />
              <span>yrs</span>
            </span>
          ) : l.gap && l.len > 70 ? (
            <button
              key={`g${l.id}`}
              className={`edge-label ${sel(l.id) ? `edge-label-${sel(l.id)}` : ''} ${/^(now|right after)$/.test(l.gap.label) ? 'edge-label-quiet' : ''}`}
              style={{ left: l.mx, top: l.my }}
              title={`${l.gap.title} · click to change`}
              onClick={() => openGap(l.id)}
            >
              {l.gap.label}
            </button>
          ) : null,
        )}
        {p.items.map((n) => {
          const at = placed.get(n.id)
          const q = pos.get(n.id)
          if (!at || !q) return null // inside a collapsed branch
          const s = sel(n.id)
          return (
            <div key={n.id} className={`node ${s ? `node-${s}` : ''} risk-${n.risk} ${dragging === n.id ? 'is-dragged' : ''} ${card?.id === n.id ? 'is-adding' : ''}`} style={{ left: q.x, top: q.y, width: NODE_W, height: NODE_H }}>
              {n.parentId == null && <span className="node-tag">BASELINE</span>}
              <button
                className="node-main"
                onPointerDown={onNodeDown(n.id)}
                onClick={() => !justDragged.current && p.onPick(n.id)}
                title={s ? 'click to stop comparing this path · drag to move it' : 'click to compare this path · drag to move it'}
              >
                <span className="node-top">
                  {s && <span className="node-badge">{s.toUpperCase()}</span>}
                  <span className="node-name">{n.name}</span>
                </span>
                <span className="node-sub">
                  <b>{chfk(n.endNW)}</b>
                  <span className="node-risk">
                    <i className="node-dot" />
                    {n.risk === 'bad' ? 'cash runs out' : n.risk === 'warn' ? 'some cash risk' : 'cash OK'}
                  </span>
                  {n.busy && <span className="spinner tiny-spin" />}
                </span>
                <span className="node-icons">{n.icons || <span className="muted">no changes</span>}</span>
              </button>
              <button className="node-fork" onClick={() => p.onBranch(n.id)} title={`branch off “${n.name}”: keep its decisions and add a new one`}>
                +
              </button>
              {at.children > 0 && (
                <button className="node-fold" onClick={() => p.onToggle(n.id)} title={at.hidden ? 'show the branches' : 'hide the branches'}>
                  {at.hidden ? `▸ ${at.hidden}` : '▾'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {card && cardBox && (
        <>
          {cardBox.link && (
            <svg className="card-link" aria-hidden>
              <path d={cardBox.link.d} />
              <circle cx={cardBox.link.x1} cy={cardBox.link.y1} r={3.5} />
              <circle cx={cardBox.link.x2} cy={cardBox.link.y2} r={3.5} />
            </svg>
          )}
          <div ref={cardRef} className="add-card" style={{ left: cardBox.left, top: cardBox.top, width: CARD_W, maxHeight: size.h - HINT_H - 16 }} role="dialog" aria-label="new path">
            <div className="add-card-head" onPointerDown={onCardDown} title="drag to move">
              <span className="add-card-title">{card.title}</span>
              <button className="icon" onClick={p.onCloseAdd} title="close (Esc)">
                ✕
              </button>
            </div>
            <div className="add-card-body">{card.body}</div>
          </div>
        </>
      )}

      <p className="tree-hint">
        Each branch <b>continues</b> the path it grows from. Placement shows what builds on what, <b>not when</b>: the time is on the links.
        <span className="muted"> · scroll = zoom · drag the canvas = move · drag a node = rearrange</span>
      </p>
      <div className="tree-tools">
        {Object.keys(moved).length > 0 && (
          <button onClick={resetLayout} title="put every path back in its place">
            ↺
          </button>
        )}
        <button onClick={() => size.w && zoomAt(1 / 1.25, size.w / 2, size.h / 2)} title="zoom out">
          −
        </button>
        <button className="tree-pct" onClick={() => size.w && zoomAt(1 / view.k, size.w / 2, size.h / 2)} title="back to 100%">
          {Math.round(view.k * 100)}%
        </button>
        <button onClick={() => size.w && zoomAt(1.25, size.w / 2, size.h / 2)} title="zoom in">
          +
        </button>
        <button
          onClick={() => {
            touched.current = false
            fit()
          }}
          title="fit everything in view"
        >
          ⤢
        </button>
      </div>
    </div>
  )
})
