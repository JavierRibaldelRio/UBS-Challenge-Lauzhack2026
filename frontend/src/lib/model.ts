// Puts the model artifacts together, in one place (the app and the tests load the model the same way):
//   params.json + profiles.json   ml/train.py: data checks, defaults from the data, catalog, the 1,200 people
//   spending.json + macro.json    scripts/import-r-model.ts: the models estimated in R (R/eda.R, R/macro.R)
//   backtest.json                 src/test/backtest.test.ts: the simulator tested on 2026 (pnpm backtest)
import type { Backtest, MacroModel, Params, Profile, SpendingFile } from './types'

export type BaseParams = Omit<Params, 'spending' | 'macro_model' | 'backtest'>
export type BaseProfile = Omit<Profile, 'calib'>

export function buildModel(params: BaseParams, profiles: BaseProfile[], spending: SpendingFile, macro: MacroModel, backtest: Backtest): { params: Params; profiles: Profile[] } {
  return {
    params: { ...params, spending: spending.model, macro_model: macro, backtest },
    profiles: profiles.map((p) => {
      const calib = spending.clients[p.id]
      if (!calib) throw new Error(`no spending calibration for ${p.id}: run \`pnpm model:import\``)
      return { ...p, calib: { ...calib } }
    }),
  }
}
