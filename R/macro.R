#!/usr/bin/env Rscript
# =============================================================================
# AI Financial Twin (UBS x LauzHack 2026) - Macro model: Swiss inflation and unemployment
#
# Purpose : the synthetic UBS data has 24 calm months and no macro series, so the effect of the
#           economy cannot be learned from it. This script fits a small, explainable forecasting
#           model on PUBLIC Swiss data and exports it for the frontend's Monte Carlo
#           (economy "Forecast (Swiss data)": each simulated future draws its own macro path).
# Data    : World Bank API, Switzerland (CHE), annual, CC BY 4.0
#             FP.CPI.TOTL.ZG  inflation, consumer prices (annual %)          1960-2025
#             SL.UEM.TOTL.ZS  unemployment, % of labour force (ILO estimate)  1991-2025
#           Downloaded once into R/data/worldbank_che.csv (versioned, so runs need no network).
# Model   : VAR(1) on x_y = (inflation_y, log unemployment_y), years 1992-2025, OLS per equation:
#             x_y = c + A x_{y-1} + e_y,   e_y ~ N(0, Sigma)
#           log unemployment keeps the rate positive in every simulated path.
# Checks  : stationarity (|eigenvalues of A| < 1) and a rolling-origin out-of-sample backtest
#           (fit up to year T, forecast T+1..T+3, T = 2005..2024): coverage of the 80% / 50% ranges
#           and RMSE against a random walk and the historical mean.
# Outputs : R/output/macro_parameters.csv  VAR coefficients, Sigma, last observation, labour assumptions
#           R/output/macro_backtest.csv    out-of-sample coverage and errors by variable and horizon
#           R/output/macro_forecast.csv    median and 10-90% range of the forecast, 2026-2030
# Run     : Rscript R/macro.R          (base R; jsonlite only if the data file has to be downloaded)
# =============================================================================

get_r_dir <- function() {
  a <- commandArgs(trailingOnly = FALSE)
  f <- sub("^--file=", "", a[grepl("^--file=", a)])
  if (length(f) == 1) return(dirname(normalizePath(f)))
  if (file.exists("R/macro.R")) return(normalizePath("R"))
  if (file.exists("macro.R")) return(normalizePath("."))
  stop("Cannot locate the R/ folder. Run as: Rscript R/macro.R")
}
R_DIR <- get_r_dir()
DATA_FILE <- file.path(R_DIR, "data", "worldbank_che.csv")
OUT <- file.path(R_DIR, "output")
dir.create(dirname(DATA_FILE), recursive = TRUE, showWarnings = FALSE)
dir.create(OUT, recursive = TRUE, showWarnings = FALSE)
set.seed(2026)
N_SIM <- 5000

# ---- 1. Data -------------------------------------------------------------------------
if (!file.exists(DATA_FILE)) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Need jsonlite to download the data: Rscript R/install_packages.R")
  wb <- function(ind) {
    j <- jsonlite::fromJSON(sprintf("https://api.worldbank.org/v2/country/CHE/indicator/%s?format=json&per_page=200", ind))
    d <- j[[2]]
    data.frame(year = as.integer(d$date), value = as.numeric(d$value))
  }
  infl <- wb("FP.CPI.TOTL.ZG"); unem <- wb("SL.UEM.TOTL.ZS")
  raw <- merge(setNames(infl, c("year", "inflation_pct")), setNames(unem, c("year", "unemployment_pct")), by = "year", all = TRUE)
  raw <- raw[order(raw$year), ]
  write.csv(raw, DATA_FILE, row.names = FALSE)
  cat("Downloaded World Bank series ->", DATA_FILE, "\n")
}
raw <- read.csv(DATA_FILE)
d <- raw[!is.na(raw$inflation_pct) & !is.na(raw$unemployment_pct), ]
d <- d[order(d$year), ]
stopifnot(all(diff(d$year) == 1), min(d$year) <= 1991, max(d$year) >= 2025)
d$lu <- log(d$unemployment_pct)
cat(sprintf("Data: %d-%d (%d years) | inflation mean %.2f%% sd %.2f | unemployment mean %.2f%% (%.2f-%.2f)\n",
            min(d$year), max(d$year), nrow(d), mean(d$inflation_pct), sd(d$inflation_pct),
            mean(d$unemployment_pct), min(d$unemployment_pct), max(d$unemployment_pct)))

# ---- 2. VAR(1) -------------------------------------------------------------------------
VARS <- c("inflation", "log_unemployment")
lagged <- function(d) data.frame(year = d$year[-1], pi = d$inflation_pct[-1], lu = d$lu[-1],
                                 pi_l = d$inflation_pct[-nrow(d)], lu_l = d$lu[-nrow(d)])
fit_var <- function(d) {
  z <- lagged(d)
  m1 <- lm(pi ~ pi_l + lu_l, data = z); m2 <- lm(lu ~ pi_l + lu_l, data = z)
  B <- rbind(coef(m1), coef(m2))                      # rows: equations; cols: (Intercept), pi_l, lu_l
  res <- cbind(residuals(m1), residuals(m2))
  list(c = B[, 1], A = B[, 2:3, drop = FALSE], Sigma = crossprod(res) / (nrow(z) - 3), n = nrow(z),
       years = range(z$year), r2 = c(summary(m1)$r.squared, summary(m2)$r.squared))
}
# n paths of H years ahead from the last observation x0 = (inflation, log unemployment)
sim_var <- function(f, x0, H, n = N_SIM) {
  L <- t(chol(f$Sigma))
  out <- array(NA_real_, c(n, H, 2))
  x <- matrix(x0, n, 2, byrow = TRUE)
  for (h in seq_len(H)) {
    e <- matrix(rnorm(2 * n), n, 2) %*% t(L)
    x <- sweep(x %*% t(f$A), 2, f$c, "+") + e
    out[, h, ] <- x
  }
  out
}

fit <- fit_var(d)
ev <- Mod(eigen(fit$A)$values)
mu <- solve(diag(2) - fit$A, fit$c)
cat("\nVAR(1) on", fit$years[1], "-", fit$years[2], "(n =", fit$n, ")\n")
print(round(cbind(c = fit$c, fit$A), 4))
cat("R2:", round(fit$r2, 3), "| |eigenvalues|:", round(ev, 3), "| long-run mean: inflation",
    round(mu[1], 2), "%, unemployment", round(exp(mu[2]), 2), "%\n")
stopifnot(all(ev < 1))  # stationary: forecasts settle around the long-run mean

# ---- 3. Out-of-sample backtest (rolling origin) ----------------------------------------------
H_BT <- 3
bt <- do.call(rbind, lapply(2005:2024, function(T0) {
  dt <- d[d$year <= T0, ]
  f <- fit_var(dt)
  x0 <- c(tail(dt$inflation_pct, 1), tail(dt$lu, 1))
  s <- sim_var(f, x0, H_BT, n = 2000)
  do.call(rbind, lapply(seq_len(H_BT), function(h) {
    yr <- T0 + h
    if (!yr %in% d$year) return(NULL)
    act <- c(d$inflation_pct[d$year == yr], d$unemployment_pct[d$year == yr])
    draws <- cbind(s[, h, 1], exp(s[, h, 2]))
    data.frame(origin = T0, year = yr, horizon = h, variable = c("inflation_pct", "unemployment_pct"),
               actual = act, median = apply(draws, 2, median),
               pit = c(mean(draws[, 1] <= act[1]), mean(draws[, 2] <= act[2])),
               random_walk = c(x0[1], exp(x0[2])),
               hist_mean = c(mean(dt$inflation_pct), mean(dt$unemployment_pct)))
  }))
}))
macro_bt <- do.call(rbind, lapply(split(bt, list(bt$variable, bt$horizon)), function(g) {
  data.frame(variable = g$variable[1], horizon = g$horizon[1], n = nrow(g),
             coverage80 = mean(g$pit >= 0.1 & g$pit <= 0.9), coverage50 = mean(g$pit >= 0.25 & g$pit <= 0.75),
             rmse_model = sqrt(mean((g$actual - g$median)^2)),
             rmse_random_walk = sqrt(mean((g$actual - g$random_walk)^2)),
             rmse_hist_mean = sqrt(mean((g$actual - g$hist_mean)^2)))
}))
macro_bt <- macro_bt[order(macro_bt$variable, macro_bt$horizon), ]
cat("\nOut-of-sample (origins 2005-2024; perfect coverage = 0.80 / 0.50):\n")
print(format(macro_bt, digits = 3), row.names = FALSE)
write.csv(macro_bt, file.path(OUT, "macro_backtest.csv"), row.names = FALSE)

# ---- 4. Forecast summary from the last observation -----------------------------------------
last <- tail(d, 1)
H_FC <- 5
s <- sim_var(fit, c(last$inflation_pct, last$lu), H_FC)
fc <- do.call(rbind, lapply(seq_len(H_FC), function(h) {
  data.frame(year = last$year + h, variable = c("inflation_pct", "unemployment_pct"),
             p10 = c(quantile(s[, h, 1], 0.1), quantile(exp(s[, h, 2]), 0.1)),
             p50 = c(median(s[, h, 1]), median(exp(s[, h, 2]))),
             p90 = c(quantile(s[, h, 1], 0.9), quantile(exp(s[, h, 2]), 0.9)), row.names = NULL)
}))
cat("\nForecast from", last$year, "(inflation", round(last$inflation_pct, 2), "%, unemployment", round(last$unemployment_pct, 2), "%):\n")
print(format(fc, digits = 3), row.names = FALSE)
write.csv(fc, file.path(OUT, "macro_forecast.csv"), row.names = FALSE)

# ---- 5. Parameters (long format) + labour-market assumptions ---------------------------------
P <- function(block, parameter, key, value, unit, source) data.frame(block, parameter, key, value, unit, source)
src_wb <- "World Bank API, CHE: FP.CPI.TOTL.ZG and SL.UEM.TOTL.ZS (ILO estimate), CC BY 4.0"
src_var <- sprintf("VAR(1), OLS per equation, %d-%d (n = %d)", fit$years[1], fit$years[2], fit$n)
cell <- expand.grid(i = 1:2, j = 1:2)
sig_idx <- cell[cell$i <= cell$j, ]
labour <- rbind(
  # How an aggregate rate becomes a personal risk. The challenge docs warn that an aggregate rate is NOT a
  # personal probability: these are labelled assumptions, the same for every worker, editable in the app.
  # Monthly flows (steady state): job-finding f = 1/duration; job-loss s = f * u / (1 - u), u = registered rate.
  # Duration and the registered rate are both SECO (registered) figures, so the forecast ILO rate is scaled to the
  # registered level with their 2025 ratio. Only employees: the self-employed are not insured against unemployment.
  P("labour_assumption", "duration_months", NA, 7, "months",
    "average unemployment duration ~7 months (swissinfo.ch citing SECO data); job-finding chance = 1/duration per month"),
  P("labour_assumption", "registered_share", NA, round(2.8 / last$unemployment_pct, 4), "ratio",
    sprintf("SECO registered rate 2025 = 2.8%% (kmu.admin.ch, 'Unemployment up 20%% in one year') / ILO rate 2025 = %.3f%% (World Bank): turns the forecast ILO rate into the registered rate that matches the SECO duration", last$unemployment_pct)),
  P("labour_assumption", "replacement", NA, 0.70, "share of insured salary", "Swiss unemployment insurance (AVIG Art. 22): 70% of insured earnings; employees only (the self-employed cannot insure)"),
  P("labour_assumption", "replacement_higher", NA, 0.80, "share of insured salary", "80% with maintenance obligations to children, or insured salary <= CHF 3,797/month (AVIG Art. 22)"),
  P("labour_assumption", "low_salary_threshold_month", NA, 3797, "CHF/month", "AVIG Art. 22: below this insured salary the rate is 80%"),
  P("labour_assumption", "insured_salary_cap_year", NA, 148200, "CHF/year", "maximum insured earnings (SECO / arbeit.swiss)"),
  P("labour_assumption", "max_months_standard", NA, 18, "months", "400 daily allowances with >= 18 months of contributions (AVIG Art. 27; ~21.7 allowances per month)"),
  P("labour_assumption", "max_months_young", NA, 9, "months", "200 daily allowances: under 25 without maintenance obligations (AVIG Art. 27)"),
  P("labour_assumption", "max_months_55plus", NA, 24, "months", "520 daily allowances: age >= 55 with >= 22 months of contributions (AVIG Art. 27)"),
  P("labour_assumption", "real_wage_growth", NA, 0, "share per year", "assumption: pay follows LAST year's inflation (Swiss wage rounds), no real growth")
)
macro_params <- rbind(
  P("var", "intercept", VARS, fit$c, c("pct points", "log points"), src_var),
  P("var", "A", paste(VARS[cell$i], VARS[cell$j], sep = "|"), fit$A[cbind(cell$i, cell$j)], "coefficient",
    paste(src_var, "- row = equation, column = last year's value")),
  P("var", "sigma", paste(VARS[sig_idx$i], VARS[sig_idx$j], sep = "|"), fit$Sigma[cbind(sig_idx$i, sig_idx$j)], "covariance", src_var),
  P("var", "long_run_mean", c("inflation_pct", "unemployment_pct"), c(mu[1], exp(mu[2])), "pct", "(I - A)^-1 c"),
  P("start", "last_observation", c("year", "inflation_pct", "unemployment_pct"), c(last$year, last$inflation_pct, last$unemployment_pct), c("year", "pct", "pct"), src_wb),
  labour
)
macro_params$value <- signif(macro_params$value, 8)
write.csv(macro_params, file.path(OUT, "macro_parameters.csv"), row.names = FALSE)
cat("\nmacro_parameters.csv:", nrow(macro_params), "rows | macro_backtest.csv | macro_forecast.csv\n")
