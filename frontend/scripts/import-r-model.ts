// Reads the models estimated in R and writes them as JSON the app bundles. Nothing is re-estimated here:
// the numbers are copied from R's CSVs, reshaped, and checked.
//
//   R/output/model_parameters.csv + client_effects.csv              -> src/model/spending.json          (the app)
//   R/output/model_parameters_fit2025.csv + client_effects_fit2025   -> src/model/spending_fit2025.json  (backtest only)
//   R/output/macro_parameters.csv + macro_backtest + macro_forecast  -> src/model/macro.json             (the app)
//
// Run: pnpm model:import   (after `Rscript R/eda.R` and `Rscript R/macro.R`)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const R_OUT = join(import.meta.dirname, '..', '..', 'R', 'output')
const MODEL = join(import.meta.dirname, '..', 'src', 'model')
const STATUSES = ['employed', 'self_employed', 'part_time', 'student', 'unemployed', 'retired'] as const
type Status = (typeof STATUSES)[number]
type Row = Record<string, string | null>

function fail(msg: string): never {
  console.error(`import-r-model: ${msg}`)
  process.exit(1)
}

/** RFC-4180 CSV (quoted fields may contain commas); "NA" and empty -> null. */
function readCsv(file: string): Row[] {
  const text = readFileSync(join(R_OUT, file), 'utf8')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else field += ch
  }
  if (field !== '' || row.length) endRow()
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '')
  return body.map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] === 'NA' || r[j] === '' || r[j] == null ? null : r[j]])))
}

const num = (v: string | null | undefined, what: string) => {
  const x = Number(v)
  if (v == null || !Number.isFinite(x)) fail(`missing or non-numeric value for ${what}`)
  return x
}

// ------------------------------------------------------------------ spending model
function spending(paramsFile: string, effectsFile: string, months: number) {
  const p = readCsv(paramsFile)
  const pick = (block: string, parameter: string) => p.filter((r) => r.block === block && r.parameter === parameter)
  const source = `R/eda.R -> R/output/${paramsFile} (${pick('mean', 'base_nonrent_outflow')[0]?.source ?? ''})`

  const base = Object.fromEntries(STATUSES.map((s) => [s, Array<number>(12).fill(NaN)])) as Record<Status, number[]>
  for (const r of pick('mean', 'base_nonrent_outflow')) base[r.employment_status as Status][num(r.month, 'month') - 1] = num(r.value, 'base')
  for (const s of STATUSES) if (base[s].some((x) => !Number.isFinite(x))) fail(`${paramsFile}: base_nonrent_outflow incomplete for ${s}`)

  // R's definition of a "regular" month (eda.R 5.4): not Feb / Aug / Dec, and not Sep for students (tuition-like)
  const regular = (s: Status, m: number) => ![2, 8, 12].includes(m) && !(s === 'student' && m === 9)
  const base_regular = Object.fromEntries(
    STATUSES.map((s) => {
      const xs = base[s].filter((_, i) => regular(s, i + 1))
      return [s, xs.reduce((a, b) => a + b, 0) / xs.length]
    }),
  ) as Record<Status, number>

  const city_offset = Object.fromEntries(pick('mean', 'city_offset').map((r) => [r.key!, num(r.value, 'city offset')]))
  if (Object.keys(city_offset).length !== 12) fail(`${paramsFile}: expected 12 city offsets`)

  // tuition-like peaks: the student-specific Feb / Sep effect above the student's regular months.
  // Removed inside a study event (the event adds its own tuition, so it would be counted twice).
  const eff = Array<number>(12).fill(NaN)
  for (const r of pick('mean', 'student_month_effect')) eff[num(r.month, 'month') - 1] = num(r.value, 'student effect')
  if (eff.some((x) => !Number.isFinite(x))) fail(`${paramsFile}: student_month_effect incomplete`)
  const regEff = eff.filter((_, i) => regular('student', i + 1))
  const regMean = regEff.reduce((a, b) => a + b, 0) / regEff.length
  const student_month_excess = eff.map((x, i) => (i === 1 || i === 8 ? x - regMean : 0))

  const k = Object.fromEntries(STATUSES.map((s) => [s, Array<number>(12).fill(1)])) as Record<Status, number[]>
  const MT: Record<string, number> = { Feb: 1, Aug: 7, Dec: 11 }
  for (const r of pick('shocks', 'k_multiplier_vs_regular')) k[r.employment_status as Status][MT[r.key!]] = num(r.value, 'k')

  const ls = Object.fromEntries(pick('shocks', 'log_sigma_i_coef').map((r) => [r.key!, num(r.value, 'log sigma')]))
  const log_sigma = {
    intercept: num(String(ls['(Intercept)']), 'log sigma intercept'),
    log_income: num(String(ls['log(income)']), 'log sigma slope'),
    status: Object.fromEntries(STATUSES.map((s) => [s, ls[`employment_status${s}`] ?? 0])),
  }

  // December bonus: only the groups with an estimated bonus-size distribution (employed, self-employed);
  // for the others the rare bonus-like inflows are already inside their base level (eda.R / ENGINE.md)
  const bonus: Partial<Record<Status, { probability: number; size_quantiles: number[] }>> = {}
  for (const s of STATUSES) {
    const q = pick('bonus', 'bonus_size_quantile')
      .filter((r) => r.employment_status === s)
      .map((r) => ({ q: Number(r.key!.slice(1)), v: num(r.value, 'bonus size') }))
      .sort((a, b) => a.q - b.q)
    if (!q.length) continue
    const pr = pick('bonus', 'p_bonus').find((r) => r.employment_status === s)
    bonus[s] = { probability: num(pr?.value, `p_bonus ${s}`), size_quantiles: q.map((x) => x.v) }
  }
  if (!bonus.employed || !bonus.self_employed) fail(`${paramsFile}: bonus for employed / self_employed missing`)
  const sigma_u = num(pick('random_effects', 'sigma_u')[0]?.value, 'sigma_u')

  const e = readCsv(effectsFile)
  if (e.length !== 1200) fail(`${effectsFile}: expected 1200 clients, got ${e.length}`)
  let worst = 0
  const clients = Object.fromEntries(
    e.map((r) => {
      const st = r.employment_status as Status
      const mu = num(r.regular_outflow_hat_chf, `${r.profile_id} regular_outflow_hat_chf`)
      const u = num(r.u_outflow_chf, `${r.profile_id} u_outflow_chf`)
      // the engine rebuilds the regular level from base + city + u: it must equal R's own number
      worst = Math.max(worst, Math.abs(base_regular[st] + city_offset[r.city!] + u - mu))
      // sigma for simulation: the shrunk sigma_i with the small-sample bias of a log SD undone (eda.R, sigma_reg_sim)
      return [r.profile_id!, { model_mu: mu, other_mu: mu, other_sd: num(r.sigma_reg_sim_chf, `${r.profile_id} sigma_reg_sim_chf`), u, u_sd: num(r.u_postsd_chf, 'u_postsd'), months }]
    }),
  )
  if (worst > 0.05) fail(`${effectsFile}: base_regular + city + u differs from R's regular_outflow_hat by ${worst.toFixed(4)} CHF`)
  console.log(`  ${paramsFile}: base 6x12, ${Object.keys(city_offset).length} cities, bonus for ${Object.keys(bonus).join(' + ')}; ${e.length} clients (rebuild check: max |diff| ${worst.toFixed(4)} CHF)`)
  return { model: { source, base, base_regular, city_offset, student_month_excess, k, log_sigma, bonus, sigma_u }, clients }
}

// ------------------------------------------------------------------ macro model
function macro() {
  const p = readCsv('macro_parameters.csv')
  const get = (block: string, parameter: string, key: string | null) => {
    const r = p.find((x) => x.block === block && x.parameter === parameter && x.key === key)
    return { value: num(r?.value, `${block}/${parameter}/${key}`), source: r?.source ?? '' }
  }
  const V = ['inflation', 'log_unemployment']
  const c: [number, number] = [get('var', 'intercept', V[0]).value, get('var', 'intercept', V[1]).value]
  const A = V.map((i) => V.map((j) => get('var', 'A', `${i}|${j}`).value)) as [[number, number], [number, number]]
  const s11 = get('var', 'sigma', `${V[0]}|${V[0]}`).value
  const s12 = get('var', 'sigma', `${V[0]}|${V[1]}`).value
  const s22 = get('var', 'sigma', `${V[1]}|${V[1]}`).value
  const l11 = Math.sqrt(s11)
  const l21 = s12 / l11
  const chol: [[number, number], [number, number]] = [[l11, 0], [l21, Math.sqrt(s22 - l21 * l21)]]
  const labourRows = p.filter((r) => r.block === 'labour_assumption')
  const labour = Object.fromEntries(labourRows.map((r) => [r.parameter!, num(r.value, r.parameter!)]))
  for (const k of ['duration_months', 'registered_share', 'replacement', 'replacement_higher', 'low_salary_threshold_month', 'insured_salary_cap_year', 'max_months_standard', 'max_months_young', 'max_months_55plus', 'real_wage_growth'])
    if (!(k in labour)) fail(`macro_parameters.csv: labour_assumption ${k} missing`)
  const backtest = readCsv('macro_backtest.csv').map((r) => ({
    variable: r.variable!, horizon: num(r.horizon, 'h'), n: num(r.n, 'n'), coverage80: num(r.coverage80, 'c80'), coverage50: num(r.coverage50, 'c50'),
    rmse_model: num(r.rmse_model, 'rmse'), rmse_random_walk: num(r.rmse_random_walk, 'rmse rw'), rmse_hist_mean: num(r.rmse_hist_mean, 'rmse mean'),
  }))
  const forecast = readCsv('macro_forecast.csv').map((r) => ({ year: num(r.year, 'year'), variable: r.variable!, p10: num(r.p10, 'p10'), p50: num(r.p50, 'p50'), p90: num(r.p90, 'p90') }))
  const start = get('start', 'last_observation', 'year')
  console.log(`  macro_parameters.csv: VAR(1) on (inflation, log unemployment), last observation ${start.value}; ${backtest.length} backtest rows, ${forecast.length} forecast rows`)
  return {
    source: `${get('var', 'intercept', V[0]).source}; data: ${start.source}`,
    c, A, chol,
    start: { year: start.value, inflation_pct: get('start', 'last_observation', 'inflation_pct').value, unemployment_pct: get('start', 'last_observation', 'unemployment_pct').value },
    long_run: { inflation_pct: get('var', 'long_run_mean', 'inflation_pct').value, unemployment_pct: get('var', 'long_run_mean', 'unemployment_pct').value },
    labour,
    labour_sources: Object.fromEntries(labourRows.map((r) => [r.parameter!, r.source ?? ''])),
    backtest,
    forecast,
  }
}

// compact (the app bundles these files); 6 decimals is far below a rappen
const write = (file: string, data: unknown) =>
  writeFileSync(join(MODEL, file), JSON.stringify(data, (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)) + '\n')
console.log('import-r-model:')
write('spending.json', spending('model_parameters.csv', 'client_effects.csv', 24))
write('spending_fit2025.json', spending('model_parameters_fit2025.csv', 'client_effects_fit2025.csv', 12))
write('macro.json', macro())
console.log('  wrote src/model/spending.json, spending_fit2025.json, macro.json')
