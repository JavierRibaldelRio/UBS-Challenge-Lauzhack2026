import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { chf, chfk, monthIndex } from '../lib/fmt'
import type { Plan } from '../lib/resolve'
import type { SimResult } from '../lib/sim'
import type { Profile } from '../lib/types'

export type ChartSide = { key: 'a' | 'b'; name: string; plan: Plan; result: SimResult; unknownFrom: number | null; markers: { month: number; icon: string; text: string }[] }

const COLOR = { a: 'var(--a)', b: 'var(--b)' }

/** The value at the very start (before month 1): what the person has today. */
function startValue(plan: Plan, metric: 'nw' | 'cash') {
  if (metric === 'cash') return plan.startCash
  return plan.startCash + plan.startInvest + plan.startHome - plan.loans.filter((l) => !l.isNew).reduce((a, l) => a + l.principal, 0)
}

/** A vs B, one point per year (age on the x axis). Median line + the range where 8 in 10 simulated futures land. */
export function CompareChart({ sides, metric, profile, years, observed }: { sides: ChartSide[]; metric: 'nw' | 'cash'; profile: Profile; years: number; observed: boolean }) {
  const floor = metric === 'cash' && profile.minCash ? profile.minCash : null
  const rows = Array.from({ length: years + 1 }, (_, y) => {
    const t = y * 12 - 1
    const row: Record<string, number | [number, number] | null> = { age: profile.age + y }
    for (const s of sides) {
      const v = y === 0 ? startValue(s.plan, metric) : s.result[metric][t].p50
      const band = y === 0 ? [v, v] : [s.result[metric][t].p10, s.result[metric][t].p90]
      const u = s.unknownFrom == null ? null : s.unknownFrom / 12 // in years
      row[s.key] = u == null || y <= Math.ceil(u) ? v : null // solid while nothing unknown matters
      row[`${s.key}_u`] = u != null && y >= Math.floor(u) ? v : null // dotted after (overlaps one point -> continuous)
      row[`${s.key}_band`] = band as [number, number]
    }
    // real bank balance from the data (observed, not simulated): opening balance + each year-end in the ledger
    if (metric === 'cash' && observed) {
      const led = profile.ledger_closing_cash
      row.observed = y === 0 ? profile.cash : y * 12 - 1 < led.length ? led[y * 12 - 1] : null
    }
    return row
  })
  const goals = metric === 'cash' ? profile.goals.map((g) => ({ ...g, x: profile.age + (monthIndex(profile.as_of, g.date) + 1) / 12 })).filter((g) => g.x > profile.age && g.x <= profile.age + years) : []
  const last = rows[rows.length - 1]
  const name = (k: string) => sides.find((s) => s.key === k[0])?.name ?? k

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={rows} margin={{ top: 18, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="age" type="number" domain={[profile.age, profile.age + years]} allowDecimals={false} tickCount={Math.min(years + 1, 11)} stroke="var(--muted)" fontSize={12} tickLine={false} />
          <YAxis tickFormatter={(v) => chfk(v).replace('CHF ', '')} stroke="var(--muted)" fontSize={12} width={52} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ background: 'color-mix(in srgb, var(--card) 80%, transparent)', backdropFilter: 'blur(2px)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, color: 'var(--text)' }}
            wrapperStyle={{ opacity: 0.85, pointerEvents: 'none' }}
            cursor={{ stroke: 'var(--text)', strokeOpacity: 0.4, strokeDasharray: '3 3' }}
            labelFormatter={(a) => `Age ${a}`}
            formatter={(v, key) => {
              const k = String(key)
              if (k === 'observed') return [chf(Number(v)), 'Real bank balance (data)']
              if (k.endsWith('_band')) return [`${chfk((v as number[])[0])} to ${chfk((v as number[])[1])}`, `${k[0].toUpperCase()} · 8 in 10 futures`]
              if (k.endsWith('_u')) return [chf(Number(v)), `${k[0].toUpperCase()} · ${name(k)} (depends on unknowns)`]
              return [chf(Number(v)), `${k.toUpperCase()} · ${name(k)}`]
            }}
          />
          <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" strokeOpacity={0.6} />
          {floor != null && <ReferenceLine y={floor} stroke="var(--warn)" strokeDasharray="6 4" strokeOpacity={0.8} label={{ value: `your floor ${chfk(floor).replace('CHF ', '')}`, position: 'insideBottomLeft', fontSize: 11, fill: 'var(--warn)' }} />}
          {sides.map((s) => (
            <Area key={`${s.key}_band`} dataKey={`${s.key}_band`} stroke="none" fill={COLOR[s.key]} fillOpacity={0.12} isAnimationActive={false} activeDot={false} />
          ))}
          {sides.map((s) =>
            s.markers
              .filter((m) => m.month > 0 && m.month < years * 12)
              .map((m, i) => <ReferenceLine key={`${s.key}m${i}`} x={profile.age + m.month / 12} stroke={COLOR[s.key]} strokeOpacity={0.35} strokeDasharray="2 4" label={{ value: m.icon, position: s.key === 'a' ? 'insideTopLeft' : 'insideTopRight', fontSize: 13 }} />),
          )}
          {sides.map((s) => (
            <Line key={s.key} dataKey={s.key} stroke={COLOR[s.key]} strokeWidth={2.5} dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
          {sides.filter((s) => s.unknownFrom != null).map((s) => (
            <Line key={`${s.key}_u`} dataKey={`${s.key}_u`} stroke={COLOR[s.key]} strokeWidth={2.5} strokeDasharray="2 5" strokeLinecap="round" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          ))}
          {metric === 'cash' && observed && <Line dataKey="observed" stroke="var(--text)" strokeWidth={0} dot={{ r: 4, fill: 'var(--text)', stroke: 'var(--card)', strokeWidth: 2 }} activeDot={false} isAnimationActive={false} />}
          {goals.map((g) => (
            <ReferenceDot key={g.name} x={g.x} y={g.target} r={5} fill="var(--goal)" stroke="var(--card)" strokeWidth={2} label={{ value: '🎯', position: 'top', fontSize: 12 }} />
          ))}
          {/* direct labels at the line ends: identity is never color alone */}
          {sides.map((s) => {
            const v = (last[s.key] ?? last[`${s.key}_u`]) as number | null
            return v == null ? null : <ReferenceDot key={`${s.key}_end`} x={last.age as number} y={v} r={0} label={{ value: s.key.toUpperCase(), position: 'right', fontSize: 12, fontWeight: 700, fill: 'var(--text)' }} />
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
