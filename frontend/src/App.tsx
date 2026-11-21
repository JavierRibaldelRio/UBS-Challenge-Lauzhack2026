import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { loadCsv, type Profile } from './lib/data'
import { ALEXIA_SCENARIOS, simulate } from './lib/engine'

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea']
const HORIZON = 120
const chf = (n: number) => `CHF ${Math.round(n).toLocaleString('de-CH')}`

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadCsv<Profile>('synthetic-profiles.csv').then(setProfiles).catch((e) => setError(String(e)))
  }, [])

  const alexia = profiles.find((p) => p.profile_id === 'P00001')
  const opening = alexia?.opening_cash_chf ?? 8000

  const results = useMemo(() => ALEXIA_SCENARIOS.map((s) => simulate(opening, HORIZON, s)), [opening])

  // recharts wants rows: { month, [scenarioName]: value }
  const rows = useMemo(
    () =>
      Array.from({ length: HORIZON }, (_, m) => {
        const row: Record<string, number> = { month: m + 1 }
        for (const r of results) row[r.scenario_name] = r.cash_by_month_chf[m]
        return row
      }),
    [results],
  )

  return (
    <main className="app">
      <header>
        <h1>AI Financial Twin</h1>
        <p className="muted">Don't predict the future. Make it explorable.</p>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Profile</h2>
        {alexia ? (
          <p>
            <b>{alexia.display_name}</b>, {alexia.age_at_start}, {alexia.city} ({alexia.canton}) ·{' '}
            {alexia.employment_status} · opening cash {chf(alexia.opening_cash_chf)} · {profiles.length} synthetic
            profiles loaded
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="card">
        <h2>Cash over 10 years (illustrative assumptions)</h2>
        <div style={{ width: '100%', height: 360 }}>
          <ResponsiveContainer>
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="month" tickFormatter={(m) => `${20 + Math.floor(m / 12)}y`} interval={11} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip formatter={(v) => chf(Number(v))} labelFormatter={(m) => `Month ${m}`} />
              <Legend />
              {results.map((r, i) => (
                <Line key={r.scenario_name} dataKey={r.scenario_name} stroke={COLORS[i]} dot={false} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Closing cash</th>
              <th>Lowest cash</th>
              <th>First negative month</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.scenario_name}>
                <td>{r.scenario_name}</td>
                <td>{chf(r.closing_cash_chf)}</td>
                <td>{chf(r.minimum_cash_chf)}</td>
                <td>{r.first_negative_month ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="muted">Fictional data and assumptions. Not a forecast, not financial advice.</footer>
    </main>
  )
}
