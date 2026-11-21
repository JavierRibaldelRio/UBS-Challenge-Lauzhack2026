// The scenario tree (pre_docs/examples/example-outputs.md §3 "Scenario Tree", ai-and-technology.md §21 "branching narratives").
// Every path is a node. The root is today's state ("if nothing changes"). A branch keeps every decision of its parent
// and adds its own, so the tree reads left to right like a life: today -> a decision -> a later decision...
// Pure functions, O(n): fine for hundreds of nodes.
import type { ScenarioSpec, TwinEvent } from './types'

export type TreeNode = { id: string; parentId: string | null }
export type Placed = { id: string; x: number; y: number; depth: number; children: number; hidden: number }
export type Edge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number }

export const NODE_W = 228
export const NODE_H = 86
const GAP_X = 96 // room for the "+8 yrs" label on each link
const GAP_Y = 18

/** Left-to-right tidy tree: depth = column, leaves stacked in order, a parent sits in the middle of its children. */
export function layoutTree(nodes: TreeNode[], collapsed: ReadonlySet<string>) {
  const ids = new Set(nodes.map((n) => n.id))
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null
    if (p == null) roots.push(n.id)
    else kids.set(p, [...(kids.get(p) ?? []), n.id])
  }
  const placed = new Map<string, Placed>()
  const edges: Edge[] = []
  let row = 0
  let maxDepth = 0
  const count = (id: string): number => (kids.get(id) ?? []).reduce((a, c) => a + 1 + count(c), 0)
  const seen = new Set<string>()
  const visit = (id: string, depth: number): number => {
    seen.add(id) // guards against cycles in bad data
    maxDepth = Math.max(maxDepth, depth)
    const ch = (kids.get(id) ?? []).filter((c) => !seen.has(c))
    const open = !collapsed.has(id)
    let y: number
    if (!ch.length || !open) y = row++ * (NODE_H + GAP_Y)
    else {
      const ys = ch.map((c) => visit(c, depth + 1))
      y = (ys[0] + ys[ys.length - 1]) / 2
    }
    placed.set(id, { id, x: depth * (NODE_W + GAP_X), y, depth, children: ch.length, hidden: open ? 0 : count(id) })
    return y
  }
  for (const r of roots) visit(r, 0)
  for (const n of nodes) {
    const a = n.parentId ? placed.get(n.parentId) : undefined
    const b = placed.get(n.id)
    if (a && b) edges.push({ from: a.id, to: b.id, x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x, y2: b.y + NODE_H / 2 })
  }
  return { placed, edges, width: (maxDepth + 1) * (NODE_W + GAP_X) - GAP_X, height: Math.max(1, row) * (NODE_H + GAP_Y) - GAP_Y }
}

/** Events compared by meaning (not by label), so "the same decision" matches across paths. */
export const eventKey = (e: TwinEvent) => JSON.stringify([e.type, e.start_month ?? 0, e.duration_months, e.monthly_net_income_chf, e.income_change_pct, e.monthly_amount_chf, e.amount_chf, e.annual_tuition_chf, e.city, e.household_type, e.annual_rate_pct, e.drop_pct, e.down_payment_pct, e.depreciation_pct])

/** Where does a new path hang in the tree? Under the existing path whose decisions it contains entirely (the most of them). */
export function inferParent(spec: ScenarioSpec, candidates: { id: string; spec: ScenarioSpec }[], root: string): string {
  const mine = new Set(spec.events.map(eventKey))
  let best = root
  let bestN = 0
  for (const c of candidates) {
    const theirs = c.spec.events.map(eventKey)
    if (theirs.length <= bestN || theirs.length >= mine.size) continue // must be a strict subset with more events than the best so far
    if (theirs.every((k) => mine.has(k))) {
      best = c.id
      bestN = theirs.length
    }
  }
  return best
}

/** A branch must keep its parent's decisions: add the ones the new path forgot (same type and start). */
export function withParentEvents(spec: ScenarioSpec, parent: ScenarioSpec): ScenarioSpec {
  const has = (e: TwinEvent) => spec.events.some((x) => x.type === e.type && (x.start_month ?? 0) === (e.start_month ?? 0))
  const missing = parent.events.filter((e) => !has(e))
  return missing.length ? { ...spec, events: [...missing, ...spec.events] } : spec
}

/**
 * Set the time on a link: the branch's NEW decisions (those not in its parent) move so the first one starts
 * `years` after the parent's last decision. Every sub-branch that copied those decisions moves with them,
 * so the tree stays consistent. Returns the paths that change (id -> new spec), or null if nothing can move.
 */
export function shiftBranch(nodes: { id: string; parentId: string | null; spec: ScenarioSpec }[], childId: string, years: number): Map<string, ScenarioSpec> | null {
  const child = nodes.find((n) => n.id === childId)
  const parent = child?.parentId ? nodes.find((n) => n.id === child.parentId) : undefined
  if (!child || !parent || !Number.isFinite(years)) return null
  const known = new Set(parent.spec.events.map(eventKey))
  const fresh = child.spec.events.filter((e) => !known.has(eventKey(e)))
  if (!fresh.length) return null
  const ref = Math.max(0, ...parent.spec.events.map((e) => e.start_month ?? 0))
  const first = Math.min(...fresh.map((e) => e.start_month ?? 0))
  const delta = Math.max(0, ref + Math.round(years * 12)) - first
  if (!delta) return new Map()
  const moved = new Map(fresh.map((e) => [eventKey(e), { ...e, start_month: Math.max(0, (e.start_month ?? 0) + delta) }]))
  // the child and all its descendants (they carry copies of these decisions)
  const kids = new Map<string, string[]>()
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id])
  const out = new Map<string, ScenarioSpec>()
  const visit = (id: string, guard = 0) => {
    const n = nodes.find((x) => x.id === id)
    if (!n || guard > 500) return
    let changed = false
    const events = n.spec.events.map((e) => {
      const m = moved.get(eventKey(e))
      if (!m) return e
      changed = true
      return { ...m, label: e.label, _source: e._source }
    })
    if (changed) out.set(id, { ...n.spec, events })
    for (const k of kids.get(id) ?? []) visit(k, guard + 1)
  }
  visit(childId)
  return out
}

/**
 * Add events to a path. An "added" event that is really a change of an existing one (same type, and the same start or
 * the same label, e.g. giving the house its price) is MERGED into it instead of creating a duplicate.
 */
export function addEvents(events: TwinEvent[], add: TwinEvent[]): TwinEvent[] {
  const out = [...events]
  for (const e of add) {
    const i = out.findIndex((x) => x.type === e.type && ((x.start_month ?? 0) === (e.start_month ?? 0) || x.label.trim().toLowerCase() === e.label.trim().toLowerCase()))
    if (i < 0) {
      out.push(e)
      continue
    }
    const merged = { ...out[i] } as Record<string, unknown>
    for (const [k, v] of Object.entries(e)) if (v != null && k !== 'label') merged[k] = v
    out[i] = merged as TwinEvent
  }
  return out
}
