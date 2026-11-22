// The models estimated in R, as the app uses them: monthly spending (R/eda.R) and the economy forecast (R/macro.R).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BASE_MACRO, MACRO_PRESETS, type Macro } from '../lib/macro'
import { makeEvent, medianLoanRate, resolve } from '../lib/resolve'
import { invNorm, mulberry32 } from '../lib/rng'
import { checks, NO_KNOBS, runPath, simulate, type LedgerRow } from '../lib/sim'
import type { Params, Profile, ScenarioSpec } from '../lib/types'
import { loadModel } from './load'

const { params, profiles } = loadModel()
const S = params.spending
const M = params.macro_model
const rate = medianLoanRate(profiles)
const FORECAST = MACRO_PRESETS.find((m) => m.id === 'forecast')!
const quo: ScenarioSpec = { name: 'Status quo', catalog_id: null, events: [] }
const spec = (...events: Parameters<typeof makeEvent>[0][]): ScenarioSpec => ({ name: 'x', catalog_id: null, events: events.map(makeEvent) })
const plan = (p: Profile, s: ScenarioSpec = quo, H = 120, macro: Macro = BASE_MACRO, prm: Params = params) => resolve(p, prm, s, {}, H, rate, macro)
const noDebt = (p: Profile): Profile => ({ ...p, loans: [] })
const alexia = profiles.find((p) => p.id === 'P00001')! // student, Lausanne
const worker = profiles.find((p) => p.status === 'employed' && p.age >= 26 && p.age <= 40 && p.household !== 'family' && p.income > 3797 && p.income < 12000)!
const retired = profiles.find((p) => p.status === 'retired')!
const selfEmp = profiles.find((p) => p.status === 'self_employed')!
const ledger = (pl: ReturnType<typeof plan>, seed: number, prm: Params = params) => {
  const rows: LedgerRow[] = []
  runPath(pl, prm, mulberry32(seed), NO_KNOBS, rows)
  return rows
}

describe('spending model (R/eda.R)', () => {
  it('parity with R: the engine’s average regular-month cash flow equals R’s regular_net_hat for all 1,200 people', () => {
    const lines = readFileSync('../R/output/client_effects.csv', 'utf8').trim().split('\n')
    const head = lines[0].split(',').map((h) => h.replace(/"/g, ''))
    const iId = head.indexOf('profile_id')
    const iNet = head.indexOf('regular_net_hat_chf')
    const rNet = new Map(lines.slice(1).map((l) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((c) => [c[iId].replace(/"/g, ''), Number(c[iNet])]))
    let worst = 0
    for (const p of profiles) {
      const pl = plan(noDebt(p), quo, 12)
      const cash = runPath(pl, params, null).cash
      const flows = Array.from(cash, (c, t) => c - (t ? cash[t - 1] : pl.startCash))
      const reg = flows.filter((_, t) => ![1, 7, 11].includes(t) && !(p.status === 'student' && t === 8))
      worst = Math.max(worst, Math.abs(reg.reduce((a, b) => a + b, 0) / reg.length - rNet.get(p.id)!))
    }
    expect(rNet.size).toBe(1200)
    expect(worst).toBeLessThan(0.01)
  })

  it('moving Lausanne -> Zurich changes non-rent spending by exactly the difference of the two city offsets', () => {
    const before = plan(alexia, quo, 36)
    const after = plan(alexia, spec({ type: 'relocate', label: 'Zurich', city: 'Zurich', start_month: 12 }), 36)
    const d = S.city_offset.Zurich - S.city_offset.Lausanne
    for (let t = 0; t < 36; t++) expect(after.otherMu[t] - before.otherMu[t]).toBeCloseTo(t < 12 ? 0 : d, 6)
    expect(after.assumptions.find((a) => a.key === 'learned.delta')!.value).toBe(Math.round(d))
  })

  it('December bonus for the self-employed: expected value p × mean size × income, and drawn with probability p', () => {
    const pl = plan(noDebt(selfEmp), quo, 12)
    const b = S.bonus.self_employed!
    const rows: LedgerRow[] = []
    runPath(pl, params, null, NO_KNOBS, rows)
    const meanSize = b.size_quantiles.reduce((a, x) => a + x, 0) / b.size_quantiles.length
    expect(rows[11].inflow - pl.income[11]).toBeCloseTo(b.probability * meanSize * pl.income[11], 6)
    expect(rows[10].inflow).toBeCloseTo(pl.income[10], 9) // no bonus outside December
    let hits = 0
    for (let k = 0; k < 2000; k++) if (ledger(pl, 100 + k)[11].inflow > pl.income[11] + 1e-6) hits++
    expect(Math.abs(hits / 2000 - b.probability)).toBeLessThan(0.03)
  })

  it('a study event leaves out the students’ tuition-like February / September peaks (its tuition is explicit)', () => {
    const asIs = plan(alexia, quo, 24)
    const studying = plan(alexia, spec({ type: 'study', label: 'Degree', start_month: 0, duration_months: 24 }), 24)
    for (let t = 0; t < 24; t++) expect(asIs.otherMu[t] - studying.otherMu[t]).toBeCloseTo(S.student_month_excess[t % 12], 6)
    expect(S.student_month_excess[1]).toBeGreaterThan(500) // February
    expect(S.student_month_excess[8]).toBeGreaterThan(500) // September
    expect(S.student_month_excess.filter((x) => x !== 0)).toHaveLength(2)
    expect(studying.assumptions.some((a) => a.key.endsWith('.info') && /Feb \/ Sep/.test(a.label))).toBe(true)
  })

  it('invNorm is the standard normal quantile', () => {
    for (const [u, z] of [[0.5, 0], [0.975, 1.959963985], [0.025, -1.959963985], [0.9, 1.281551566], [0.001, -3.090232306], [1e-9, -5.997807015]]) expect(invNorm(u)).toBeCloseTo(z, 6)
    expect(Number.isFinite(invNorm(0)) && Number.isFinite(invNorm(1))).toBe(true)
  })
})

describe('economy forecast (R/macro.R) in the Monte Carlo', () => {
  it('the VAR is stationary and starts from the observed 2025 values', () => {
    const [[a, b], [c, d]] = M.A
    const tr = a + d
    const det = a * d - b * c
    const disc = tr * tr - 4 * det
    const mod = disc >= 0 ? Math.max(Math.abs((tr + Math.sqrt(disc)) / 2), Math.abs((tr - Math.sqrt(disc)) / 2)) : Math.sqrt(det)
    expect(mod).toBeLessThan(1)
    expect(M.start.year).toBe(2025)
    expect(M.start.unemployment_pct).toBeGreaterThan(0)
  })

  it('today’s economy is untouched by the forecast code (same results even if the macro model were broken)', () => {
    const broken: Params = { ...params, macro_model: { ...M, c: [NaN, NaN] } }
    const pl = plan(worker)
    expect(pl.macro).toBeNull()
    const a = simulate(pl, params, worker, 200)
    const b = simulate(plan(worker, quo, 120, BASE_MACRO, broken), broken, worker, 200)
    expect(b.nw).toEqual(a.nw)
    expect(b.endNWPaths).toEqual(a.endNWPaths)
  })

  it('two paths in the same situation share each future’s economy: same job losses, month by month', () => {
    const a = plan(worker, quo, 120, FORECAST)
    const b = plan(worker, spec({ type: 'one_off', label: 'Car repair', amount_chf: 5000, start_month: 60 }), 120, FORECAST)
    let lost = 0
    for (let k = 0; k < 60; k++) {
      const ra = ledger(a, 1000 + k)
      const rb = ledger(b, 1000 + k)
      expect(rb.map((r) => r.inflow)).toEqual(ra.map((r) => r.inflow))
      if (ra.some((r) => r.inflow < worker.income - 1e-6)) lost++
    }
    expect(lost).toBeGreaterThan(0) // not vacuous: some futures do have a job loss
  })

  it('students, retirees and the self-employed never lose a job (only employees are exposed and insured)', () => {
    for (const p of [alexia, retired, selfEmp]) {
      const pl = plan(noDebt(p), quo, 120, FORECAST)
      for (let k = 0; k < 40; k++) for (const r of ledger(pl, 2000 + k)) expect(r.inflow).toBeGreaterThanOrEqual(pl.income[r.t] - 1e-6)
    }
  })

  it('unemployment benefit follows Swiss law: 70% (80% with children or low pay), insured pay capped, then the typical income of unemployed people', () => {
    // a deliberately high-unemployment economy so that long spells happen in the test
    const high: Params = { ...params, macro_model: { ...M, labour: { ...M.labour, registered_share: 1000 } } }
    const eco: Macro = { ...FORECAST, forecast: { job_search_months: 30, real_wage_growth_pct: null } }
    const cap = M.labour.insured_salary_cap_year / 12
    const family = profiles.find((p) => p.status === 'employed' && p.household === 'family' && p.age >= 26 && p.age <= 45)!
    const richest = profiles.filter((p) => p.status === 'employed' && p.age >= 26 && p.age <= 45).sort((x, y) => y.income - x.income)[0]
    let longSpells = 0
    for (const p of [worker, family, richest]) {
      const pl = plan(noDebt(p), quo, 60, eco, high)
      const repl = p.household === 'family' || p.income <= M.labour.low_salary_threshold_month ? M.labour.replacement_higher : M.labour.replacement
      const maxMonths = M.labour.max_months_standard // ages 26-45 + 5 years: always the standard 18 months
      const benefit = repl * Math.min(p.income, cap)
      let jobless = 0
      for (let k = 0; k < 150; k++) {
        let spell = -1
        for (const r of ledger(pl, 3000 + k, high)) {
          const unemployed = r.inflow < p.income - 1e-6
          spell = unemployed ? spell + 1 : -1
          if (!unemployed) continue
          jobless++
          const expected = spell < maxMonths ? benefit : Math.min(benefit, pl.macro!.afterIncome[r.t])
          expect(r.inflow).toBeCloseTo(expected, 6)
          if (spell === maxMonths) longSpells++
        }
      }
      expect(jobless).toBeGreaterThan(0)
    }
    expect(longSpells).toBeGreaterThan(0) // the "benefits run out" branch was exercised
  })

  it('the expected-value line matches the Monte Carlo average', () => {
    const pl = plan(noDebt(worker), quo, 120, FORECAST)
    const r = simulate(pl, params, worker, 4000)
    const mean = r.endNWPaths.reduce((a, x) => a + x, 0) / r.endNWPaths.length
    const sd = Math.sqrt(r.endNWPaths.reduce((a, x) => a + (x - mean) ** 2, 0) / r.endNWPaths.length)
    const det = r.meanPath.nw.at(-1)!
    // within 4 standard errors + 0.5% of the total income over 10 years (non-linear bits: log unemployment, end of benefits)
    expect(Math.abs(mean - det)).toBeLessThan((4 * sd) / Math.sqrt(4000) + 0.005 * worker.income * 120)
  })

  it('the accounting still adds up in the forecast economy (prices scale costs, job loss changes income)', () => {
    const withLoans = profiles.find((p) => p.loans.length > 0 && p.status === 'employed')!
    for (const p of [alexia, worker, withLoans]) {
      for (const s of [quo, spec({ type: 'recurring_expense', label: 'Gym', monthly_amount_chf: 80, start_month: 6 }), spec({ type: 'one_off', label: 'Car', amount_chf: 9000, start_month: 30 })]) {
        for (const c of checks(plan(p, s, 120, FORECAST), params, p)) expect(c.ok, `${p.id} ${c.name}: ${c.detail}`).toBe(true)
      }
    }
  })

  it('the forecast economy widens the range for an employee (job loss and inflation risk), and shows its assumptions', () => {
    const base = simulate(plan(worker), params, worker, 500)
    const fc = simulate(plan(worker, quo, 120, FORECAST), params, worker, 500)
    expect(fc.endNW.p90 - fc.endNW.p10).toBeGreaterThan(base.endNW.p90 - base.endNW.p10)
    const keys = plan(worker, quo, 120, FORECAST).assumptions.map((a) => a.key)
    for (const k of ['m.fc.info', 'm.dur', 'm.wage', 'm.ui.info']) expect(keys).toContain(k)
  })
})
