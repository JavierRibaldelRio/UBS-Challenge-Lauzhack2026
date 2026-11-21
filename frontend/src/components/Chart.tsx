import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { chf, chfk, monthIndex } from '../lib/fmt'
import type { PathOut, SimResult } from '../lib/sim'
import type { UnknownImpact } from '../lib/unknowns'
import type { Profile } from '../lib/types'

export type ChartPath = { id: string; name: string; color: string; result: SimResult; isBaseline: boolean; unknown?: UnknownImpact | null }

/** Median line per path; the shaded 80% range only for the selected path (keeps the chart calm). */
export type Marker = { month: number; icon: string; text: string }

export function ProjectionChart({ paths, focusId, profile, metric, months, markers = [], focusParts }: { paths: ChartPath[]; focusId: string; profile: Profile; metric: 'nw' | 'cash'; months: number; markers?: Marker[]; focusParts?: PathOut }) {
  const rows = Array.from({ length: months }, (_, t) => {
    const row: Record<string, number | [number, number] | null> = { t: t + 1 }
    for (const p of paths) {
      const s = p.result[metric][t]
      const u = p.unknown
      // solid until an unknown starts to matter, dashed after (one month of overlap so the line is continuous)
      row[p.id] = !u || t <= u.from ? s.p50 : null
      if (u) row[`${p.id}__u`] = t >= u.from ? s.p50 : null
      if (u && p.id === focusId && t >= u.from) row.fog = [s.p50 + u[metric][t].lo, s.p50 + u[metric][t].hi]
      if (p.id === focusId) {
        row.band = [s.p10, s.p90]
        p.result.samples.forEach((sm, i) => (row[`s${i}`] = sm[metric][t])) // single futures: the real bumpy months
        // in the net worth view, also show the selected path's CASH (dotted): a home purchase drops cash, not net worth
        if (metric === 'nw') {
          row.focusCash = p.result.cash[t].p50
          // what the selected path's net worth is made of: home value (+) and debt (−, e.g. the mortgage)
          if (focusParts) {
            row.focusHome = focusParts.home[t] || null
            row.focusDebt = focusParts.debt[t] ? -focusParts.debt[t] : null
          }
        }
      }
    }
    row.observed = metric === 'cash' && t < profile.ledger_closing_cash.length ? profile.ledger_closing_cash[t] : null
    return row
  })
  const focus = paths.find((p) => p.id === focusId)
  const goals = profile.goals.map((g) => ({ ...g, m: monthIndex(profile.as_of, g.date) + 1 })).filter((g) => g.m > 0 && g.m <= months)
  const step = months <= 60 ? 12 : months <= 180 ? 24 : 60
  const ticks = Array.from({ length: Math.floor(months / step) + 1 }, (_, i) => Math.max(1, i * step))

  return (
    <div className="chart-box">
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={rows} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <pattern id="fog" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
            <rect width="7" height="7" fill={focus?.color ?? '#888'} fillOpacity="0.05" />
            <line x1="0" y1="0" x2="0" y2="7" stroke={focus?.color ?? '#888'} strokeWidth="2.2" strokeOpacity="0.28" />
          </pattern>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="t" type="number" domain={[1, months]} ticks={ticks} tickFormatter={(t) => `${Math.floor(profile.age + t / 12)}`} stroke="var(--muted)" fontSize={12} tickLine={false} />
        <YAxis tickFormatter={(v) => chfk(v).replace('CHF ', '')} stroke="var(--muted)" fontSize={12} width={52} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 }}
          labelFormatter={(t) => `Age ${(profile.age + Number(t) / 12).toFixed(1)}`}
          formatter={(v, key) => {
            if (key === 'band') return [`${chfk((v as number[])[0])} to ${chfk((v as number[])[1])}`, `${focus?.name}: 8 in 10 runs`]
            if (key === 'observed') return [chf(Number(v)), 'Real ledger (data)']
            if (typeof key === 'string' && /^s\d$/.test(key)) return [null, null] as unknown as [string, string]
            if (key === 'focusCash') return [chf(Number(v)), `${focus?.name}: cash only`]
            if (key === 'focusHome') return [chf(Number(v)), `${focus?.name}: assets (home, car…)`]
            if (key === 'focusDebt') return [chf(Number(v)), `${focus?.name}: debt (mortgage + loans)`]
            if (key === 'fog') return [`${chfk((v as number[])[0])} to ${chfk((v as number[])[1])}`, `${focus?.name}: if the unknown numbers were different`]
            if (typeof key === 'string' && key.endsWith('__u')) return [chf(Number(v)), `${paths.find((p) => p.id === key.slice(0, -3))?.name} (depends on unknowns)`]
            return [chf(Number(v)), paths.find((p) => p.id === key)?.name ?? key]
          }}
        />
        <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" strokeOpacity={0.6} />
        {focus && <Area dataKey="band" stroke="none" fill={focus.color} fillOpacity={0.15} isAnimationActive={false} />}
        {focus && focus.result.samples.map((_, i) => <Line key={`s${i}`} dataKey={`s${i}`} stroke={focus.color} strokeWidth={0.8} strokeOpacity={0.28} dot={false} activeDot={false} legendType="none" isAnimationActive={false} />)}
        {focus?.unknown && <Area dataKey="fog" stroke={focus.color} strokeOpacity={0.35} strokeDasharray="2 3" fill="url(#fog)" isAnimationActive={false} />}
        {focus?.unknown && <ReferenceLine x={focus.unknown.from + 1} stroke={focus.color} strokeOpacity={0.5} label={{ value: '?', position: 'insideTopRight', fontSize: 15, fontWeight: 700, fill: focus.color }} />}
        {paths.map((p) => (
          <Line key={p.id} dataKey={p.id} stroke={p.color} strokeWidth={p.id === focusId ? 3 : 2} strokeOpacity={p.id === focusId ? 1 : 0.55} strokeDasharray={p.isBaseline ? '6 4' : undefined} dot={false} isAnimationActive={false} />
        ))}
        {paths
          .filter((p) => p.unknown)
          .map((p) => (
            <Line key={`${p.id}__u`} dataKey={`${p.id}__u`} stroke={p.color} strokeWidth={p.id === focusId ? 2.5 : 1.6} strokeOpacity={p.id === focusId ? 0.85 : 0.45} strokeDasharray="2 5" strokeLinecap="round" dot={false} isAnimationActive={false} />
          ))}
        {metric === 'nw' && focus && focus.result.nw.some((b, i) => Math.abs(b.p50 - focus.result.cash[i].p50) > 1) && (
          <Line dataKey="focusCash" stroke={focus.color} strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
        )}
        {metric === 'nw' && focus && focusParts?.home.some((x) => x > 0) && <Area dataKey="focusHome" stroke="#059669" strokeWidth={1.5} fill="#059669" fillOpacity={0.08} isAnimationActive={false} />}
        {metric === 'nw' && focus && focusParts?.debt.some((x) => x > 0) && <Area dataKey="focusDebt" stroke="var(--danger)" strokeWidth={1.5} fill="var(--danger)" fillOpacity={0.07} isAnimationActive={false} />}
        {markers
          .filter((m) => m.month >= 0 && m.month < months)
          .map((m, i) => (
            <ReferenceLine key={`${m.month}-${i}`} x={m.month + 1} stroke={focus?.color ?? 'var(--muted)'} strokeOpacity={0.35} strokeDasharray="3 3" label={{ value: m.icon, position: 'insideTopLeft', fontSize: 14 }} />
          ))}
        {metric === 'cash' && <Line dataKey="observed" stroke="var(--text)" strokeWidth={0} dot={{ r: 2.5, fill: 'var(--text)' }} isAnimationActive={false} />}
        {goals.map((g) => (
          <ReferenceDot key={g.name} x={g.m} y={g.target} r={5} fill="var(--goal)" stroke="var(--card)" strokeWidth={2} label={{ value: `🎯 ${chfk(g.target).replace('CHF ', '')}`, position: 'top', fontSize: 11, fill: 'var(--muted)' }} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
    </div>
  )
}

