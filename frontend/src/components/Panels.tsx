import type { Driver } from '../lib/analysis'
import { chf, chfk, pct } from '../lib/fmt'
import type { Check, SimResult } from '../lib/sim'
import type { ExplainResult, Params, Profile } from '../lib/types'
import { SOURCE_INFO, SourceTag } from './BranchCard'

export function ProfileCard({ p }: { p: Profile }) {
  const debt = p.loans.reduce((a, l) => a + l.principal, 0)
  return (
    <div className="profile">
      <div className="profile-name">
        <b>{p.name}</b> <span className="muted">({p.id}, fictional)</span>
      </div>
      <div className="kv">
        <span>Age</span>
        <b>{p.age}</b>
        <span>City</span>
        <b>
          {p.city} ({p.canton})
        </b>
        <span>Status</span>
        <b>{p.status.replace('_', ' ')}</b>
        <span>Household</span>
        <b>{p.household.replace('_', ' ')}</b>
        <span>Net income</span>
        <b>{chf(p.income)}/mo</b>
        <span>Rent</span>
        <b>{chf(p.rent)}/mo</b>
        <span>Other spending</span>
        <b>
          {chf(p.calib.other_mu)}/mo <span className="muted">± {chf(p.calib.other_sd)}</span>
        </b>
        <span>Cash</span>
        <b>{chf(p.cash)}</b>
        {p.investments > 0 && (
          <>
            <span>Investments</span>
            <b>{chf(p.investments)}</b>
          </>
        )}
        {debt > 0 && (
          <>
            <span>Debt</span>
            <b>{chf(debt)}</b>
          </>
        )}
      </div>
      {p.goals.length > 0 && (
        <div className="goals">
          {p.goals.map((g) => (
            <div key={g.name}>
              🎯 {g.name}: {chf(g.target)} by {g.date.slice(0, 7)} <span className="muted">({g.priority})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ResultsTable({ rows, months, age }: { rows: { id: string; name: string; color: string; result: SimResult; isBaseline: boolean }[]; months: number; age: number }) {
  const base = rows.find((r) => r.isBaseline) ?? rows[0]
  const goalNames = [...new Set(rows.flatMap((r) => r.result.goals.filter((g) => g.prob != null).map((g) => g.name)))]
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Net worth at {age + months / 12} (median)</th>
            <th>80% range</th>
            <th>vs baseline</th>
            <th>Lowest cash</th>
            <th>Cash &lt; 0</th>
            {goalNames.map((g) => (
              <th key={g}>🎯 {g}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="dot" style={{ background: r.color }} /> {r.name} {r.isBaseline && <span className="muted">(baseline)</span>}
              </td>
              <td>
                <b>{chfk(r.result.endNW.p50)}</b>
              </td>
              <td className="muted">
                {chfk(r.result.endNW.p10)} – {chfk(r.result.endNW.p90)}
              </td>
              <td className={r.result.endNW.p50 >= base.result.endNW.p50 ? 'pos' : 'neg'}>{r.isBaseline ? '—' : chfk(r.result.endNW.p50 - base.result.endNW.p50)}</td>
              <td className={r.result.minCash.p50 < 0 ? 'neg' : ''}>{chfk(r.result.minCash.p50)}</td>
              <td className={r.result.probNegCash > 0.05 ? 'neg' : ''}>
                {pct(r.result.probNegCash)}
                {r.result.firstNegMonth != null && <span className="muted"> (from age {Math.floor(age + r.result.firstNegMonth / 12)})</span>}
              </td>
              {goalNames.map((g) => {
                const x = r.result.goals.find((y) => y.name === g)
                return <td key={g}>{x?.prob != null ? pct(x.prob) : '—'}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">"Cash &lt; 0" = share of simulated paths where cash goes negative at least once (the ledger's "requires financing" status). Goal % = share of paths where cash + investments reach the target by its date.</p>
    </div>
  )
}

export function DriversPanel({ drivers, name, breakEven, baselineName, age }: { drivers: Driver[]; name: string; breakEven: { pct: number; month: number; incomeNeeded: number } | null; baselineName: string; age: number }) {
  const max = Math.max(1, ...drivers.map((d) => Math.max(Math.abs(d.low), Math.abs(d.high))))
  return (
    <div>
      <p className="muted small">
        What moves <b>{name}</b>'s end net worth most? Each input is nudged, everything else fixed.
      </p>
      {drivers.map((d) => (
        <div key={d.name} className="tornado-row">
          <span className="tornado-label">{d.name}</span>
          <div className="tornado-bar">
            {[d.low, d.high].map((v, i) => (
              <div key={i} className={`tb ${v < 0 ? 'tb-neg' : 'tb-pos'}`} style={{ width: `${(Math.abs(v) / max) * 50}%`, [v < 0 ? 'right' : 'left']: '50%' }} title={chf(v)} />
            ))}
          </div>
          <span className="tornado-val">±{chfk(d.range / 2)}</span>
        </div>
      ))}
      {breakEven && (
        <div className="breakeven">
          ⚖ <b>Break-even:</b> {name} ends level with {baselineName} if income from age {Math.floor(age + breakEven.month / 12)} is{' '}
          <b>
            {breakEven.pct >= 0 ? '+' : ''}
            {breakEven.pct.toFixed(0)}%
          </b>{' '}
          vs assumed (≈ {chf(breakEven.incomeNeeded)}/mo).
        </div>
      )}
    </div>
  )
}

export type ExplainState = { status: 'idle' | 'loading' | 'ai' | 'cached' | 'offline'; data: ExplainResult | null; model?: string; error?: string; verify?: { total: number; unmatched: string[] } }

export function ExplanationPanel({ s, onRetry }: { s: ExplainState; onRetry: () => void }) {
  return (
    <div className="explain">
      {s.status === 'loading' && !s.data && <p className="muted">Writing an explanation…</p>}
      {s.data && (
        <>
          <h3>{s.data.headline}</h3>
          <p className="explain-text">{s.data.explanation}</p>
          <p className="caveat">⚠ {s.data.caveat}</p>
        </>
      )}
      <div className="explain-meta">
        {s.status === 'ai' && <span className="ok">✓ written by {s.model}</span>}
        {s.status === 'cached' && <span className="ok">✓ written by {s.model} (cached)</span>}
        {s.status === 'offline' && <span className="muted">Offline summary (template, no LLM){s.error ? ` — ${s.error}` : ''}</span>}
        {s.status === 'loading' && s.data && <span className="muted">updating…</span>}
        {s.verify && (s.status === 'ai' || s.status === 'cached') && (
          <span className={s.verify.unmatched.length ? 'neg' : 'ok'}>
            {s.verify.unmatched.length ? `⚠ ${s.verify.unmatched.length} number(s) not found in engine output: ${s.verify.unmatched.join(', ')}` : `✓ all ${s.verify.total} numbers traced to the engine`}
          </span>
        )}
        <button className="link" onClick={onRetry}>
          regenerate
        </button>
      </div>
    </div>
  )
}

export function TrustPanel({ params, checks, focusName }: { params: Params; checks: Check[]; focusName: string }) {
  const bt = params.backtest
  const reg = params.regressions
  const dc = params.data_checks
  const bonus = Object.entries(params.bonus)
  return (
    <div className="trust">
      <div>
        <h4>Live accounting checks · {focusName}</h4>
        {checks.map((c) => (
          <div key={c.name} className="check">
            <span className={c.ok ? 'ok' : 'neg'}>{c.ok ? '✓' : '✗'}</span> <b>{c.name}</b> <span className="muted">— {c.detail}</span>
          </div>
        ))}
      </div>
      <div>
        <h4>Is the uncertainty honest? (backtest)</h4>
        <p className="small">
          Trained on <b>2025 only</b>, then simulated 2026 for all {bt.profiles.toLocaleString()} profiles and compared with the real 2026 ledger:
        </p>
        <div className="check">
          <span className="ok">✓</span> 80% band contained <b>{pct(bt.coverage_80_year_end, 1)}</b> of real year-end cash (target 80%)
        </div>
        <div className="check">
          <span className="ok">✓</span> 50% band contained <b>{pct(bt.coverage_50_year_end, 1)}</b> (target 50%)
        </div>
        <div className="check">
          <span className={bt.median_abs_error_year_end_chf < bt.median_abs_error_naive_chf ? 'ok' : 'neg'}>✓</span> typical error {chf(bt.median_abs_error_year_end_chf)} vs {chf(bt.median_abs_error_naive_chf)} for a naive average
        </div>
        <div className="check">
          <span className="ok">✓</span> cash-crunch prediction (Brier) {bt.brier_negative_cash_model.toFixed(4)} vs naive {bt.brier_negative_cash_naive.toFixed(4)} (lower is better)
        </div>
      </div>
      <div>
        <h4>What the model learned from {params.source.profile_months.toLocaleString()} profile-months</h4>
        <ul className="small">
          {bonus.map(([s, b]) => (
            <li key={s}>
              December bonus for <b>{s}</b>: {pct(b!.probability)} of years, median {pct(b!.size_quantiles[10])} of monthly income.
            </li>
          ))}
          <li>
            Spending spikes in Feb & Aug (e.g. students +{pct(params.season.student[1])} in Feb); only effects with |t| &gt; 3 kept.
          </li>
          <li>Monthly surprises are independent (lag-1 autocorrelation {params.shock_autocorr_lag1.toFixed(2)}) and skewed toward big expenses → sampled from the real distribution, not a bell curve.</li>
          <li>
            Spending <b>level</b> barely depends on income here (CV R² {reg.other_spending.selected_cv_r2.toFixed(2)}) → the twin uses <b>your own history</b> and only adds the learned change. Spending <b>volatility</b> is well explained (CV R² {reg.spending_volatility.selected_cv_r2.toFixed(2)}).
          </li>
        </ul>
      </div>
      <div>
        <h4>Data & limits</h4>
        <ul className="small">
          <li>
            Source ledger: {dc.rows.toLocaleString()} rows, {dc.identity_violations} identity violations, {dc.continuity_violations} continuity breaks ({params.source.period}).
          </li>
          <li>All people and numbers are synthetic. Not Swiss statistics, not a forecast, not advice.</li>
          <li>Synthetic incomes do not vary with age, and the data has no education or city-income effect → degree premium and abroad numbers are marked UNKNOWN.</li>
          <li>Values in constant 2025 CHF (no inflation). Net income → taxes are already inside it. Investment return is 0% unless you set it.</li>
          <li>The shaded band shows month-to-month variability, not uncertainty about your assumptions → that is what the "drivers" panel is for.</li>
        </ul>
        <div className="legend">
          {(Object.keys(SOURCE_INFO) as (keyof typeof SOURCE_INFO)[]).map((s) => (
            <span key={s}>
              <SourceTag s={s} /> {SOURCE_INFO[s].title}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
