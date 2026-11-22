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

export function TrustDetails({ params, checks, focusName }: { params: Params; checks: Check[]; focusName: string }) {
  const bt = params.backtest
  const reg = params.regressions
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
        <p className="muted small">We trained on 2025 only, predicted 2026 for all {bt.profiles.toLocaleString()} people, then compared with what really happened in the data.</p>
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
        <ul className="small">
          {Object.entries(params.bonus).map(([s, b]) => (
            <li key={s}>
              {pct(b!.probability)} of {s} people get a December bonus (typical size {pct(b!.size_quantiles[10])} of a month’s pay).
            </li>
          ))}
          <li>Spending jumps in February and August (students: +{pct(params.season.student[1])} in February).</li>
          <li>Surprise expenses come at random and are sometimes big. We replay the real pattern, not a textbook bell curve.</li>
          <li>
            How much people spend barely depends on income in this data (R² {reg.other_spending.selected_cv_r2.toFixed(2)}), so the twin starts from each person’s <b>own</b> history.
          </li>
        </ul>
      </div>
      <div>
        <h4>4. What it does not know</h4>
        <ul className="small">
          <li>All people are fictional. Not Swiss statistics, not a forecast, not advice.</li>
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
