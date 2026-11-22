import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { drivers } from '../lib/analysis'
import { chfk } from '../lib/fmt'
import type { Plan } from '../lib/resolve'
import { NO_KNOBS, runPath, type Knobs } from '../lib/sim'
import type { Params } from '../lib/types'

// Sensitivity analysis (pre_docs/examples/example-outputs.md §5; scenario-modelling.md §11):
// "A sensitivity chart may show how changing one assumption affects an outcome. The chart should identify the assumptions being changed."
// Deterministic runs (expected values, no luck) so only the assumption moves the result. Same change for both paths.

export type SensSide = { key: 'a' | 'b'; name: string; plan: Plan }
type Input = { id: string; label: string; unit: '%' | 'pts'; steps: number[]; knob: (x: number) => Partial<Knobs> }

const PCT = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30]
const INPUTS: Input[] = [
  { id: 'income', label: 'Income', unit: '%', steps: PCT, knob: (x) => ({ income: 1 + x / 100 }) },
  { id: 'rent', label: 'Rent', unit: '%', steps: PCT, knob: (x) => ({ rent: 1 + x / 100 }) },
  { id: 'other', label: 'Other living costs', unit: '%', steps: PCT, knob: (x) => ({ other: 1 + x / 100 }) },
  { id: 'oneoff', label: 'One-off costs & tuition', unit: '%', steps: PCT, knob: (x) => ({ oneOff: 1 + x / 100 }) },
  { id: 'ret', label: 'Investment return', unit: 'pts', steps: [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3], knob: (x) => ({ retShift: x / 100 }) },
]
const endNW = (plan: Plan, params: Params, k: Partial<Knobs>) => {
  const o = runPath(plan, params, null, { ...NO_KNOBS, ...k })
  return o.nw[o.nw.length - 1]
}
const fmtX = (x: number, unit: Input['unit']) => (x === 0 ? 'as assumed' : `${x > 0 ? '+' : ''}${x}${unit === '%' ? '%' : ' pts'}`)

export function Sensitivity({ sides, params, endAge }: { sides: SensSide[]; params: Params; endAge: number }) {
  const [inputId, setInputId] = useState('income')
  const input = INPUTS.find((i) => i.id === inputId)!

  // ---- tornado: each input ±10% (return ±1 point), per path
  const tornado = useMemo(() => {
    const per = sides.map((s) => ({ key: s.key, d: drivers(s.plan, params) }))
    const names = [...new Set(per.flatMap((p) => p.d.map((x) => x.name)))]
    const rows = names.map((name) => ({ name, bars: per.map((p) => ({ key: p.key, ...(p.d.find((x) => x.name === name) ?? { low: 0, high: 0, range: 0 }) })) }))
    rows.sort((x, y) => Math.max(...y.bars.map((b) => b.range)) - Math.max(...x.bars.map((b) => b.range)))
    const max = Math.max(1, ...rows.flatMap((r) => r.bars.flatMap((b) => [Math.abs(b.low), Math.abs(b.high)])))
    return { rows, max }
  }, [sides, params])

  // ---- curve: end net worth when one input is off by x, for both paths
  const curve = useMemo(() => {
    const data = input.steps.map((x) => {
      const row: Record<string, number> = { x }
      for (const s of sides) row[s.key] = endNW(s.plan, params, input.knob(x))
      return row
    })
    // where the order of A and B flips (linear interpolation between steps)
    let cross: { x: number; y: number } | null = null
    if (sides.length === 2) {
      for (let i = 1; i < data.length && !cross; i++) {
        const d0 = data[i - 1].a - data[i - 1].b
        const d1 = data[i].a - data[i].b
        if (d0 === 0 || d0 * d1 < 0) {
          const f = d0 === 0 ? 0 : d0 / (d0 - d1)
          cross = { x: data[i - 1].x + f * (data[i].x - data[i - 1].x), y: data[i - 1].a + f * (data[i].a - data[i - 1].a) }
        }
      }
    }
    return { data, cross }
  }, [sides, params, input])

  const name = (k: string) => sides.find((s) => s.key === k)?.name ?? k
  return (
    <section className="card sens">
      <div className="card-head">
        <h2>Sensitivity</h2>
        <span className="muted small">what if an assumption is off? Each input changed on its own, the same for {sides.length === 2 ? 'both paths' : 'the path'}; expected values (no luck), net worth at {endAge}</span>
      </div>
      <div className="sens-grid">
        <div>
          <h3 className="chart-title">What moves the result most</h3>
          <div className="tornado">
            <div className="tornado-axis small muted">
              <span>worse</span>
              <span>net worth at {endAge}</span>
              <span>better</span>
            </div>
            {tornado.rows.map((r) => (
              <div key={r.name} className="t-row">
                <span className="t-name">{r.name.replace('±10%', '').replace('±1 pt', '').trim()} <small className="muted">{r.name.includes('pt') ? '±1 pt' : '±10%'}</small></span>
                <div className="t-bars">
                  {r.bars.map((b) => {
                    const lo = Math.min(b.low, b.high)
                    const hi = Math.max(b.low, b.high)
                    return (
                      <div key={b.key} className={`t-bar t-${b.key}`} title={`${name(b.key)}: ${chfk(lo)} to +${chfk(hi).replace('CHF ', 'CHF ')}`}>
                        <span className="t-neg" style={{ width: `${(Math.abs(Math.min(0, lo)) / tornado.max) * 50}%` }} />
                        <span className="t-pos" style={{ width: `${(Math.max(0, hi) / tornado.max) * 50}%` }} />
                        <span className="t-val t-val-l">{lo < -1 ? `−${chfk(-lo).replace('CHF ', '')}` : ''}</span>
                        <span className="t-val t-val-r">{hi > 1 ? `+${chfk(hi).replace('CHF ', '')}` : ''}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {!tornado.rows.length && <p className="muted small">Nothing here moves the result.</p>}
          </div>
        </div>
        <div>
          <div className="sens-head">
            <h3 className="chart-title">What if it’s off by…</h3>
            <select className="mini" value={inputId} onChange={(e) => setInputId(e.target.value)} aria-label="assumption to change">
              {INPUTS.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={curve.data} margin={{ top: 14, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} ticks={input.steps.filter((_, i) => i % 2 === 0)} tickFormatter={(x) => (x === 0 ? '0' : `${x > 0 ? '+' : ''}${x}${input.unit === '%' ? '%' : ''}`)} stroke="var(--muted)" fontSize={11} tickLine={false} />
                <YAxis tickFormatter={(v) => chfk(v).replace('CHF ', '')} stroke="var(--muted)" fontSize={11} width={50} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'color-mix(in srgb, var(--card) 85%, transparent)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--text)' }}
                  labelFormatter={(x) => `${input.label}: ${fmtX(Number(x), input.unit)}`}
                  formatter={(v, k) => [chfk(Number(v)), `${String(k).toUpperCase()} · ${name(String(k))}`]}
                />
                <ReferenceLine x={0} stroke="var(--text)" strokeOpacity={0.35} strokeDasharray="3 3" label={{ value: 'as assumed', position: 'insideTopRight', fontSize: 10, fill: 'var(--muted)' }} />
                <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" strokeOpacity={0.5} />
                {sides.map((s) => (
                  <Line key={s.key} dataKey={s.key} stroke={`var(--${s.key})`} strokeWidth={2.5} dot={{ r: 2.5, fill: `var(--${s.key})`, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
                {curve.cross && <ReferenceDot x={curve.cross.x} y={curve.cross.y} r={5} fill="var(--card)" stroke="var(--text)" strokeWidth={2} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small sens-note">
            {sides.length === 2 ? (
              curve.cross ? (
                <>
                  <b>The order flips</b> if {input.label.toLowerCase()} is {fmtX(Math.round(curve.cross.x * 10) / 10, input.unit)} for both paths (○).
                </>
              ) : (
                <>Between {fmtX(input.steps[0], input.unit)} and {fmtX(input.steps.at(-1)!, input.unit)}, the order of A and B does not change.</>
              )
            ) : (
              <>Pick a second path to compare how both react.</>
            )}{' '}
            <span className="muted">A change that only one path feels (e.g. tuition) is how the lines cross.</span>
          </p>
        </div>
      </div>
    </section>
  )
}
