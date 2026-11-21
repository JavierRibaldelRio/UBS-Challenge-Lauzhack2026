import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { chf, chfk, monthIndex } from '../lib/fmt'
import type { SimResult } from '../lib/sim'
import type { Profile } from '../lib/types'

export type ChartPath = { id: string; name: string; color: string; result: SimResult; isBaseline: boolean }

/** Median line per path; the shaded 80% range only for the selected path (keeps the chart calm). */
export function ProjectionChart({ paths, focusId, profile, metric, months }: { paths: ChartPath[]; focusId: string; profile: Profile; metric: 'nw' | 'cash'; months: number }) {
  const rows = Array.from({ length: months }, (_, t) => {
    const row: Record<string, number | [number, number] | null> = { t: t + 1 }
    for (const p of paths) {
      const s = p.result[metric][t]
      row[p.id] = s.p50
      if (p.id === focusId) row.band = [s.p10, s.p90]
    }
    row.observed = metric === 'cash' && t < profile.ledger_closing_cash.length ? profile.ledger_closing_cash[t] : null
    return row
  })
  const focus = paths.find((p) => p.id === focusId)
  const goals = profile.goals.map((g) => ({ ...g, m: monthIndex(profile.as_of, g.date) + 1 })).filter((g) => g.m > 0 && g.m <= months)
  const step = months <= 60 ? 12 : months <= 180 ? 24 : 60
  const ticks = Array.from({ length: Math.floor(months / step) + 1 }, (_, i) => Math.max(1, i * step))

  return (
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={rows} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="t" type="number" domain={[1, months]} ticks={ticks} tickFormatter={(t) => `${Math.floor(profile.age + t / 12)}`} stroke="var(--muted)" fontSize={12} tickLine={false} label={{ value: 'age', position: 'insideBottomRight', offset: -2, fontSize: 11, fill: 'var(--muted)' }} />
        <YAxis tickFormatter={(v) => chfk(v).replace('CHF ', '')} stroke="var(--muted)" fontSize={12} width={52} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 }}
          labelFormatter={(t) => `Age ${(profile.age + Number(t) / 12).toFixed(1)}`}
          formatter={(v, key) => {
            if (key === 'band') return [`${chfk((v as number[])[0])} to ${chfk((v as number[])[1])}`, `${focus?.name}: 8 in 10 runs`]
            if (key === 'observed') return [chf(Number(v)), 'Real ledger (data)']
            return [chf(Number(v)), paths.find((p) => p.id === key)?.name ?? key]
          }}
        />
        <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" strokeOpacity={0.6} />
        {focus && <Area dataKey="band" stroke="none" fill={focus.color} fillOpacity={0.15} isAnimationActive={false} />}
        {paths.map((p) => (
          <Line key={p.id} dataKey={p.id} stroke={p.color} strokeWidth={p.id === focusId ? 3 : 2} strokeOpacity={p.id === focusId ? 1 : 0.55} strokeDasharray={p.isBaseline ? '6 4' : undefined} dot={false} isAnimationActive={false} />
        ))}
        {metric === 'cash' && <Line dataKey="observed" stroke="var(--text)" strokeWidth={0} dot={{ r: 2.5, fill: 'var(--text)' }} isAnimationActive={false} />}
        {goals.map((g) => (
          <ReferenceDot key={g.name} x={g.m} y={g.target} r={5} fill="var(--goal)" stroke="var(--card)" strokeWidth={2} label={{ value: g.name, position: 'top', fontSize: 11, fill: 'var(--muted)' }} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
