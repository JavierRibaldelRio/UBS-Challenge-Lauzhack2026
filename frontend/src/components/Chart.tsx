import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { chf, chfk } from '../lib/fmt'
import type { SimResult } from '../lib/sim'
import type { Profile } from '../lib/types'

export type ChartBranch = { id: string; name: string; color: string; result: SimResult; isBaseline: boolean }

export function ProjectionChart({ branches, profile, metric, months }: { branches: ChartBranch[]; profile: Profile; metric: 'nw' | 'cash'; months: number }) {
  const rows = Array.from({ length: months }, (_, t) => {
    const row: Record<string, number | [number, number] | null> = { t: t + 1 }
    for (const b of branches) {
      const s = b.result[metric][t]
      row[`${b.id}_band`] = [s.p10, s.p90]
      row[`${b.id}_p50`] = s.p50
    }
    row.observed = metric === 'cash' && t < profile.ledger_closing_cash.length ? profile.ledger_closing_cash[t] : null
    return row
  })
  const goals = profile.goals.map((g) => ({ ...g, month: monthsFromAsOf(profile.as_of, g.date) })).filter((g) => g.month > 0 && g.month <= months)
  const tickEvery = months <= 60 ? 12 : months <= 180 ? 24 : 60

  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={380}>
        <ComposedChart data={rows} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
          <XAxis dataKey="t" type="number" domain={[1, months]} ticks={Array.from({ length: Math.floor(months / tickEvery) + 1 }, (_, i) => i * tickEvery || 1)} tickFormatter={(t) => `age ${Math.floor(profile.age + t / 12)}`} stroke="var(--muted)" fontSize={12} />
          <YAxis tickFormatter={(v) => chfk(v).replace('CHF ', '')} stroke="var(--muted)" fontSize={12} width={56} />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }}
            labelFormatter={(t) => `Month ${t} · age ${(profile.age + Number(t) / 12).toFixed(1)}`}
            formatter={(v, name) => {
              if (Array.isArray(v)) return [`${chfk(v[0] as number)} – ${chfk(v[1] as number)}`, `${name} (80% range)`]
              return [chf(Number(v)), name]
            }}
          />
          <Legend />
          <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" />
          {branches.map((b) => (
            <Area key={`${b.id}_band`} dataKey={`${b.id}_band`} name={`${b.name}`} stroke="none" fill={b.color} fillOpacity={b.isBaseline ? 0.12 : 0.18} legendType="none" isAnimationActive={false} />
          ))}
          {branches.map((b) => (
            <Line key={`${b.id}_p50`} dataKey={`${b.id}_p50`} name={b.isBaseline ? `${b.name} (baseline)` : b.name} stroke={b.color} strokeWidth={b.isBaseline ? 2 : 2.5} strokeDasharray={b.isBaseline ? '6 3' : undefined} dot={false} isAnimationActive={false} />
          ))}
          {metric === 'cash' && <Line dataKey="observed" name="Observed ledger (synthetic data)" stroke="var(--text)" strokeWidth={1.5} dot={{ r: 1.5 }} connectNulls={false} isAnimationActive={false} />}
          {goals.map((g) => (
            <ReferenceDot key={g.name} x={g.month} y={g.target} r={5} fill="var(--goal)" stroke="var(--card)" label={{ value: `🎯 ${g.name}`, position: 'top', fontSize: 11, fill: 'var(--muted)' }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="hint">
        Line = median of 500 simulated paths. Shaded = 80% of paths (month-to-month spending surprises and bonuses learned from the data). 🎯 = this profile's goals from <code>synthetic-goals.csv</code>.
      </p>
    </div>
  )
}

function monthsFromAsOf(asOf: string, date: string) {
  const [y0, m0] = asOf.split('-').map(Number)
  const [y, m] = date.split('-').map(Number)
  return (y - y0) * 12 + (m - m0) + 1
}
