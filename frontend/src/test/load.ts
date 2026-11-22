// The model as the app loads it (lib/model.ts), read from disk for the tests (run from frontend/).
import { existsSync, readFileSync } from 'node:fs'
import { buildModel } from '../lib/model'
import type { Backtest, SpendingFile } from '../lib/types'

const read = (f: string) => JSON.parse(readFileSync(`src/model/${f}`, 'utf8'))

/** backtest.json is produced by `pnpm backtest`; until then (first run) a placeholder keeps the loader working */
const PLACEHOLDER: Backtest = {
  method: 'not run yet', profiles: 0, paths_per_profile: 0, coverage_80_year_end: 0, coverage_50_year_end: 0, coverage_80_all_months: 0,
  median_abs_error_year_end_chf: 0, median_abs_error_naive_chf: 0, brier_negative_cash_model: 0, brier_negative_cash_naive: 0, naive_definition: '',
}

export function loadModel(spendingFile = 'spending.json') {
  const backtest: Backtest = existsSync('src/model/backtest.json') ? read('backtest.json') : PLACEHOLDER
  return buildModel(read('params.json'), read('profiles.json'), read(spendingFile) as SpendingFile, read('macro.json'), backtest)
}
