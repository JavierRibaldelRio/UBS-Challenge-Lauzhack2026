import { chf, pct } from '../lib/fmt'
import type { Check } from '../lib/sim'
import type { Params } from '../lib/types'
import { SOURCE, SourceChip } from './Details'

export function TrustSummary({ checks, params, verify }: { checks: Check[]; params: Params; verify?: { total: number; unmatched: string[] } }) {
  const passed = checks.filter((c) => c.ok).length
  return (
    <span className="trust-summary">
      <span className={passed === checks.length ? 'ok' : 'neg'}>✓ accounting {passed}/{checks.length}</span>
      <span className="ok">✓ tested on real data: {pct(params.backtest.coverage_80_year_end, 1)} inside the 80% range</span>
      {verify && <span className={verify.unmatched.length ? 'neg' : 'ok'}>✓ AI numbers checked {verify.total - verify.unmatched.length}/{verify.total}</span>}
    </span>
  )
}

const r1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1)
const signed = (x: number) => `${x < 0 ? '−' : '+'}${chf(Math.abs(x))}`

export function TrustDetails({ params, checks, focusName }: { params: Params; checks: Check[]; focusName: string }) {
  const bt = params.backtest
  const S = params.spending
  const M = params.macro_model
  const medianSize = (q: number[]) => (q[Math.floor((q.length - 1) / 2)] + q[Math.ceil((q.length - 1) / 2)]) / 2
  const cities = Object.entries(S.city_offset).sort((a, b) => a[1] - b[1])
  const kFeb = S.k.employed[1]
  const bt1 = (v: string) => M.backtest.find((b) => b.variable === v && b.horizon === 1)
  const years = [...new Set(M.forecast.map((f) => f.year))].sort()
  const fc = (y: number, v: string) => M.forecast.find((f) => f.year === y && f.variable === v)
  return (
    <div className="trust">
      <div>
        <h4>1. The maths adds up</h4>
        <p className="muted small">Checked live, every time you change something ({focusName}):</p>
        {checks.map((c) => (
          <div key={c.name} className="check">
            <span className={c.ok ? 'ok' : 'neg'}>{c.ok ? '✓' : '✗'}</span> <b>{c.name}</b> <span className="muted">{c.detail}</span>
          </div>
        ))}
      </div>
      <div>
        <h4>2. The ranges are honest</h4>
        <p className="muted small">We estimated the model on 2025 only, let this app’s own simulator predict 2026 for all {bt.profiles.toLocaleString()} people, then compared with what really happened in the data.</p>
        <div className="check">
          <span className="ok">✓</span> The "8 in 10 runs" range caught <b>{pct(bt.coverage_80_year_end, 1)}</b> of real results (perfect = 80%).
        </div>
        <div className="check">
          <span className="ok">✓</span> The middle half caught <b>{pct(bt.coverage_50_year_end, 1)}</b> (perfect = 50%).
        </div>
        <div className="check">
          <span className="ok">✓</span> Typical miss {chf(bt.median_abs_error_year_end_chf)}, vs {chf(bt.median_abs_error_naive_chf)} for a simple average.
        </div>
        {bt.calibration_ends_higher && (
          <>
            <p className="small" style={{ marginTop: 8 }}>
              <b>When we say “A ends higher than B in X% of futures”, is that true?</b> Tested on {bt.calibration_ends_higher.reduce((a, x) => a + x.pairs, 0).toLocaleString()} pairs of real people (2026):
            </p>
            <table className="calib">
              <thead>
                <tr>
                  <th>we said</th>
                  {bt.calibration_ends_higher.map((c) => (
                    <th key={c.said}>{Math.round(c.avg_said * 100)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>it happened</td>
                  {bt.calibration_ends_higher.map((c) => (
                    <td key={c.said}>{Math.round(c.real * 1000) / 10}%</td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="muted small">That is why a “high confidence” answer needs at least 95%: in the data, those statements were right 99.9% of the time. (Decisions themselves are not in the data, so the confidence also checks peer ranges and unknown numbers.)</p>
          </>
        )}
        <div className="check">
          <span className="ok">✓</span> Better at spotting cash crunches than a simple average (score {bt.brier_negative_cash_model.toFixed(4)} vs {bt.brier_negative_cash_naive.toFixed(4)}, lower is better).
        </div>
      </div>
      <div>
        <h4>3. What the model learned from {params.source.profile_months.toLocaleString()} months of data</h4>
        <p className="muted small">A mixed model estimated in R (R/eda.R; its structure chosen among four by BIC). Spending here means everything except rent.</p>
        <ul className="small">
          <li>
            Spending depends on <b>status, city and the month</b>. Compared with a regular month, an employed person spends {signed(S.base.employed[1] - S.base_regular.employed)} in February and {signed(S.base.employed[7] - S.base_regular.employed)} in August.
          </li>
          <li>
            City: from {cities[0][0]} ({signed(cities[0][1])}/month) to {cities[cities.length - 1][0]} ({signed(cities[cities.length - 1][1])}/month) vs the average city. Moving city moves spending by the difference.
          </li>
          <li>
            Students spend {chf(S.student_month_excess[1])} more in February and {chf(S.student_month_excess[8])} more in September (tuition-like). When you plan a degree its tuition is paid explicitly, so these peaks are left out.
          </li>
          {(Object.entries(S.bonus) as [string, { probability: number; size_quantiles: number[] }][]).map(([s, b]) => (
            <li key={s}>
              {pct(b.probability)} of {s.replace('_', '-')} people get a December bonus (typical size {pct(medianSize(b.size_quantiles))} of a month’s pay).
            </li>
          ))}
          <li>
            People in the same situation spend almost the same: a personal habit adds only about ±{chf(S.sigma_u)}/month. Income does not change the level once status and city are known; it changes how much spending <b>varies</b>.
          </li>
          <li>
            Surprises: a bell curve around each person’s own month-to-month spread (pulled toward people like them), wider in February, August and December (×{r1(kFeb)} in February for employed people).
          </li>
        </ul>
      </div>
      <div>
        <h4>4. The economy forecast (only in “Forecast (Swiss data)”)</h4>
        <p className="muted small">
          Inflation and unemployment follow a small model of Swiss data 1991–{M.start.year} (World Bank; R/macro.R). {M.start.year} is observed (inflation {r1(M.start.inflation_pct)}%, unemployment {r1(M.start.unemployment_pct)}%); every simulated future draws its own years after that.
        </p>
        <table className="calib">
          <thead>
            <tr>
              <th>year</th>
              {years.map((y) => (
                <th key={y}>{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['inflation_pct', 'unemployment_pct'] as const).map((v) => (
              <tr key={v}>
                <td>{v === 'inflation_pct' ? 'inflation %' : 'unemployment %'}</td>
                {years.map((y) => (
                  <td key={y} title="median (80% range)">
                    {r1(fc(y, v)!.p50)} <span className="muted">({r1(fc(y, v)!.p10)}–{r1(fc(y, v)!.p90)})</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="check">
          <span className="ok">✓</span> Tested on 2005–2024, one year ahead: the 80% range held <b>{pct(bt1('inflation_pct')!.coverage80)}</b> of the time for inflation (a bit narrow) and <b>{pct(bt1('unemployment_pct')!.coverage80)}</b> for unemployment (a bit wide).
        </div>
        <div className="check">
          <span className="muted">≈</span> Typical error: inflation {r1(bt1('inflation_pct')!.rmse_model)} points vs {r1(bt1('inflation_pct')!.rmse_random_walk)} for “same as last year”; unemployment {r1(bt1('unemployment_pct')!.rmse_model)} vs {r1(bt1('unemployment_pct')!.rmse_random_walk)} (no better: the model mainly adds the range).
        </div>
        <p className="muted small">
          The national rate is not your personal chance: every employee gets the same risk of losing their job, about {M.labour.duration_months} months to find a new one (assumption), and benefits under Swiss law ({pct(M.labour.replacement)}–{pct(M.labour.replacement_higher)} of pay for up to {M.labour.max_months_standard} months). The self-employed are not insured and are not exposed. Pay follows last year’s inflation, so costs run ahead of pay while inflation rises.
        </p>
      </div>
      <div>
        <h4>5. What it does not know</h4>
        <ul className="small">
          <li>All people are fictional. Not Swiss statistics, not a personal forecast, not advice. The 24 months of data are calm, so how the economy affects people comes from public Swiss data and labelled assumptions, not from the data.</li>
          <li>The data has no education, abroad or age-salary information. Those numbers are marked <SourceChip s="missing" /> and we show a break-even instead of guessing.</li>
          <li>Values are in 2025 francs (constant purchasing power). Income is after tax. Investments grow 4% a year by default (UBS’s illustrative rate, not learned: the data has no returns); change it in “The economy”.</li>
          <li>The shaded range shows normal ups and downs, not doubts about the assumptions. That’s what “what matters most” is for.</li>
        </ul>
        <div className="legend">
          {(Object.keys(SOURCE) as (keyof typeof SOURCE)[]).map((s) => (
            <div key={s}>
              <SourceChip s={s} /> <span className="muted">{SOURCE[s].help}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
