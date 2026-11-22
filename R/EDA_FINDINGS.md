# EDA findings and recommended model (AI Financial Twin, UBS × LauzHack 2026)

Run: `Rscript R/install_packages.R` once, then `Rscript R/eda.R` (≈30 s). Every number below is printed by the script; the supporting tables are in `R/output/tables/`.
No simulation has been implemented.

**Outputs for the model team**

| File | Content |
|---|---|
| `output/model_parameters.csv` | Every estimated parameter, in long format: block, parameter, employment_status, month, key, value, SE, unit, source |
| `output/client_effects.csv` | Per-client personalisation: shrunk shock scale σᵢ, predicted regular-month outflow and net flow |
| `output/client_static.csv` | Opening balance sheet (each item counted once) plus 24-month statistics per client |
| `output/client_month_panel.csv` | Consolidated 28,800-row panel (1,200 clients × 24 months) |

---

## 1. Data: structure and quality

- **Files and keys.** There are 8 CSVs, all keys are unique, and there are **0 missing values**. `profile_id` joins everything.
  - `synthetic-cash-balances.csv` is the only time series: 1,200 clients × 24 months (2025-01 to 2026-12).
  - All other files are snapshots dated 2025-01-01.
- **Files listed in the README but absent:**
  - `synthetic-transactions.csv`: there is no income/expense split, so the only monthly observation is `net_transactions_chf`.
  - `life-events.csv`
  - `alexia-profile.json`
- **Ledger.** It is internally exact. opening + net = closing, opening_t = closing_{t−1}, and the status flag equals closing < 0 (772 months, 61 clients).
- **Double-counting traps** (the script handles each with `stopifnot` guards):
  - **Opening cash is stored four times** with identical values: profiles, accounts, assets(cash) and ledger month 1. Use it once.
  - **Rent is already inside the net flow.** Never subtract it again.
  - **Loans are not in the ledger.** All 283 have `monthly_payment_chf = 0`, with the note "not amortized in cash transaction ledger".
  - **Investment `account_id`s (1,199) do not exist in `accounts`.** No flows go in or out of investments. P00001 has no portfolio.
- **Plausibility flags:**
  - Unemployed income is as low as 9.4 CHF/month (7 clients below 300).
  - Rent exceeds income for 37/37 unemployed and 32/39 students.
  - Goals have only two dates: 2029-12-31 for the high-priority goals and 2032-12-31 for the medium-priority ones.

**Observed vs derived vs missing** (full table: `03_variable_classes.csv`)

| Class | Variables |
|---|---|
| Observed monthly | Net flow, opening and closing cash |
| Observed snapshot | Age, city/canton, employment, household, reference income, reference rent, investments, loan principal and rate, goals |
| Derived | Non-rent outflow = income − rent − net; irregular "excess" per month; bonus flags; net worth = cash + investments − debt |
| Missing | Income history, expense categories, investment returns and history, loan amortisation, property, taxes/pensions, inflation and any macro series, life events |

## 2. What the data says about behaviour

1. **The net flow is almost exactly income − rent − ≈1,480 CHF.**
   - Regressing each client's regular-month mean net flow on income and rent gives coefficients **1.002** and **−1.031**, with **R² = 0.9965**.
   - So income and rent enter the model with coefficient 1, and what is left to model is the *non-rent outflow*: mean 1,483 CHF, SD 173 across clients.
2. **City drives the non-rent outflow. Household type and income do not.**
   - Kruskal-Wallis ε² for non-rent outflow is **0.30 for city**, 0.03 for employment and ≈0 for household type.
   - Model offsets run from **Fribourg −121** to **Zurich +176 CHF/month**.
   - Families spend no more than singles except through rent. This is a property of the data generator. Household effects such as a child would need an external assumption.
3. **Seasonality is CHF-flat, except December.**
   - **February and August** add ≈ +360 CHF of outflow. This splits into a ≈180 CHF shift plus an 11–22% chance (depending on group) of a lump of ≈1,500 CHF (`04d_irregular_events`).
   - **Students** additionally pay ≈ +1,400 CHF in February and ≈ +800 CHF in September, a tuition-like pattern.
   - The February/August effects do not scale with income (R² ≈ 0.01 or less).
4. **The December bonus exists only for employed and self-employed clients, and it is not a client trait.**

   | Group | P(bonus) | Size given bonus, × monthly income: median (p10–p90) |
   |---|---|---|
   | Employed | 0.55 | 0.59 (0.30–0.93) |
   | Self-employed | 0.27 | 0.90 (0.68–1.13) |
   | Other groups | ≈ 0 | – |

   - **No persistence across years.** P(bonus 2026 | bonus 2025) = 0.57 vs 0.54 without one (Fisher p = 0.44). Bonus size has year-to-year Spearman ρ = 0.12.
   - **Draw the bonus independently each year.** A client-specific random December slope looked better on in-sample AIC during development, but it failed out of sample (December 80% coverage 28%), so it was dropped.
   - **Self-employed detection is censored.** Their noise is about 1,600 CHF, so the 3-SD rule misses small bonuses. Non-bonus Decembers still sit ≈680 CHF higher, which one extra term absorbs.
5. **Shocks:**
   - **Independence:** no autocorrelation (lag-1 −0.03 on model residuals).
   - **Scale by group:** regular-month SD is ≈ 360–490 CHF for most groups and **1,626 for self-employed**. February and August are ×1.5–2.1 wider (≈ ×1 for self-employed, whose regular noise already dominates).
   - **Scale by client:** the scale is client-specific. log σᵢ ≈ employment + 0.40·log income (R² 0.67), plus a residual client component; the shrinkage weight on a client's own SD is 0.54.
   - **Shape:** given σᵢ, shocks are close to Normal (excess kurtosis 0.15).
6. **No persistent client-specific spending level.** Once employment and city are in the model, the client random intercept has SD **σᵤ = 16 CHF** (BLUP SD 2 CHF). Personalisation therefore comes from each client's observed inputs and own volatility, not from a learned spending offset.
7. **Two-year step.** Regular-month net flow is **+91 CHF/month in 2026 for employed** (SE 8.7, ≈1.2% of income, scaling with income) and +151 for self-employed (SE 73). Other groups show ≈ 0. Two points per client cannot separate a trend from a one-off step, so it is **reported but not used**.
8. **Balance sheet:**
   - Investments rise with age (ρ = 0.69; ≈ +6.8% per year of age, R² 0.43) and cash also rises with age (ρ = 0.44).
   - Loan incidence (24%) is unrelated to employment, age or income (p = 0.64).
   - Negative cash appears almost only for students (32/39) and unemployed (20/37). Every client who goes negative has a negative mean net flow.

## 3. Parameters: estimable vs external

| Estimable from the CSVs (in `model_parameters.csv`) | Requires an external assumption (scenario input) |
|---|---|
| Base non-rent outflow by employment × month, CHF (`mean`) | Income growth, wage shocks, job loss (income is a constant reference) |
| City offset, CHF (`mean`) | Inflation of spending and rent (no macro history) |
| Bonus probability and empirical size quantiles (`bonus`) | Investment return and volatility (snapshot only); cash → investment contributions |
| Shock SD by employment × month type, plus multipliers (`shocks`) | Interest on cash |
| σᵢ per client (`client_effects.csv`) and the regression for new clients (`shocks/log_sigma_i_coef`) | Loan payment, term and amortisation (payments are 0 in the data, so nothing can be inferred) |
| Lag-1 autocorrelation ≈ 0; Normal shape | Taxes, pension pillars, retirement transition |
| Initial state, observed directly (`client_static.csv`) | Life events (only S001 tuition exists, marked illustrative) |
| Optional: Feb/Aug lump-outflow probability and size | Any market factor or cross-client correlation |

The year-2 step is in the `drift_not_for_use` block. If the team wants wage growth, it is a scenario input; ≈1.2%/yr for employed is the only data-consistent hint.

## 4. Recommended model (one generic model; personalised by inputs)

State per client: cash Cₜ, investments Iₜ, debt Dₜ. Calendar month m, and month type τ(m) ∈ {regular, Feb, Aug, Dec}.

```
NF_t = Y_i − R_i − O_t + B_t                         # monthly net cash flow (CHF)
O_t  = base[emp_i, m] + city[city_i] + ε_t           # non-rent outflow (estimated)
ε_t  ~ N(0, (σ_i · k[emp_i, τ(m)])²), i.i.d.         # σ_i: shrunk own SD, or predicted for a new client
B_t  = 1{m=Dec} · Bernoulli(p[emp_i]) · s_t · Y_i    # s_t drawn from the empirical bonus-size quantiles
C_{t+1} = C_t + NF_t − P_t − X_t                     # P_t loan payment (assumption), X_t investing (decision)
I_{t+1} = (I_t + X_t) · exp(μ_r − σ_r²/2 + σ_r Z_t)  # external μ_r, σ_r; Z_t common market factor
D_{t+1} = D_t · (1 + r_i/12) − P_t                   # r_i observed
NW_t = C_t + I_t − D_t                               # each item exactly once
```

- **Scenario levers** are applied to the observed inputs, not re-estimated:
  - Inflation multiplies O and R.
  - Income growth and job events change Y.
  - A move changes R and the city offset.
  - Defaults are 0.
- **P_t is a new outflow** that the historical ledger never contained. Set it explicitly (annuity over a user-given term, or interest-only), and never fold it into O.
- **Optional refinement** if liquidity-risk tails matter: replace the wider February/August Gaussian with "regular σ + a lump outflow with probability p_event". The parameters are in `feb_aug_events_optional`.

**Validation** (analytic, no Monte Carlo): fit on 2025, predict 2026 using exact Normal + bonus-mixture predictive distributions.

| Horizon | 80% coverage | 50% coverage | RMSE | Naive (repeat 2025) |
|---|---|---|---|---|
| Monthly | 0.815 | 0.504 | 952 CHF | – |
| Annual total | 0.795 | 0.507 | 3,264 CHF | 4,518 CHF |

The remaining miscalibration is the 2026 step: the mean bias is +68 CHF/month, and the top PIT deciles are over-represented (annual deciles 9–10: 0.13 and 0.14).

The mean structure was chosen by BIC. City + common months + student-specific months beat:
- the full employment × month model, by ΔBIC 377;
- the model with no city term, by ΔBIC 867.

**Cross-check against `frontend/src/model/params.json`** (`07_crosscheck_params_json.csv`):

- **Agreement:** lag-1 autocorrelation (−0.048 vs −0.049), P(bonus) for employed (0.537 vs 0.552), median bonus size (0.607 vs 0.595), and negative months (772 = 772).
- **Gap:** its spending regression has **no city term** (cv R² 0.049). City alone explains ≈30% of between-client variation in non-rent spending, the largest gain available to the existing app.
