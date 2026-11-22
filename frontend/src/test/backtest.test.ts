// Backtest of the simulator: parameters estimated on 2025 only (R: model_parameters_fit2025.csv), then 2026 simulated
// with the app's own engine (resolve + runPath, today's economy) from each person's real December-2025 cash, and
// compared with the real 2026 ledger (src/test/backtest.ts).
//
//   pnpm backtest   -> recomputes and writes src/model/backtest.json (shown in "How the model & simulations work")
//   pnpm test       -> recomputes and checks it still matches the file (so the numbers shown are the code's numbers)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runBacktest } from './backtest'
import { loadModel } from './load'

const FILE = 'src/model/backtest.json'

describe('backtest: 2025-only parameters, 2026 simulated by the app engine vs the real ledger', () => {
  it('matches src/model/backtest.json and is well calibrated', { timeout: 600_000 }, () => {
    const { params, profiles } = loadModel('spending_fit2025.json')
    const bt = runBacktest(params, profiles)
    if (process.env.UPDATE_BACKTEST) writeFileSync(FILE, JSON.stringify(bt, null, 1) + '\n')
    console.log(`backtest: 80% range ${bt.coverage_80_year_end}, 50% range ${bt.coverage_50_year_end}, monthly 80% ${bt.coverage_80_all_months}, median error ${bt.median_abs_error_year_end_chf} vs naive ${bt.median_abs_error_naive_chf}, Brier ${bt.brier_negative_cash_model} vs ${bt.brier_negative_cash_naive}`)
    expect(existsSync(FILE), 'run `pnpm backtest` once to create backtest.json').toBe(true)
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(bt)
    expect(bt.coverage_80_year_end).toBeGreaterThanOrEqual(0.72)
    expect(bt.coverage_80_year_end).toBeLessThanOrEqual(0.88)
    expect(bt.median_abs_error_year_end_chf).toBeLessThan(bt.median_abs_error_naive_chf)
    expect(bt.brier_negative_cash_model).toBeLessThan(bt.brier_negative_cash_naive)
  })
})
