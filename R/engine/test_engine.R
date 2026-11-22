#!/usr/bin/env Rscript
# =============================================================================
# test_engine.R - validation tests and example runs for the deterministic engine
# Run from the repo root:  Rscript R/engine/test_engine.R
# Writes only to R/engine/output/. Exits with status 1 if any test fails.
# =============================================================================

source(file.path(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)))), "engine.R"))
OUT_DIR <- file.path(ENGINE_DIR, "output")
dir.create(OUT_DIR, showWarnings = FALSE)
DATA_DIR <- file.path(dirname(R_DIR), "pre_docs", "Data")
options(width = 150)

theta   <- load_theta(file.path(R_DIR, "output", "model_parameters.csv"))
clients <- load_clients(file.path(R_DIR, "output"))
theta_ledger <- theta; theta_ledger$assumptions$debt_service <- "none"   # replicate the historical ledger

results <- list()
check <- function(name, ok, detail = "") {
  ok <- isTRUE(ok)
  results[[length(results) + 1]] <<- data.frame(test = name, pass = ok, detail = detail)
  cat(sprintf("[%s] %s %s\n", if (ok) "PASS" else "FAIL", name, if (nzchar(detail)) paste0("- ", detail) else ""))
}
all_identities_pass <- function(sim) all(validate_simulation(sim)$pass)
mr <- monthly_rate
ALEXIA <- "P00001"; DEBT <- "P00015"; DEBT_RETIRED <- "P00013"; SELF <- "P00023"

cat("\n== 1. Initial state: every stock from exactly one source ==\n")
prof <- read.csv(file.path(DATA_DIR, "synthetic-profiles.csv"))
ast  <- read.csv(file.path(DATA_DIR, "synthetic-assets.csv"))
lia  <- read.csv(file.path(DATA_DIR, "synthetic-liabilities.csv"))
s0 <- lapply(clients$profile_id, initial_state, clients = clients)
c0 <- vapply(s0, `[[`, numeric(1), "cash"); i0 <- vapply(s0, `[[`, numeric(1), "investments"); d0 <- vapply(s0, `[[`, numeric(1), "debt")
inv_raw  <- tapply(ast$value_chf[ast$asset_type != "cash"], ast$profile_id[ast$asset_type != "cash"], sum)
debt_raw <- tapply(lia$opening_principal_chf, lia$profile_id, sum)
ids <- clients$profile_id
check("cash = profiles.opening_cash (one copy, not summed with accounts/assets)",
      max(abs(c0 - prof$opening_cash_chf[match(ids, prof$profile_id)])) < 1e-6)
check("investments = assets(investment) only, cash asset excluded",
      max(abs(i0 - ifelse(is.na(inv_raw[ids]), 0, inv_raw[ids]))) < 1e-6)
check("debt = liabilities principal", max(abs(d0 - ifelse(is.na(debt_raw[ids]), 0, debt_raw[ids]))) < 1e-6)
check("aggregate net worth = cash + investments - debt",
      abs(sum(c0 + i0 - d0) - (sum(prof$opening_cash_chf) + sum(ast$value_chf[ast$asset_type != "cash"]) - sum(lia$opening_principal_chf))) < 1e-3)

cat("\n== 2. Alexia (P00001): student, no debt, 10 years ==\n")
a120 <- simulate_client(ALEXIA, 120, theta, clients)
print(validate_simulation(a120))
check("Alexia: all accounting identities hold (120 months)", all_identities_pass(a120))
check("Alexia: no debt flows, investments stay 0", all(a120$debt_close == 0) && all(a120$debt_payment == 0) && all(a120$inv_close == 0))
check("Alexia: January living cost = base[student, Jan] + city[Lausanne] + u_i",
      abs(a120$living[1] - (theta$base_outflow["student", 1] + theta$city_offset[["Lausanne"]] +
                              clients$u_outflow_chf[clients$profile_id == ALEXIA])) < 1e-9)
check("Alexia: rent is a separate flow equal to reference rent (not inside living cost)",
      all(a120$rent == 900) && all(a120$living < 3000))
check("Alexia: no bonus for a student", all(a120$bonus == 0))
first_neg <- which(a120$cash_close < 0)[1]
check("Alexia: cash turns negative within year 1 (observed ledger: month 9)", first_neg <= 12,
      sprintf("model month %d, 10-year cash %s CHF", first_neg, format(round(tail(a120$cash_close, 1)), big.mark = "'")))

cat("\n== 3. Client with debt (P00015): employed, 60'863 CHF at 5.26%, term unknown -> interest-only ==\n")
d120 <- simulate_client(DEBT, 120, theta, clients)
i_m <- mr(0.0526)
check("P00015: all accounting identities hold (120 months)", all_identities_pass(d120))
check("P00015: interest-only -> principal constant at opening value", all(abs(d120$debt_close - 60863.10) < 1e-6))
check("P00015: payment = monthly interest = D x ((1+r)^(1/12)-1)", all(abs(d120$debt_payment - 60863.10 * i_m) < 1e-9),
      sprintf("%.2f CHF/month", 60863.10 * i_m))
check("P00015: principal repaid = 0 every month", all(abs(d120$principal_repaid) < 1e-9))
check("P00015: December expected bonus = P(bonus) x E[size] x income",
      abs(d120$bonus[12] - theta$bonus_p[["employed"]] * theta$bonus_size[["employed"]] * 9858.37) < 1e-6 &&
        all(d120$bonus[d120$month != 12] == 0), sprintf("%.2f CHF", d120$bonus[12]))

cat("\n== 4. Known loan term -> annuity (P00015, 60 months) ==\n")
ann <- simulate_client(DEBT, 120, theta, clients, loan_term_months = 60)
check("annuity: identities hold", all_identities_pass(ann))
check("annuity: debt fully repaid at month 60", abs(ann$debt_close[60]) < 1e-6 && ann$debt_close[59] > 0)
check("annuity: constant payment over the term (zero macro)", sd(ann$debt_payment[1:60]) < 1e-8,
      sprintf("%.2f CHF/month", ann$debt_payment[1]))
check("annuity: no payments after payoff", all(ann$debt_payment[61:120] == 0))
check("annuity: total paid = principal + total interest",
      abs(sum(ann$debt_payment) - (60863.10 + sum(ann$debt_interest))) < 1e-6)

cat("\n== 5. Transfers do not change net worth ==\n")
inv_dec <- simulate_client(DEBT, 120, theta, clients, decision = list(invest = 1000))
check("investing 1'000/month at 0% return: identities hold", all_identities_pass(inv_dec))
check("investing: net worth path identical to baseline", max(abs(inv_dec$nw_close - d120$nw_close)) < 1e-6)
check("investing: cash lower and investments higher by exactly 1'000 x t",
      max(abs((d120$cash_close - inv_dec$cash_close) - 1000 * (1:120))) < 1e-6 &&
        max(abs((inv_dec$inv_close - d120$inv_close) - 1000 * (1:120))) < 1e-6)
pre <- simulate_client(DEBT, 120, theta, clients, decision = list(debt_prepay = c(10000, rep(0, 119))))
check("prepaying 10'000 in month 1: identities hold", all_identities_pass(pre))
check("prepaying: debt drops by 10'000 and stays there (interest-only)", all(abs(pre$debt_close - 50863.10) < 1e-6))
check("prepaying: net-worth gain = interest saved (119 months x 10'000 x i)",
      abs((pre$nw_close[120] - d120$nw_close[120]) - 119 * 10000 * i_m) < 1e-6,
      sprintf("+%.2f CHF after 10 years", pre$nw_close[120] - d120$nw_close[120]))
wd <- simulate_client(DEBT, 3, theta, clients, decision = list(invest = -1e9))
check("withdrawals are capped at the portfolio value", all(wd$inv_close >= 0) && wd$inv_close[1] == 0)

cat("\n== 6. Macro inputs ==\n")
m0 <- d120
check("default macro is neutral: income, rent, price index constant over 10 years",
      all(m0$income == m0$income[1]) && all(m0$rent == m0$rent[1]) && all(m0$price_index == 1))
mac <- simulate_client(DEBT, 24, theta, clients, macro = list(inflation = 0.02, wage_growth = 0.03))
check("macro: identities hold", all_identities_pass(mac))
check("wage growth 3%: income(t+12) = 1.03 x income(t)", abs(mac$income[13] / mac$income[1] - 1.03) < 1e-12)
check("inflation 2%: living(t+12) = 1.02 x living(t), rent follows inflation by default",
      abs(mac$living[13] / mac$living[1] - 1.02) < 1e-12 && abs(mac$rent[13] / mac$rent[1] - 1.02) < 1e-12)
check("bonus scales with income", abs(mac$bonus[24] / mac$bonus[12] - 1.03) < 1e-12)
mac_r <- simulate_client(DEBT, 13, theta, clients, macro = list(inflation = 0.02, rent_inflation = 0))
check("rent inflation can be set separately", all(mac_r$rent == mac_r$rent[1]))
ret <- simulate_client(DEBT, 12, theta, clients, macro = list(investment_return = 0.05))
check("investment return 5%: portfolio x 1.05 after 12 months", abs(ret$inv_close[12] / ret$inv_open[1] - 1.05) < 1e-12)
cr <- simulate_client(DEBT, 1, theta, clients, macro = list(cash_rate = 0.01))
check("cash rate 1%: first-month interest = C0 x ((1.01)^(1/12)-1)", abs(cr$cash_interest[1] - cr$cash_open[1] * mr(0.01)) < 1e-9)
od <- simulate_client(ALEXIA, 24, theta, clients, macro = list(overdraft_rate = 0.08))
check("overdraft rate applies only while cash is negative",
      all(od$cash_interest[od$cash_open >= 0] == 0) && all(od$cash_interest[od$cash_open < 0] < 0))
sh <- simulate_client(DEBT, 1, theta, clients, macro = list(loan_rate_shift = 0.01))
check("loan rate shift +1pp", abs(sh$debt_interest[1] - 60863.10 * mr(0.0626)) < 1e-9)
path <- simulate_client(DEBT, 24, theta, clients, macro = list(inflation = c(rep(0, 12), rep(0.05, 12))))
check("time-varying macro path: no inflation in year 1, 5% in year 2",
      all(path$price_index[1:13] == 1) && abs(path$price_index[24] / path$price_index[13] - 1.05^(11 / 12)) < 1e-12)

cat("\n== 7. Consistency with the EDA estimates (ledger mode: no loan flows, zero macro) ==\n")
regular_set <- function(emp) setdiff(1:12, c(2, 8, 12, if (emp == "student") 9))
cons <- vapply(seq_len(nrow(clients)), function(k) {
  s <- simulate_state(initial_state(clients$profile_id[k], clients), 12, theta_ledger)
  mean(s$operating_net[s$month %in% regular_set(clients$employment_status[k])])
}, numeric(1))
eff <- read.csv(file.path(R_DIR, "output", "client_effects.csv"))
# Tolerance 0.01 CHF: model_parameters.csv stores values to 6 significant digits (e.g. 1477.63),
# while client_effects.csv was computed from the unrounded estimates.
cons_diff <- max(abs(cons - eff$regular_net_hat_chf[match(clients$profile_id, eff$profile_id)]))
check("simulated regular-month net flow = EDA regular_net_hat for all 1'200 clients", cons_diff < 0.01,
      sprintf("max |diff| %.4f CHF (parameter-file rounding)", cons_diff))

cat("\n== 8. Backtest against the observed ledger 2025-2026 (ledger mode, in-sample) ==\n")
panel <- read.csv(file.path(R_DIR, "output", "client_month_panel.csv"))
obs <- panel[panel$t %in% c(12, 24), c("profile_id", "t", "closing_cash")]
t_bt <- system.time({
  bt <- do.call(rbind, lapply(clients$profile_id, function(id) {
    s <- simulate_state(initial_state(id, clients), 24, theta_ledger)
    data.frame(profile_id = id, t = c(12, 24), sim_cash = s$cash_close[c(12, 24)])
  }))
})
bt <- merge(merge(bt, obs, by = c("profile_id", "t")), clients[, c("profile_id", "employment_status")], by = "profile_id")
bt$error <- bt$closing_cash - bt$sim_cash
bt_tab <- do.call(rbind, lapply(split(bt, list(bt$employment_status, bt$t)), function(d)
  data.frame(employment_status = d$employment_status[1], month = d$t[1], n = nrow(d),
             mean_error_obs_minus_model = mean(d$error), median_abs_error = median(abs(d$error)),
             obs_cash_change_median = median(d$closing_cash - clients$cash_t0[match(d$profile_id, clients$profile_id)]))))
bt_tab <- bt_tab[order(bt_tab$month, match(bt_tab$employment_status, EMPLOYMENT_LEVELS)), ]
print(bt_tab, row.names = FALSE, digits = 4)
write.csv(bt_tab, file.path(OUT_DIR, "backtest_by_group.csv"), row.names = FALSE)
# The parameters were estimated on both years, so the in-sample 24-month error should be ~0, while the
# 12-month error is about minus half of the year-2 step (2026 regular months +91 CHF for employed, EDA 4e).
check("backtest: in-sample mean 24-month cash error within +/- 300 CHF",
      abs(mean(bt$error[bt$t == 24])) < 300, sprintf("%.0f CHF", mean(bt$error[bt$t == 24])))
emp12 <- mean(bt$error[bt$t == 12 & bt$employment_status == "employed"])
cat(sprintf("  info: 12-month error %.0f CHF overall, %.0f CHF for employed (~ -1/2 x 91 CHF x 12 = -546: the year-2 step)\n",
            mean(bt$error[bt$t == 12]), emp12))
# A deterministic expected path cannot reproduce noise-driven dips (that is the Monte Carlo step's job),
# so judge the sign of cash at month 24 rather than every month.
sgn <- table(observed_negative = bt$closing_cash[bt$t == 24] < 0, model_negative = bt$sim_cash[bt$t == 24] < 0)
print(sgn)
check("backtest: sign of cash at month 24 agrees for >= 99% of clients",
      mean((bt$closing_cash[bt$t == 24] < 0) == (bt$sim_cash[bt$t == 24] < 0)) >= 0.99,
      sprintf("%d / %d agree", sum(diag(sgn)), sum(sgn)))

cat("\n== 9. All 1'200 clients, 10 years, default assumptions ==\n")
t_all <- system.time({
  batch <- lapply(clients$profile_id, function(id) {
    s <- simulate_client(id, 120, theta, clients)
    v <- validate_simulation(s)
    data.frame(profile_id = id, all_pass = all(v$pass), worst_error = max(v$max_abs_error),
               cash_120 = s$cash_close[120], nw_0 = s$nw_open[1], nw_120 = s$nw_close[120],
               months_negative = sum(s$cash_negative))
  })
})
batch <- do.call(rbind, batch)
batch <- merge(batch, clients[, c("profile_id", "employment_status", "debt")], by = "profile_id")
check("all 1'200 clients: every identity holds for 120 months", all(batch$all_pass),
      sprintf("worst error %.1e CHF, %.1f s", max(batch$worst_error), t_all[["elapsed"]]))
check("horizon 5 and 10 years run", nrow(simulate_client(ALEXIA, 60, theta, clients)) == 60 && nrow(a120) == 120)
neg_tab <- aggregate(cbind(ends_negative = batch$cash_120 < 0, ever_negative = batch$months_negative > 0) ~ employment_status,
                     batch, sum)
cat("Clients with negative cash under default assumptions (10 years):\n"); print(neg_tab, row.names = FALSE)
cat("Debt holders whose 10-year cash ends negative:", sum(batch$debt > 0 & batch$cash_120 < 0), "of", sum(batch$debt > 0), "\n")
write.csv(batch, file.path(OUT_DIR, "batch_10y_default.csv"), row.names = FALSE)

# ---------------------------------------------------------------- examples
cat("\n== Example runs (saved to R/engine/output/) ==\n")
ILLUSTRATIVE <- list(inflation = 0.01, wage_growth = 0.01, cash_rate = 0.0025, investment_return = 0.04)  # illustrative only
# Demonstration policy (not optimised): keep a buffer of 6 months of rent + living costs, invest the rest.
invest_surplus <- function(buffer_months = 6) function(state, t) {
  monthly_need <- state$rent + (mean(theta$base_outflow[state$employment_status, ]) +
                                  theta$city_offset[[state$city]]) * state$price_index
  list(invest = max(0, state$cash - buffer_months * monthly_need))
}
runs <- list(
  alexia_baseline      = simulate_client(ALEXIA, 120, theta, clients),
  P00015_baseline      = d120,
  P00015_illustrative_invest_surplus = simulate_client(DEBT, 120, theta, clients, decision = invest_surplus(), macro = ILLUSTRATIVE),
  P00015_annuity_60m   = ann,
  P00013_baseline      = simulate_client(DEBT_RETIRED, 120, theta, clients),
  P00013_ledger_mode   = simulate_client(DEBT_RETIRED, 120, theta_ledger, clients),
  P00023_baseline      = simulate_client(SELF, 120, theta, clients)
)
for (nm in names(runs)) {
  check(paste0("example ", nm, ": identities hold"), all_identities_pass(runs[[nm]]))
  write.csv(runs[[nm]], file.path(OUT_DIR, paste0("sim_", nm, ".csv")), row.names = FALSE)
}
yearly <- do.call(rbind, lapply(names(runs), function(nm) cbind(scenario = nm, yearly_summary(runs[[nm]]))))
write.csv(yearly, file.path(OUT_DIR, "examples_yearly.csv"), row.names = FALSE)
fmt <- function(x) format(round(x), big.mark = "'")
for (nm in names(runs)) {
  y <- yearly[yearly$scenario == nm & yearly$year %in% c(2025, 2029, 2034), ]
  cat(sprintf("\n%s\n", nm))
  print(data.frame(year = y$year, age = y$age, cash = fmt(y$cash_close), investments = fmt(y$inv_close),
                   debt = fmt(y$debt_close), net_worth = fmt(y$nw_close), income_yr = fmt(y$income + y$bonus),
                   rent_yr = fmt(y$rent), living_yr = fmt(y$living), debt_service_yr = fmt(y$debt_payment),
                   months_neg = y$months_cash_negative), row.names = FALSE)
}

res <- do.call(rbind, results)
write.csv(res, file.path(OUT_DIR, "test_results.csv"), row.names = FALSE)
cat(sprintf("\n%d / %d tests passed\n", sum(res$pass), nrow(res)))
if (!all(res$pass)) quit(status = 1)
