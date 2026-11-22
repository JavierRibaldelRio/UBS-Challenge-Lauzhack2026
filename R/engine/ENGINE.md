# Deterministic financial state-transition engine (Step 2)

`X(t+1) = F(X(t), A(t), Z(t); θ)`, one month per step, written in base R.

| Task | Command |
|---|---|
| Run tests and examples | `Rscript R/engine/test_engine.R` (≈45 s, 50 tests, writes only to `R/engine/output/`) |
| Use in code | `source("R/engine/engine.R")`, then `simulate_client(id, months, theta, clients, decision, macro)` |

The engine reads the EDA outputs (`R/output/model_parameters.csv`, `client_effects.csv`, `client_static.csv`) and never writes to them.

| File | Role |
|---|---|
| `params.R` | `load_theta()`: θ from `model_parameters.csv`; `default_assumptions()` |
| `state.R` | `load_clients()`, `initial_state()`: X(0), one source per stock |
| `transition.R` | `transition(state, decision, macro, params)`, `default_macro()`, `default_decision()` |
| `simulate.R` | `simulate_client()`, `simulate_state()`, `yearly_summary()` |
| `validate.R` | `validate_simulation()`: 12 accounting checks per path |
| `test_engine.R` | Tests, backtest and examples |

## 1. Equations implemented

**State** X(t):
- Stocks: cash Cₜ, investments Iₜ, debt Dₜ.
- Flow levels: income Yₜ, rent Rₜ, living-cost index Pₜ.
- Loan: remaining loan term nₜ (NA = unknown).
- Calendar and age: calendar month mₜ, age.
- Static attributes: employment e, city c, client offset uᵢ.

**Decision** A(t): investment contribution Kᴬ (negative = withdraw), principal prepayment Qᴬ, extra spending E. All default to 0.

**Macro** Z(t): annual rates π (inflation), πᴿ (rent inflation, = π if not set), g (wage growth), r^C (cash), r^OD (overdraft), r^I (investment return), Δr (loan-rate shift).
- All default to 0.
- Each can be a constant or a monthly path.
- Monthly equivalent: r̃ = (1+r)^(1/12) − 1.

**Parameters** θ, all from the EDA:
- base[e, m] is the non-rent outflow per employment group and calendar month, including the seasonal effects.
- city[c] is the city cost offset.
- pₑ and s̄ₑ are the bonus probability and mean bonus size given a bonus.
- uᵢ is the client's estimated spending offset.

```
Flows in month t (expected values; no random draws)
  Living costs      Lₜ = (base[e, mₜ] + city[c] + uᵢ) · Pₜ          (rent is NOT in L)
  Expected bonus    Bₜ = 1{mₜ = Dec} · pₑ · s̄ₑ · Yₜ                (employed, self-employed only)
  Operating flow    Oₜ = Yₜ + Bₜ − Rₜ − Lₜ − Eₜ
  Cash interest     ι^Cₜ = Cₜ · r̃^C if Cₜ ≥ 0, else Cₜ · r̃^OD
  Investment return ρₜ = Iₜ · r̃^I
  Debt interest     ι^Dₜ = Dₜ · ĩ,   ĩ = monthly(rᵢ + Δr)
  Debt payment      Payₜ = Dₜ ĩ / (1 − (1+ĩ)^(−nₜ))   if the term nₜ is known (annuity)
                         = ι^Dₜ                         if unknown  ← interest-only ASSUMPTION
  Prepayment        Qₜ = min(max(Qᴬ, 0), Dₜ + ι^Dₜ − Payₜ)
  Investing         Kₜ = max(Kᴬ, −(Iₜ + ρₜ))

Stock transitions
  Cₜ₊₁ = Cₜ + Oₜ + ι^Cₜ − Payₜ − Qₜ − Kₜ
  Iₜ₊₁ = Iₜ + ρₜ + Kₜ
  Dₜ₊₁ = Dₜ + ι^Dₜ − Payₜ − Qₜ
  NWₜ  = Cₜ + Iₜ − Dₜ,   so   NWₜ₊₁ − NWₜ = Oₜ + ι^Cₜ + ρₜ − ι^Dₜ   (transfers K, Q and principal net out)

Indexation for the next month
  Yₜ₊₁ = Yₜ(1 + g̃),   Rₜ₊₁ = Rₜ(1 + π̃ᴿ),   Pₜ₊₁ = Pₜ(1 + π̃)
```

**Timing:**
- Interest and returns accrue on opening balances.
- Investment contributions are added at month end.
- The first simulated month is **2025-01**, the only date at which cash, investments and debt are all known together.

**No double counting:**
- Cash comes only from the ledger's month-1 opening, not from the three duplicate copies.
- Investments come only from assets of type investment.
- Rent is a separate flow and is excluded from base[·], which was estimated on outflow net of rent.
- The expected bonus is added only for groups with an estimated bonus term. For the other groups, the rare bonus-like inflows are already inside their base mean.
- Loan payments are kept separate from living costs. The ledger never contained them, so the EDA spending estimates exclude them.

## 2. Validation (`R/engine/output/test_results.csv`, 50/50 pass)

- **Accounting identities on every path:** all 1,200 clients × 120 months (worst error 2.6e-10 CHF). The 12 checks:
  - cash, investment and debt roll-forwards;
  - the operating-flow split;
  - NW = C + I − D;
  - ΔNW = O + interest + return − debt interest;
  - payment = interest + principal;
  - continuity of all three stocks;
  - non-negative investments and debt.
- **Single-source initial state:** the opening stocks equal the raw `profiles` opening cash, the `assets` investments and the `liabilities` principal, for all clients.
- **Transfer neutrality:** investing 1,000 CHF/month leaves the net-worth path unchanged at a 0% return. Prepaying 10,000 CHF raises net worth by exactly the interest saved (+5,094 CHF over 10 years for P00015).
- **Annuity:** with a 60-month term, P00015 pays 1,152.39 CHF/month and reaches 0 debt exactly at month 60. Total paid = principal + interest.
- **Macro inputs:** compounding of wage growth, inflation and returns is exact over 12 months. Rent can follow inflation or be set separately. The overdraft rate applies only to negative balances. Time-varying macro paths work.
- **Consistency with the EDA:** in ledger mode with no loan flows, the simulated regular-month net flow equals `client_effects.regular_net_hat_chf` for all 1,200 clients. The max difference is 0.0009 CHF, from the 6-significant-digit parameter file.
- **Backtest against the observed 2025–26 ledger** (in-sample):
  - Mean 24-month cash error is +39 CHF.
  - The sign of cash at month 24 agrees for 1,199/1,200 clients.
  - The 12-month error (−405 CHF overall, −526 for employed) is half the year-2 step found in the EDA, which the engine deliberately does not extrapolate.

## 3. Example results (year-end, default macro = 0%; `examples_yearly.csv`)

| Client | 2025 NW | 2029 NW | 2034 NW | Note |
|---|---|---|---|---|
| **Alexia** P00001 (student, 1,200 income, 900 rent, 8,000 cash) | −7,459 | −69,295 | −146,591 | Cash negative from **month 7** (ledger: month 9); −15,459 CHF/yr operating flow |
| **P00015** (employed, 60,863 CHF loan at 5.26%) | 63,947 | 310,891 | 619,570 | Interest-only 260.56 CHF/month; debt flat; savings pile up as idle cash |
| P00015, annuity over 60 months | 64,203 | 318,244 | 642,557 | Debt 0 in 2029; higher NW because no interest is paid after payoff |
| P00015, illustrative macro + demo policy* | 66,538 | 357,665 | 808,500 | 6-month buffer kept in cash, the rest invested at 4% |
| **P00013** (retired, 35,408 CHF loan at 5.93%) | 65,373 | 53,292 | 38,190 | Interest-only (170 CHF/month) turns cash negative in **month 32**, vs month 98 with no debt service |

\*Illustrative only, not a forecast: inflation 1%, wage growth 1%, cash 0.25%, return 4%.

## 4. Problems and missing assumptions found

1. **Interest-only debt service is a new cash outflow.**
   - The historical ledger contains no loan flows, and the EDA found that loan holders don't spend more (Δ −20 CHF, not significant). So the data's spending level does *not* include debt service, and adding it is correct but untested against data.
   - It matters for marginal clients. P00013 goes negative 66 months earlier, and 29 of 283 debt holders end 10 years with negative cash.
   - The loan term is unknown for every loan. A real term per client would change results materially.
2. **Negative cash is unconstrained and free by default.**
   - 150 of 1,200 clients end 10 years negative (median −147k CHF): all students, all unemployed, 46 retired, 21 part-time.
   - Of these, 36 hold investments that would cover the shortfall.
   - Missing rules: an overdraft rate (supported, default 0), a liquidation rule (sell investments when cash < 0), and a credit limit. These belong in the decision/financing layer.
3. **Employment and household status never change.** Alexia stays a student on 1,200 CHF for 10 years, and nobody retires at 65. 10-year paths for students, the unemployed and near-retirees are not meaningful without life-event assumptions (graduation, job finding, retirement income); the data has none (`life-events.csv` is absent).
4. **No savings-allocation default.** With the default "do nothing" decision, surpluses pile up as 0%-interest cash (P00015: 669k CHF in 2034). Net-worth comparisons depend heavily on the investment policy and the return assumption, both external.
5. **Expected value vs realisation.**
   - The December bonus enters as its expectation (P00015: 3,234 CHF). In reality a client gets either 0 or ≈5,860 CHF.
   - The February/August lumps are smoothed into the base mean in the same way.
   - So the deterministic path understates liquidity risk, and the backtest misses noise-driven dips such as P00753 (observed −3,239 CHF mid-period). This is what the Monte Carlo step must add.
6. **The macro inputs need external values.** Inflation, wage growth, returns, the cash rate and the overdraft rate all default to 0. Specifics:
   - Wage growth compounds monthly (smooth); Swiss salaries usually step once a year. This has a small effect on totals.
   - The loan-rate shift applies to all loans, which assumes variable rates; personal loans are often fixed-rate.
   - Inflation without matching wage growth erodes real income. That is intended, but the user should see it.
7. **Not modelled:** taxes (net income assumed after tax; no wealth tax), pension pillars, and investment contributions/withdrawals beyond the explicit decision. The engine starts at 2025-01: starting at end-2026 would need investment valuations and debt balances for 2025–26, which the data lacks.
8. **Parameter-file rounding** (6 significant digits) causes ≤0.001 CHF differences against the EDA. Immaterial.
