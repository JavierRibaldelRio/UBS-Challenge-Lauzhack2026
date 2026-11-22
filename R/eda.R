#!/usr/bin/env Rscript
# =============================================================================
# AI Financial Twin (UBS x LauzHack 2026) - Exploratory Data Analysis
#
# Data    : the UBS synthetic CSVs are NOT in this repo (private challenge material). To reproduce,
#           copy UBS's challenge "Data/" folder to pre_docs/Data/ (git-ignored); see README §1.6.
# Purpose : find out what the synthetic CSVs in pre_docs/Data/ can and cannot
#           support, and estimate the parameters of ONE generic monthly model.
#           This script does NOT simulate anything.
# Run     : Rscript R/eda.R               (from any directory)
# Setup   : Rscript R/install_packages.R  (one time)
# Outputs : R/output/model_parameters.csv    every estimated parameter (long format)
#           R/output/client_month_panel.csv  consolidated 1,200 x 24 panel
#           R/output/client_static.csv       balance sheet + per-client stats
#           R/output/client_effects.csv      per-client random effects (BLUPs)
#           R/output/tables/*.csv            supporting tables (quoted in EDA_FINDINGS.md)
#
# Sign convention used throughout:
#   net            = net_transactions_chf (observed monthly ledger flow; + = cash in)
#   other_outflow  = income - rent - net   (DERIVED: everything that is not the
#                    reference income or the reference rent, net of irregular
#                    inflows such as a December bonus; + = cash out)
# =============================================================================

t_start <- Sys.time()

# ---- 0. Setup ---------------------------------------------------------------
get_r_dir <- function() {
  a <- commandArgs(trailingOnly = FALSE)
  f <- sub("^--file=", "", a[grepl("^--file=", a)])
  if (length(f) == 1) return(dirname(normalizePath(f)))
  if (file.exists("R/eda.R")) return(normalizePath("R"))
  if (file.exists("eda.R")) return(normalizePath("."))
  stop("Cannot locate the R/ folder. Run as: Rscript R/eda.R")
}
R_DIR <- get_r_dir()
ROOT  <- dirname(R_DIR)
DATA  <- file.path(ROOT, "pre_docs", "Data")
if (!file.exists(file.path(DATA, "synthetic-profiles.csv")))
  stop("UBS synthetic data not found in ", DATA, ". It is not committed (private challenge material): ",
       "copy UBS's challenge 'Data/' folder to pre_docs/Data/ to re-estimate (README section 1.6).", call. = FALSE)
OUT   <- file.path(R_DIR, "output")
TAB   <- file.path(OUT, "tables")
dir.create(TAB, recursive = TRUE, showWarnings = FALSE)

if (nzchar(Sys.getenv("R_LIBS_USER"))) .libPaths(c(Sys.getenv("R_LIBS_USER"), .libPaths()))
need <- c("dplyr", "tidyr")
miss <- need[!vapply(need, requireNamespace, logical(1), quietly = TRUE)]
if (length(miss)) stop("Missing packages: ", paste(miss, collapse = ", "),
                       "\n  Run first: Rscript R/install_packages.R", call. = FALSE)
HAS_LME4 <- requireNamespace("lme4", quietly = TRUE)
HAS_JSON <- requireNamespace("jsonlite", quietly = TRUE)
suppressPackageStartupMessages({ library(dplyr); library(tidyr) })
options(dplyr.summarise.inform = FALSE, width = 150)
set.seed(2026)

EMP <- c("employed", "self_employed", "part_time", "retired", "student", "unemployed")
HH  <- c("single", "couple", "family", "shared_housing")
IRREGULAR_MONTHS <- c(2L, 8L, 12L)   # months with systematic irregular flows (established in 4d)

chf <- function(x) format(round(x), big.mark = "'", scientific = FALSE, trim = TRUE)
save_tab <- function(df, name) {
  df <- as.data.frame(df)
  num <- vapply(df, is.numeric, logical(1))
  df[num] <- lapply(df[num], function(x) signif(x, 6))
  write.csv(df, file.path(TAB, paste0(name, ".csv")), row.names = FALSE)
  invisible(df)
}
section <- function(x) cat("\n", strrep("=", 78), "\n", x, "\n", strrep("=", 78), "\n", sep = "")
show <- function(df) print(as.data.frame(df), row.names = FALSE, digits = 4)
emp_f <- function(x) factor(x, levels = EMP)
coef_tab <- function(m, model) {
  s <- summary(m)$coefficients
  data.frame(model = model, term = rownames(s), estimate = s[, 1], std_error = s[, 2],
             t_value = s[, 3], p_value = s[, 4], r_squared = summary(m)$r.squared, row.names = NULL)
}

cat("R ", R.version$major, ".", R.version$minor, " | lme4: ", HAS_LME4, " | jsonlite: ", HAS_JSON, "\n", sep = "")

# ---- 1. Inventory & data quality ---------------------------------------------
section("1. INVENTORY & DATA QUALITY")

files <- c(profiles     = "synthetic-profiles.csv",
           accounts     = "synthetic-accounts.csv",
           assets       = "synthetic-assets.csv",
           liabilities  = "synthetic-liabilities.csv",
           goals        = "synthetic-goals.csv",
           cash         = "synthetic-cash-balances.csv",
           scen_assump  = "scenario-assumptions.csv",
           scen_catalog = "scenario-catalog.csv")
raw <- lapply(files, function(f) read.csv(file.path(DATA, f), stringsAsFactors = FALSE,
                                          check.names = FALSE, encoding = "UTF-8"))
keys <- list(profiles = "profile_id", accounts = "account_id", assets = "asset_id",
             liabilities = "liability_id", goals = "goal_id", cash = c("profile_id", "month"),
             scen_assump = "assumption_id", scen_catalog = "id")

inventory <- bind_rows(lapply(names(files), function(nm) {
  d <- raw[[nm]]
  data.frame(table = nm, rows = nrow(d), cols = ncol(d),
             primary_key = paste(keys[[nm]], collapse = "+"),
             key_unique = !anyDuplicated(d[keys[[nm]]]),
             n_profiles = if ("profile_id" %in% names(d)) length(unique(d$profile_id)) else NA,
             cells_na = sum(is.na(d)),
             cells_empty = sum(vapply(d, function(x) sum(is.character(x) & x == ""), numeric(1))))
}))
show(inventory)
save_tab(inventory, "01_inventory")

columns <- bind_rows(lapply(names(files), function(nm) {
  d <- raw[[nm]]
  bind_rows(lapply(names(d), function(cn) {
    x <- d[[cn]]
    data.frame(table = nm, column = cn, type = class(x)[1], n_na = sum(is.na(x)),
               n_unique = length(unique(x)),
               min = if (is.numeric(x)) as.character(signif(min(x), 6)) else as.character(min(x)),
               max = if (is.numeric(x)) as.character(signif(max(x), 6)) else as.character(max(x)))
  }))
}))
save_tab(columns, "01_columns")
cat("\nColumn profile -> tables/01_columns.csv (", nrow(columns), " columns, ",
    sum(columns$n_na), " NA cells)\n", sep = "")

expected_missing <- c("synthetic-transactions.csv", "life-events.csv", "alexia-profile.json")
absent <- data.frame(file_listed_in_README = expected_missing,
                     present = file.exists(file.path(DATA, expected_missing)))
cat("\nFiles listed in pre_docs/Data/README.md:\n"); show(absent)
save_tab(absent, "01_files_listed_but_absent")

p  <- raw$profiles; ac <- raw$accounts; as <- raw$assets; li <- raw$liabilities
go <- raw$goals;    cb <- raw$cash;     sa <- raw$scen_assump; sc <- raw$scen_catalog
cb <- cb[order(cb$profile_id, cb$month), ]
inv_rows <- as$asset_type != "cash"

fk <- function(check, child, parent) data.frame(check = check, n_rows = length(child),
                                                n_violations = sum(!child %in% parent))
integrity <- bind_rows(
  fk("accounts.profile_id -> profiles", ac$profile_id, p$profile_id),
  fk("assets.profile_id -> profiles", as$profile_id, p$profile_id),
  fk("assets(cash).account_id -> accounts", as$account_id[!inv_rows], ac$account_id),
  fk("assets(investment).account_id -> accounts", as$account_id[inv_rows], ac$account_id),
  fk("liabilities.profile_id -> profiles", li$profile_id, p$profile_id),
  fk("goals.profile_id -> profiles", go$profile_id, p$profile_id),
  fk("cash.profile_id -> profiles", cb$profile_id, p$profile_id),
  fk("cash.account_id -> accounts", cb$account_id, ac$account_id),
  fk("scen_assump.profile_id -> profiles", sa$profile_id, p$profile_id),
  fk("scen_assump.scenario_id -> scen_catalog", sa$scenario_id, sc$id),
  fk("profiles without investment asset", p$profile_id, as$profile_id[inv_rows]),
  fk("profiles without liability", p$profile_id, li$profile_id),
  fk("profiles without goal", p$profile_id, go$profile_id)
)
cat("\nReferential integrity (n_violations = keys with no match):\n"); show(integrity)
save_tab(integrity, "01_referential_integrity")

all_months <- format(seq(as.Date("2025-01-01"), as.Date("2026-12-01"), by = "month"), "%Y-%m")
consecutive <- tapply(cb$month, cb$profile_id, function(m) identical(sort(m), all_months))
prev_close <- ave(cb$closing_cash_chf, cb$profile_id, FUN = function(x) c(NA, head(x, -1)))
oc <- Reduce(function(a, b) merge(a, b, by = "profile_id"), list(
  setNames(p[, c("profile_id", "opening_cash_chf")], c("profile_id", "profiles")),
  setNames(ac[, c("profile_id", "opening_balance_chf")], c("profile_id", "accounts")),
  setNames(as[!inv_rows, c("profile_id", "value_chf")], c("profile_id", "assets_cash")),
  setNames(cb[cb$month == "2025-01", c("profile_id", "opening_cash_chf")], c("profile_id", "ledger_m1"))))

ledger <- data.frame(
  check = c("profiles with != 24 months", "profiles with non-consecutive months",
            "rows |opening + net - closing| > 0.01", "rows |opening_t - closing_{t-1}| > 0.01",
            "months with closing < 0", "profiles with any closing < 0",
            "status flag != (closing < 0)",
            "opening cash profiles vs accounts, max |diff|",
            "opening cash profiles vs assets(cash), max |diff|",
            "opening cash profiles vs ledger month 1, max |diff|",
            "liabilities with monthly_payment_chf != 0",
            "as_of_date != 2025-01-01 (any snapshot table)",
            "currency != CHF (any table)",
            "goals with target_date <= 2026-12-31"),
  value = c(sum(table(cb$profile_id) != 24), sum(!consecutive),
            sum(abs(cb$opening_cash_chf + cb$net_transactions_chf - cb$closing_cash_chf) > 0.01),
            sum(abs(cb$opening_cash_chf - prev_close) > 0.01, na.rm = TRUE),
            sum(cb$closing_cash_chf < 0), length(unique(cb$profile_id[cb$closing_cash_chf < 0])),
            sum((cb$status == "negative_balance_requires_financing") != (cb$closing_cash_chf < 0)),
            max(abs(oc$profiles - oc$accounts)), max(abs(oc$profiles - oc$assets_cash)),
            max(abs(oc$profiles - oc$ledger_m1)),
            sum(li$monthly_payment_chf != 0),
            sum(c(p$as_of_date, as$as_of_date, li$as_of_date, ac$as_of_date) != "2025-01-01"),
            sum(c(p$currency, as$currency, li$currency, ac$currency, cb$currency, go$currency) != "CHF"),
            sum(as.Date(go$target_date) <= as.Date("2026-12-31"))))
cat("\nLedger & duplication checks:\n"); show(ledger)
save_tab(ledger, "01_ledger_checks")

cat("\nemployment_status:\n"); print(table(p$employment_status))
cat("household_type:\n"); print(table(p$household_type))
cat("goals by name x priority:\n"); print(table(go$goal_name, go$priority))
cat("scenario-assumptions (parameter x scenario):\n"); print(table(sa$parameter, sa$scenario_id))

plaus <- p |>
  group_by(employment_status) |>
  summarise(n = n(), age_min = min(age_at_start), age_max = max(age_at_start),
            income_min = min(reference_monthly_net_income_chf),
            income_median = median(reference_monthly_net_income_chf),
            income_max = max(reference_monthly_net_income_chf),
            n_income_below_300 = sum(reference_monthly_net_income_chf < 300),
            n_rent_gt_income = sum(reference_monthly_rent_chf > reference_monthly_net_income_chf)) |>
  arrange(emp_f(employment_status))
cat("\nPlausibility by employment status:\n"); show(plaus)
save_tab(plaus, "01_plausibility_by_employment")

# ---- 2. Consolidation ---------------------------------------------------------
section("2. CONSOLIDATED CLIENT DATASETS")

prof <- p |>
  transmute(profile_id, age_at_start, city, canton,
            employment_status = emp_f(employment_status),
            household_type = factor(household_type, levels = HH),
            income = reference_monthly_net_income_chf,
            rent   = reference_monthly_rent_chf)

panel <- cb |>
  transmute(profile_id, month, opening_cash = opening_cash_chf, net = net_transactions_chf,
            closing_cash = closing_cash_chf, status) |>
  mutate(year = as.integer(substr(month, 1, 4)),
         moy  = as.integer(substr(month, 6, 7)),
         t    = (year - 2025L) * 12L + moy) |>
  inner_join(prof, by = "profile_id") |>
  mutate(age           = age_at_start + (t - 1L) %/% 12L,
         other_outflow = income - rent - net,
         net_ratio     = net / income,
         month_type    = factor(case_when(moy == 12 ~ "Dec", moy == 2 ~ "Feb", moy == 8 ~ "Aug",
                                          TRUE ~ "regular"), levels = c("regular", "Feb", "Aug", "Dec")),
         regular       = month_type == "regular",
         negative      = closing_cash < 0) |>
  arrange(profile_id, t)

# Year-specific regular-month level -> "excess" = irregular part of each month
yr_reg <- panel |> filter(regular) |>
  group_by(profile_id, year) |> summarise(reg_mean_y = mean(net), .groups = "drop")
panel <- panel |> left_join(yr_reg, by = c("profile_id", "year")) |> mutate(excess = net - reg_mean_y)

# Guards against double counting
stopifnot(
  nrow(panel) == 28800, all(table(panel$profile_id) == 24),
  # net flow is the ledger value untouched (rent already inside it: never subtract rent again)
  isTRUE(all.equal(panel$net, cb$net_transactions_chf)),
  # opening cash exists 4 times with identical values -> taken ONCE, from the ledger
  max(abs(oc$profiles - oc$ledger_m1)) < 0.01, max(abs(oc$assets_cash - oc$ledger_m1)) < 0.01,
  # loans have zero payment and are not in the ledger -> no loan flow hidden in `net`
  all(li$monthly_payment_chf == 0), all(grepl("not amortized in cash transaction ledger", li$notes))
)

client_flow <- panel |>
  group_by(profile_id) |>
  summarise(nf_mean          = mean(net),
            nf_sd            = sd(net),
            nf_reg_mean      = mean(net[regular]),
            sd_reg_within    = sd(excess[regular]),      # regular-month SD net of each year's level
            dec_excess       = mean(excess[moy == 12]),
            feb_excess       = mean(excess[moy == 2]),
            aug_excess       = mean(excess[moy == 8]),
            yoy_reg_change   = reg_mean_y[t == 24] - reg_mean_y[t == 1],
            cash_start       = opening_cash[t == 1],
            cash_end         = closing_cash[t == 24],
            cash_min         = min(closing_cash),
            months_negative  = sum(negative),
            first_negative_t = if (any(negative)) min(t[negative]) else NA_integer_,
            .groups = "drop")

investments <- as |> filter(asset_type != "cash") |>      # cash asset deliberately excluded
  group_by(profile_id) |> summarise(investments = sum(value_chf), .groups = "drop")
debt <- li |> group_by(profile_id) |>
  summarise(debt = sum(opening_principal_chf),
            loan_rate = weighted.mean(annual_interest_rate, opening_principal_chf), .groups = "drop")
goals_c <- go |> group_by(profile_id) |>
  summarise(n_goals = n(), goals_total_target = sum(target_amount_chf), .groups = "drop")

client_static <- prof |>
  left_join(client_flow, by = "profile_id") |>
  left_join(investments, by = "profile_id") |>
  left_join(debt, by = "profile_id") |>
  left_join(goals_c, by = "profile_id") |>
  mutate(investments    = coalesce(investments, 0),
         debt           = coalesce(debt, 0),
         has_loan       = debt > 0,
         cash_t0        = cash_start,                      # single source: ledger month-1 opening
         net_worth_t0   = cash_t0 + investments - debt,    # each component counted once
         other_reg_mean = income - rent - nf_reg_mean,     # derived non-rent outflow, regular months
         savings_rate   = nf_mean / income,
         rent_to_income = rent / income,
         liquidity_months = cash_t0 / (rent + other_reg_mean),
         age_band = cut(age_at_start, c(17, 29, 44, 64, 80), labels = c("18-29", "30-44", "45-64", "65+")))

stopifnot(nrow(client_static) == 1200,
          isTRUE(all.equal(sum(client_static$investments), sum(as$value_chf[inv_rows]))),
          isTRUE(all.equal(sum(client_static$debt), sum(li$opening_principal_chf))))

write.csv(panel |> select(-regular), file.path(OUT, "client_month_panel.csv"), row.names = FALSE)
write.csv(client_static, file.path(OUT, "client_static.csv"), row.names = FALSE)
cat("client_month_panel.csv:", nrow(panel), "rows | client_static.csv:", nrow(client_static), "rows\n")
cat("Balance sheet at 2025-01-01 (sum, CHF): cash", chf(sum(client_static$cash_t0)),
    "| investments", chf(sum(client_static$investments)), "| debt", chf(sum(client_static$debt)),
    "| net worth", chf(sum(client_static$net_worth_t0)), "\n")

# ---- 3. Variable classification ------------------------------------------------
var_classes <- data.frame(
  variable = c("net_transactions_chf", "opening/closing_cash_chf, status",
               "age, city, canton, employment_status, household_type",
               "reference_monthly_net_income_chf", "reference_monthly_rent_chf",
               "opening cash (4 copies)", "investment_portfolio value", "loan principal, annual_interest_rate",
               "goals", "scenario S001 tuition & duration",
               "other_outflow = income - rent - net", "excess (vs own regular-month level)",
               "December bonus incidence/size", "savings_rate, rent_to_income, liquidity_months",
               "net_worth_t0 = cash + investments - debt",
               "income history / wage changes / job loss", "expense breakdown / transactions",
               "investment returns, contributions, valuation history", "loan payments, term, amortisation",
               "property", "taxes, pension pillars", "inflation, rates, any macro series",
               "interest on cash", "life events"),
  class = c("observed_monthly", "observed_monthly", "observed_snapshot", "observed_snapshot",
            "observed_snapshot", "observed_snapshot", "observed_snapshot", "observed_snapshot",
            "observed_snapshot", "external_assumption_in_data",
            rep("derived", 5), rep("missing", 9)),
  note = c("Only time-varying observation; no income/expense split",
           "opening + net = closing holds exactly; status = closing < 0",
           "Constant over 24 months", "Single value; no history", "Single value; already inside net flow",
           "Identical in profiles/accounts/assets/ledger: use ONE", "2025-01-01 snapshot; account_id absent from accounts",
           "Snapshot; monthly_payment_chf = 0; not in ledger", "Targets 2029-2032 (beyond data window)",
           "'Not executed in transaction ledger'",
           "Assumes constant income and rent inside the ledger (R2 = 0.995, 4c)",
           "Same-year regular months = all except Feb, Aug, Dec", "Rule: excess > 3 SD and > 5% of income",
           "Ratios of observed quantities", "No property in data",
           "-", "synthetic-transactions.csv listed in README but absent", "-", "Payments are zero",
           "README mentions property; none present", "-", "No macro history", "-",
           "life-events.csv listed in README but absent"))
save_tab(var_classes, "03_variable_classes")
cat("\nVariable classification -> tables/03_variable_classes.csv\n")

# ---- 4. Exploratory analyses --------------------------------------------------
section("4a. GROUP PROFILES")
group_summary <- function(g) {
  client_static |>
    group_by(group = as.character(.data[[g]])) |>
    summarise(n = n(), income_med = median(income), rent_med = median(rent),
              cash_t0_med = median(cash_t0), invest_med = median(investments),
              loan_share = mean(has_loan), debt_med_if_loan = median(debt[has_loan]),
              nf_mean_med = median(nf_mean), other_reg_med = median(other_reg_mean),
              sd_reg_med = median(sd_reg_within), ever_negative = mean(months_negative > 0)) |>
    mutate(grouping = g, .before = 1)
}
gs <- bind_rows(lapply(c("employment_status", "household_type", "age_band"), group_summary))
show(gs)
save_tab(gs, "04a_group_summary")

section("4b. CORRELATIONS (Spearman, client level)")
corr_vars <- c("age_at_start", "income", "rent", "cash_t0", "investments", "debt", "nf_mean",
               "other_reg_mean", "sd_reg_within", "dec_excess", "feb_excess", "aug_excess")
cm <- cor(as.matrix(client_static[, corr_vars]), method = "spearman")
print(round(cm, 2))
save_tab(cbind(variable = rownames(cm), as.data.frame(round(cm, 3))), "04b_spearman_correlations")

section("4c. NET-FLOW DECOMPOSITION")
m_mean  <- lm(nf_mean ~ income + rent, data = client_static)
m_reg   <- lm(nf_reg_mean ~ income + rent, data = client_static)
m_other <- lm(other_reg_mean ~ employment_status + household_type + income + age_at_start + has_loan,
              data = client_static)
decomp <- bind_rows(coef_tab(m_mean, "nf_mean ~ income + rent"),
                    coef_tab(m_reg, "nf_reg_mean ~ income + rent"),
                    coef_tab(m_other, "other_reg_mean ~ emp + household + income + age + has_loan"))
show(decomp)
save_tab(decomp, "04c_netflow_decomposition")
cat("\nANOVA other_reg_mean:\n"); print(anova(m_other))
cat("other_reg_mean: mean", round(mean(client_static$other_reg_mean)),
    "| sd", round(sd(client_static$other_reg_mean)), "CHF\n")

section("4d. SEASONALITY")
season <- panel |>
  group_by(employment_status, moy) |>
  summarise(n = n(), excess_mean_chf = mean(excess), excess_se_chf = sd(excess) / sqrt(n()),
            excess_median_chf = median(excess), excess_share_income = mean(excess / income),
            .groups = "drop")
cat("Mean excess (net minus same-year regular-month level), CHF:\n")
show(season |> select(employment_status, moy, excess_mean_chf) |>
       pivot_wider(names_from = moy, values_from = excess_mean_chf, names_prefix = "m") |>
       mutate(across(where(is.numeric), round)))
save_tab(season, "04d_season_by_employment")

# CHF-flat or proportional to income?
cme <- panel |> filter(moy %in% c(2, 8, 12)) |>
  group_by(profile_id, employment_status, income, moy) |> summarise(excess = mean(excess), .groups = "drop")
scale_test <- bind_rows(lapply(c(2, 8, 12), function(m) {
  bind_rows(lapply(c("all", "employed", "self_employed", "part_time", "retired"), function(g) {
    d <- cme |> filter(moy == m, g == "all" | employment_status == g)
    s <- summary(lm(excess ~ I(income / 1000), data = d))
    data.frame(month = month.abb[m], group = g, n = nrow(d),
               intercept_chf = s$coefficients[1, 1], intercept_p = s$coefficients[1, 4],
               slope_per_1000_income = s$coefficients[2, 1], slope_se = s$coefficients[2, 2],
               slope_p = s$coefficients[2, 4], r_squared = s$r.squared)
  }))
}))
cat("\nScale test, client mean excess ~ income/1000:\n"); show(scale_test)
save_tab(scale_test, "04d_season_scale_test")

# Persistence 2025 -> 2026 of client-level excess (May = control)
pers <- panel |> filter(moy %in% c(2, 5, 8, 12)) |>
  select(profile_id, employment_status, moy, year, excess) |>
  pivot_wider(names_from = year, values_from = excess, names_prefix = "y")
persistence <- bind_rows(
  pers |> group_by(moy) |> summarise(group = "all", n = n(), spearman = cor(y2025, y2026, method = "spearman")),
  pers |> filter(employment_status %in% c("employed", "self_employed")) |>
    group_by(moy, group = as.character(employment_status)) |>
    summarise(n = n(), spearman = cor(y2025, y2026, method = "spearman"), .groups = "drop")) |>
  mutate(month = month.abb[moy]) |> select(month, group, n, spearman_2025_vs_2026 = spearman)
cat("\nPersistence 2025 -> 2026 (May = control):\n"); show(persistence)
save_tab(persistence, "04d_season_persistence")

# Event structure
sdw <- client_static |> select(profile_id, sd_reg_within)
events <- panel |> left_join(sdw, by = "profile_id") |>
  mutate(z = excess / sd_reg_within) |>
  group_by(employment_status, month_type) |>
  summarise(n = n(), share_outflow_event = mean(z < -3), share_inflow_event = mean(z > 3),
            mean_excess_chf = mean(excess), median_excess_chf = median(excess),
            mean_excess_non_event_chf = mean(excess[abs(z) <= 3]),
            sd_excess_non_event_chf = sd(excess[abs(z) <= 3]),
            median_outflow_event_chf = median(excess[z < -3]), .groups = "drop")
cat("\nIrregular-flow events (|excess| > 3 x client regular-month SD):\n"); show(events)
save_tab(events, "04d_irregular_events")

# December bonus (same rule as ml/train.py: excess > 3 SD and > 5% of income)
dec <- panel |> filter(moy == 12) |> left_join(sdw, by = "profile_id") |>
  mutate(bonus = excess > 3 * sd_reg_within & excess > 0.05 * income, bonus_share = excess / income)
bpy <- dec |> select(profile_id, employment_status, year, bonus) |>
  pivot_wider(names_from = year, values_from = bonus, names_prefix = "b")
bonus <- dec |> group_by(employment_status) |>
  summarise(client_decembers = n(), p_bonus = mean(bonus),
            size_p10 = quantile(bonus_share[bonus], 0.10), size_p25 = quantile(bonus_share[bonus], 0.25),
            size_median = median(bonus_share[bonus]), size_p75 = quantile(bonus_share[bonus], 0.75),
            size_p90 = quantile(bonus_share[bonus], 0.90),
            size_mean = mean(bonus_share[bonus]),
            no_bonus_dec_excess_median_chf = median(excess[!bonus]),
            no_bonus_dec_excess_sd_chf = sd(excess[!bonus])) |>
  left_join(bpy |> group_by(employment_status) |>
              summarise(p_bonus_2026_given_2025 = mean(b2026[b2025]),
                        p_bonus_2026_given_no_2025 = mean(b2026[!b2025])), by = "employment_status")
cat("\nDecember bonus (size as share of monthly income):\n"); show(bonus)
save_tab(bonus, "04d_december_bonus")
bonus_size_cor <- dec |> filter(bonus) |> group_by(profile_id) |> filter(n() == 2) |>
  summarise(s25 = bonus_share[year == 2025], s26 = bonus_share[year == 2026])
cat("Bonus size persistence (clients with bonus both years, n =", nrow(bonus_size_cor), "): Spearman",
    round(cor(bonus_size_cor$s25, bonus_size_cor$s26, method = "spearman"), 3), "\n")
bonus_deciles <- dec |> filter(bonus, employment_status %in% c("employed", "self_employed")) |>
  group_by(employment_status) |>
  reframe(quantile = seq(0.05, 0.95, by = 0.10), size_share_income = quantile(bonus_share, seq(0.05, 0.95, by = 0.10)))
save_tab(bonus_deciles, "04d_bonus_size_quantiles")
# Persistence test: is P(bonus in 2026) higher for clients who had one in 2025? (Fisher exact test)
bonus_persist_test <- bpy |> filter(employment_status %in% c("employed", "self_employed")) |>
  group_by(employment_status) |>
  summarise(odds_ratio = fisher.test(table(b2025, b2026))$estimate, p_value = fisher.test(table(b2025, b2026))$p.value)
cat("Bonus persistence (Fisher exact, 2025 vs 2026):\n"); show(bonus_persist_test)
save_tab(bonus_persist_test, "04d_bonus_persistence_test")
client_static <- client_static |>
  left_join(dec |> group_by(profile_id) |> summarise(n_bonus_years = sum(bonus)), by = "profile_id")

section("4e. TEMPORAL DEPENDENCE & DRIFT")
resid_panel <- panel |>
  group_by(employment_status, moy) |> mutate(r = excess - mean(excess)) |> ungroup() |>
  arrange(profile_id, t)
acf_tab <- bind_rows(lapply(1:12, function(k) {
  d <- resid_panel |> group_by(profile_id) |> mutate(r_lag = lag(r, k), ex_lag = lag(excess, k)) |> ungroup()
  data.frame(lag = k, acf_season_adjusted = cor(d$r, d$r_lag, use = "complete.obs"),
             acf_raw_excess = cor(d$excess, d$ex_lag, use = "complete.obs"))
}))
show(acf_tab)
save_tab(acf_tab, "04e_acf")
acf_reg <- resid_panel |> filter(regular) |> group_by(profile_id) |>
  mutate(r_lag = lag(r, 1), gap = t - lag(t, 1)) |> ungroup() |> filter(gap == 1)
cat("Lag-1 ACF using regular-month pairs only:", round(cor(acf_reg$r, acf_reg$r_lag), 3), "\n")

drift <- client_static |> group_by(employment_status) |>
  summarise(n = n(), yoy_change_mean_chf = mean(yoy_reg_change),
            yoy_change_se = sd(yoy_reg_change) / sqrt(n()), t_value = yoy_change_mean_chf / yoy_change_se,
            yoy_change_share_income = mean(yoy_reg_change / income))
cat("\nYoY change in regular-month net flow (2026 - 2025):\n"); show(drift)
save_tab(drift, "04e_yoy_drift")
drift_lm <- lm(yoy_reg_change ~ 0 + employment_status + employment_status:I(income / 1000), data = client_static)
save_tab(coef_tab(drift_lm, "yoy_reg_change ~ 0 + emp + emp:income_k"), "04e_yoy_drift_by_income")
cat("Drift ~ emp + emp:income_k:\n"); print(round(summary(drift_lm)$coefficients, 3))

section("4f. VOLATILITY & SHOCK SHAPE")
vol_lm <- lm(log(sd_reg_within) ~ employment_status + log(income), data = client_static)
cat("log(regular-month SD) ~ emp + log(income), R2 =", round(summary(vol_lm)$r.squared, 3), "\n")
print(round(summary(vol_lm)$coefficients, 3))
save_tab(coef_tab(vol_lm, "log(sd_reg_within) ~ emp + log(income)"), "04f_volatility_regression")
vol_by_emp <- client_static |> group_by(employment_status) |>
  summarise(sd_median = median(sd_reg_within), sd_p10 = quantile(sd_reg_within, 0.1),
            sd_p90 = quantile(sd_reg_within, 0.9), cv_vs_income_median = median(sd_reg_within / income))
show(vol_by_emp)
save_tab(vol_by_emp, "04f_volatility_by_employment")

# Client-specific shock scale sigma_i, shrunk on the log scale toward the regression prediction.
# Sampling variance of log(sample SD) ~ 1 / (2 df), df = 18 regular months - 2 year means = 16.
var_log_sd_sampling <- 1 / (2 * 16)
tau2 <- max(summary(vol_lm)$sigma^2 - var_log_sd_sampling, 0)
w_shrink <- tau2 / (tau2 + var_log_sd_sampling)
client_sigma <- client_static |>
  transmute(profile_id, sigma_reg_empirical = sd_reg_within,
            sigma_reg_pred = exp(fitted(vol_lm)),
            sigma_reg_shrunk = exp(w_shrink * log(sd_reg_within) + (1 - w_shrink) * fitted(vol_lm)))
cat(sprintf("\nlog-sigma: residual var %.4f = true between-client var %.4f + sampling var %.4f -> shrinkage weight on own data %.2f\n",
            summary(vol_lm)$sigma^2, tau2, var_log_sd_sampling, w_shrink))
# For simulation: a sample SD is biased low on the log scale, E[log s] = log sigma + (digamma(df/2) - log(df/2)) / 2
# (chi-square), and the regression on log(s) inherits the same bias, so the shrunk sigma does too. sd() above
# divides by n - 1 = 17 while df = 16, a further factor sqrt(16/17). sigma_reg_sim = shrunk sigma with both undone
# (~ +6%); the frontend's Monte Carlo uses it (backtest: 80% coverage 0.76 -> 0.78 with the 2025-only fit).
log_sd_bias <- function(df) (digamma(df / 2) - log(df / 2)) / 2
sim_factor_full <- exp(-log_sd_bias(16) - 0.5 * log(16 / 17))
client_sigma$sigma_reg_sim <- client_sigma$sigma_reg_shrunk * sim_factor_full
cat(sprintf("sigma_reg_sim = sigma_reg_shrunk x %.4f (small-sample bias of log SD undone)\n", sim_factor_full))

bart <- resid_panel |> filter(regular) |> group_by(employment_status) |>
  summarise(n_clients = n_distinct(profile_id),
            bartlett_K2 = unname(bartlett.test(r ~ factor(profile_id))$statistic),
            bartlett_df = unname(bartlett.test(r ~ factor(profile_id))$parameter),
            bartlett_p = bartlett.test(r ~ factor(profile_id))$p.value)
cat("\nBartlett: equal regular-month variance across clients within group?\n"); show(bart)
save_tab(bart, "04f_bartlett_client_variance")

kurt <- function(x) mean((x - mean(x))^4) / mean((x - mean(x))^2)^2 - 3
skew <- function(x) mean((x - mean(x))^3) / mean((x - mean(x))^2)^1.5
shock <- resid_panel |> filter(regular) |> group_by(employment_status) |> mutate(z = r / sd(r)) |> ungroup()
shock_c <- resid_panel |> filter(regular) |> group_by(profile_id) |> mutate(zc = r / sd(r)) |> ungroup()
shape <- bind_rows(
  shock |> group_by(group = as.character(employment_status)) |>
    summarise(n = n(), skewness = skew(z), excess_kurtosis = kurt(z), share_abs_z_gt3 = mean(abs(z) > 3)),
  shock |> summarise(group = "all (group-standardised)", n = n(), skewness = skew(z),
                     excess_kurtosis = kurt(z), share_abs_z_gt3 = mean(abs(z) > 3)),
  shock_c |> summarise(group = "all (client-standardised)", n = n(), skewness = skew(zc),
                       excess_kurtosis = kurt(zc), share_abs_z_gt3 = mean(abs(zc) > 3))) |>
  mutate(normal_share_abs_z_gt3 = 2 * pnorm(-3),
         implied_t_df = ifelse(excess_kurtosis > 0, 4 + 6 / excess_kurtosis, Inf))
show(shape)
save_tab(shape, "04f_shock_shape")

section("4g. GROUP DIFFERENCES (Kruskal-Wallis)")
kw <- function(v, g) {
  k <- kruskal.test(client_static[[v]] ~ client_static[[g]])
  n <- nrow(client_static); kk <- length(unique(client_static[[g]]))
  data.frame(variable = v, grouping = g, H = unname(k$statistic), df = unname(k$parameter),
             p_value = k$p.value, epsilon_squared = (unname(k$statistic) - kk + 1) / (n - kk))
}
kw_vars <- c("income", "rent", "cash_t0", "investments", "debt", "nf_mean", "other_reg_mean",
             "sd_reg_within", "dec_excess", "feb_excess", "aug_excess")
group_tests <- bind_rows(lapply(c("employment_status", "household_type", "canton", "city", "age_band"),
                                function(g) bind_rows(lapply(kw_vars, kw, g = g))))
cat("Effect sizes (epsilon^2) by grouping:\n")
show(group_tests |> select(variable, grouping, epsilon_squared) |>
       pivot_wider(names_from = grouping, values_from = epsilon_squared) |>
       mutate(across(where(is.numeric), ~ round(.x, 3))))
save_tab(group_tests, "04g_group_tests")

inv_lm <- lm(log1p(investments) ~ age_at_start + employment_status + log(income) + log(cash_t0), data = client_static)
m_city <- lm(other_reg_mean ~ employment_status + city, data = client_static)
m_cant <- lm(other_reg_mean ~ employment_status + canton, data = client_static)
cat("\nother_reg_mean R2: employment only", round(summary(lm(other_reg_mean ~ employment_status, client_static))$r.squared, 3),
    "| + canton", round(summary(m_cant)$r.squared, 3), "| + city", round(summary(m_city)$r.squared, 3), "\n")
city_tab <- client_static |> group_by(city, canton) |>
  summarise(n = n(), other_reg_mean = mean(other_reg_mean), rent_mean = mean(rent), .groups = "drop") |>
  arrange(other_reg_mean)
show(city_tab)
save_tab(city_tab, "04g_nonrent_outflow_by_city")

cat("\nlog1p(investments) ~ age + emp + log(income) + log(cash_t0): R2 =", round(summary(inv_lm)$r.squared, 3), "\n")
print(round(summary(inv_lm)$coefficients, 4))
save_tab(coef_tab(inv_lm, "log1p(investments) ~ age + emp + log(income) + log(cash_t0)"), "04g_investments_regression")
loan_glm <- glm(has_loan ~ employment_status + age_at_start + log(income), family = binomial, data = client_static)
cat("\nhas_loan ~ emp + age + log(income) (logit): deviance drop",
    round(loan_glm$null.deviance - loan_glm$deviance, 2), "on", loan_glm$df.null - loan_glm$df.residual, "df, p =",
    signif(pchisq(loan_glm$null.deviance - loan_glm$deviance, loan_glm$df.null - loan_glm$df.residual, lower.tail = FALSE), 3), "\n")

section("4h. NEGATIVE-CASH CLIENTS")
neg <- client_static |> group_by(employment_status) |>
  summarise(n = n(), n_ever_negative = sum(months_negative > 0), share = mean(months_negative > 0),
            median_first_negative_month = median(first_negative_t, na.rm = TRUE),
            median_cash_t0_if_negative = median(cash_t0[months_negative > 0]),
            n_negative_nf_mean = sum(nf_mean < 0))
show(neg)
save_tab(neg, "04h_negative_cash")
cat("Ever-negative clients with nf_mean >= 0:", sum(client_static$months_negative > 0 & client_static$nf_mean >= 0), "\n")

section("4i. GOALS (descriptive)")
goals_d <- go |>
  inner_join(client_static |> select(profile_id, income, nf_mean, cash_t0), by = "profile_id") |>
  mutate(target_to_income = target_amount_chf / income,
         years_of_current_saving = ifelse(nf_mean > 0, target_amount_chf / (12 * nf_mean), Inf))
goals_tab <- goals_d |> group_by(goal_name) |>
  summarise(n = n(), share_high = mean(priority == "high"), target_median = median(target_amount_chf),
            target_to_income_median = median(target_to_income),
            years_of_saving_median = median(years_of_current_saving),
            share_no_positive_flow = mean(!is.finite(years_of_current_saving)),
            share_target_le_cash_t0 = mean(target_amount_chf <= cash_t0),
            date_min = min(target_date), date_max = max(target_date))
show(goals_tab)
save_tab(goals_tab, "04i_goals")

# ---- 5. Mixed model (one pooled model for all clients) ---------------------------
section("5. MIXED MODEL (one pooled model for all clients)")
if (!HAS_LME4) stop("Section 5 needs lme4. Run first: Rscript R/install_packages.R", call. = FALSE)
suppressPackageStartupMessages(library(lme4))
ctrl <- lmerControl(optimizer = "bobyqa", check.conv.singular = "ignore")
BONUS_GROUPS <- c("employed", "self_employed")

# Model (outflow scale): other_outflow_it = base[emp, month] + city_c + bonus_it + u_i + e_it
#   base[emp, month]: employment level + month effects (structure chosen by BIC in 5.1; incl. a
#   self-employed December term, see self_dec below)
#   net_it = income_i - rent_i - other_outflow_it  (income and rent enter with coefficient 1, see 4c)
#   bonus_it = -beta_g * income_i in a detected bonus December (employed / self-employed only; 4d)
#   u_i ~ N(0, sigma_u^2) client offset; e_it ~ N(0, sigma^2[emp, variance type]) (FGLS weights)
# The December bonus enters as a detected mixture component, so the non-bonus December level and
# noise are estimated cleanly, and the bonus incidence/size are taken from 4d.
bonus_flags <- dec |> select(profile_id, year, bonus_flag = bonus)
mm <- panel |>
  left_join(bonus_flags, by = c("profile_id", "year")) |>
  mutate(bonus_flag = bonus_flag & moy == 12 & employment_status %in% BONUS_GROUPS,
         pid = factor(profile_id), emp = employment_status, city = factor(city), moy_f = factor(moy),
         student = as.numeric(emp == "student"), inc_k = income / 1000,
         bonus_inc_employed = (bonus_flag & emp == "employed") * inc_k,
         bonus_inc_self     = (bonus_flag & emp == "self_employed") * inc_k,
         # Self-employed non-bonus Decembers still sit ~+700 CHF above regular months: the 3-SD rule
         # misses smaller bonuses when noise is ~1,500 CHF (detection is censored) -> one CHF-flat term.
         self_dec = as.numeric(emp == "self_employed" & moy == 12),
         var_type = factor(ifelse(bonus_flag, "Dec_bonus", as.character(month_type)),
                           levels = c("regular", "Feb", "Aug", "Dec", "Dec_bonus")),
         stratum = interaction(emp, var_type, drop = TRUE, sep = "|"))

# Feasible GLS: iterate fit -> residual variance per stratum -> refit with weights 1/variance.
fit_fgls <- function(f, data, iter = 3) {
  ff <- update(f, . ~ . + (1 | pid))
  data$w <- 1
  for (i in seq_len(iter)) {
    fit <- lmer(ff, data = data, weights = w, REML = TRUE, control = ctrl)
    s2  <- tapply(residuals(fit), data$stratum, var)
    if (i < iter) data$w <- unname(mean(s2) / s2[as.character(data$stratum)])
  }
  list(fit = fit, sigma = sqrt(s2), w = data$w)
}

# 5.1 Mean structure, chosen by BIC (ML fits, weights held fixed from the richest model)
bterms <- "bonus_inc_employed + bonus_inc_self + self_dec"
forms <- lapply(c(M0_emp_x_month_no_city     = "emp + emp:moy_f",
                  M1_city_common_months      = "emp + city + moy_f",
                  M2_city_common_plus_student = "emp + city + moy_f + student:moy_f",
                  M3_city_emp_x_month        = "emp + city + emp:moy_f"),
                function(rhs) as.formula(paste("other_outflow ~", rhs, "+", bterms)))
t0 <- Sys.time()
mm$w <- fit_fgls(forms$M3_city_emp_x_month, mm)$w
selection <- bind_rows(lapply(names(forms), function(nm) {
  fit <- lmer(update(forms[[nm]], . ~ . + (1 | pid)), data = mm, weights = w, REML = FALSE, control = ctrl)
  data.frame(model = nm, n_fixed = length(fixef(fit)), logLik = as.numeric(logLik(fit)), AIC = AIC(fit), BIC = BIC(fit))
})) |> mutate(dBIC = BIC - min(BIC), dAIC = AIC - min(AIC))
show(selection)
save_tab(selection, "05_mean_structure_selection")
chosen <- selection$model[which.min(selection$BIC)]
f_mean <- forms[[chosen]]
cat("Chosen by BIC:", chosen, "\n")

# 5.2 Final fit (REML, FGLS)
fg <- fit_fgls(f_mean, mm)
best <- fg$fit
cat("lme4 fits:", round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1), "s\n")
# lmer has no native adjusted R-squared.  Report the usual residual-based,
# conditional pseudo-R2 (including client effects), adjusted for fixed terms.
n_model <- nobs(best)
p_fixed <- length(fixef(best))
r2_conditional <- 1 - sum(residuals(best)^2) / sum((mm$other_outflow - mean(mm$other_outflow))^2)
r2_adjusted <- 1 - (1 - r2_conditional) * (n_model - 1) / (n_model - p_fixed - 1)
model_fit <- data.frame(n = n_model, fixed_terms = p_fixed,
                        r_squared = r2_conditional, r_squared_adjusted = r2_adjusted)
cat("Conditional pseudo-R2 (adjusted):", round(r2_adjusted, 3), "\n")
save_tab(model_fit, "05_model_fit")
vc <- as.data.frame(VarCorr(best))
sigma_u <- vc$sdcor[vc$grp == "pid"]
sigma_tab <- data.frame(stratum = names(fg$sigma), sigma_eps_chf = unname(fg$sigma)) |>
  separate(stratum, into = c("employment_status", "var_type"), sep = "\\|")
sigma_wide <- sigma_tab |> pivot_wider(names_from = var_type, values_from = sigma_eps_chf) |>
  arrange(emp_f(employment_status))
cat("\nsigma_u (between-client SD of outflow, CHF):", round(sigma_u, 1), "\n")
cat("Within-client residual SD by employment x variance type (CHF):\n")
show(sigma_wide |> mutate(across(where(is.numeric), round)))
save_tab(sigma_wide, "05_sigma_eps_by_stratum")

s <- coef(summary(best))
fixef_tab <- data.frame(term = rownames(s), estimate = s[, 1], std_error = s[, 2], t_value = s[, 3], row.names = NULL)
save_tab(fixef_tab, "05_fixed_effects")
cat("\nNon-month fixed effects:\n"); show(fixef_tab |> filter(!grepl("moy_f", term)))
save_tab(data.frame(component = c("sigma_u (client intercept)", "sigma (unit-weight residual)"),
                    sd_chf = c(sigma_u, sigma(best))), "05_variance_components")

# 5.3 Base outflow per employment x month at the population-average city, and city offsets (with SEs)
beta <- fixef(best); V <- as.matrix(vcov(best))
has_city <- "city" %in% all.vars(f_mean)
# From any fit of f_mean (the full fit here, the 2025-only fit in 6b):
#   base[emp, month]  at the population-average city, non-bonus month (seasonal effects included)
#   city offsets      vs the population-average city
#   student x month   the student-specific month effects (December = reference 0): the tuition-like Feb/Sep peaks
base_city <- function(fit, data) {
  beta <- fixef(fit); V <- as.matrix(vcov(fit))
  ca <- list(emp = contrasts(data$emp), moy_f = contrasts(data$moy_f))
  if (has_city) ca$city <- contrasts(data$city)
  city_share <- table(as.character(data$city[!duplicated(data$pid)])) / nlevels(data$pid)
  grid <- expand.grid(emp = EMP, moy = 1:12, city = levels(data$city), stringsAsFactors = FALSE) |>
    mutate(emp = factor(emp, levels = EMP), city = factor(city, levels = levels(data$city)),
           moy_f = factor(moy, levels = 1:12), student = as.numeric(emp == "student"),
           bonus_inc_employed = 0, bonus_inc_self = 0, self_dec = as.numeric(emp == "self_employed" & moy == 12))
  X <- model.matrix(delete.response(terms(f_mean)), grid, contrasts.arg = ca)[, names(beta), drop = FALSE]
  key <- paste(grid$emp, grid$moy, sep = "|")
  Xbar <- rowsum(X * as.numeric(city_share[as.character(grid$city)]), key)
  base <- data.frame(key = rownames(Xbar), outflow_chf = as.vector(Xbar %*% beta),
                     se = sqrt(rowSums((Xbar %*% V) * Xbar))) |>
    separate(key, into = c("employment_status", "moy"), sep = "\\|", convert = TRUE) |>
    arrange(emp_f(employment_status), moy)
  city_off <- NULL
  if (has_city) {
    ref_rows <- which(grid$emp == "employed" & grid$moy == 1)
    D <- sweep(X[ref_rows, , drop = FALSE], 2, Xbar["employed|1", ])
    city_off <- data.frame(city = as.character(grid$city[ref_rows]), offset_chf = as.vector(D %*% beta),
                           se = sqrt(rowSums((D %*% V) * D)),
                           client_share = as.numeric(city_share[as.character(grid$city[ref_rows])])) |>
      arrange(offset_chf)
  }
  st_terms <- paste0("moy_f", 1:12, ":student")
  student_month <- data.frame(moy = 1:12, effect_chf = ifelse(st_terms %in% names(beta), beta[st_terms], 0))
  stopifnot(sum(student_month$effect_chf == 0) <= 1)  # exactly one month is the (collinear) reference
  list(base = base, city_off = city_off, student_month = student_month)
}
bc <- base_city(best, mm)
base <- bc$base
cat("\nBase non-rent outflow, non-bonus month, population-average city (CHF):\n")
show(base |> select(-se) |> pivot_wider(names_from = moy, values_from = outflow_chf, names_prefix = "m") |>
       arrange(emp_f(employment_status)) |> mutate(across(where(is.numeric), round)))
save_tab(base, "05_base_outflow_by_month")
if (has_city) {
  city_off <- bc$city_off
  cat("\nCity offsets vs population-average city (CHF/month):\n"); show(city_off)
  save_tab(city_off, "05_city_offsets")
}
bonus_slope <- data.frame(employment_status = BONUS_GROUPS,
                          mean_bonus_share_lmm = -beta[c("bonus_inc_employed", "bonus_inc_self")] / 1000,
                          se = sqrt(diag(V)[c("bonus_inc_employed", "bonus_inc_self")]) / 1000) |>
  left_join(bonus |> transmute(employment_status = as.character(employment_status), p_bonus, mean_bonus_share_empirical = size_mean),
            by = "employment_status")
cat("\nDecember bonus given a bonus (share of income): LMM slope vs empirical mean:\n"); show(bonus_slope)
save_tab(bonus_slope, "05_bonus_given_bonus")

# 5.4 Per-client effects (personalisation)
re <- ranef(best, condVar = TRUE)$pid
reg_months <- setdiff(1:12, IRREGULAR_MONTHS)
base_reg <- base |> filter(moy %in% reg_months, !(employment_status == "student" & moy == 9)) |>  # Sep is a tuition-like month for students
  group_by(employment_status) |>
  summarise(base_regular = mean(outflow_chf))
client_effects <- prof |>
  transmute(profile_id, employment_status = as.character(employment_status), city = as.character(city), income, rent) |>
  left_join(data.frame(profile_id = rownames(re), u_outflow_chf = re[, 1]), by = "profile_id") |>
  left_join(base_reg, by = "employment_status") |>
  left_join(if (has_city) city_off |> select(city, city_offset = offset_chf) else data.frame(city = levels(mm$city), city_offset = 0),
            by = "city") |>
  mutate(regular_outflow_hat_chf = base_regular + city_offset + u_outflow_chf,
         regular_net_hat_chf = income - rent - regular_outflow_hat_chf) |>
  select(-base_regular, -city_offset) |>
  left_join(client_sigma |> select(-sigma_reg_sim), by = "profile_id") |>
  # posterior SD of u_i: how uncertain each client's offset is (the frontend draws it once per simulated future)
  left_join(data.frame(profile_id = rownames(re), u_postsd_chf = sqrt(attr(re, "postVar")[1, 1, ])), by = "profile_id") |>
  left_join(client_sigma |> select(profile_id, sigma_reg_sim_chf = sigma_reg_sim), by = "profile_id")
write.csv(client_effects, file.path(OUT, "client_effects.csv"), row.names = FALSE)
cat("\nclient_effects.csv written (BLUP u_i, personalised regular outflow, shrunk sigma_i). sd(BLUP) =",
    round(sd(client_effects$u_outflow_chf), 1), "CHF\n")
cat("Check: cor(regular_net_hat, observed nf_reg_mean) =",
    round(cor(client_effects$regular_net_hat_chf, client_static$nf_reg_mean[match(client_effects$profile_id, client_static$profile_id)]), 4), "\n")

mm$resid <- residuals(best)
acf_model <- mm |> arrange(profile_id, t) |> group_by(profile_id) |>
  mutate(r_lag = lag(resid)) |> ungroup() |> filter(var_type == "regular")
cat("Lag-1 autocorrelation of model residuals (regular months):",
    round(cor(acf_model$resid, acf_model$r_lag, use = "complete.obs"), 3), "\n")

# ---- 5b. Out-of-sample check: fit 2025, predict 2026 (analytical, no simulation) ----
section("5b. OUT-OF-SAMPLE: fit on 2025, predict 2026 (analytical predictive distributions)")
# Predictive distribution of each 2026 month: Normal(mu, s^2 + Var(u_i | data)), and for December in
# bonus groups the exact mixture (1-p) N(mu, sd^2) + p * mean_k N(mu + size_k * income, sd^2) with p and
# the empirical sizes taken from 2025 only. Calibration is judged by PIT values (should be ~Uniform).
train <- mm |> filter(year == 2025); test <- mm |> filter(year == 2026)
fg_tr  <- fit_fgls(f_mean, train)
fit_tr <- fg_tr$fit
sig_tr <- data.frame(stratum = names(fg_tr$sigma), s = unname(fg_tr$sigma)) |>
  separate(stratum, into = c("emp_chr", "vt"), sep = "\\|")
rr <- ranef(fit_tr, condVar = TRUE)$pid
cvu <- data.frame(profile_id = rownames(rr), v_u = attr(rr, "postVar")[1, 1, ])
bon_tr <- dec |> filter(year == 2025, employment_status %in% BONUS_GROUPS) |>
  group_by(employment_status) |> summarise(p = mean(bonus), sizes = list(bonus_share[bonus]))
pit_mix <- function(x, mu, sd, p, sizes, inc) (1 - p) * pnorm((x - mu) / sd) + p * mean(pnorm((x - mu - sizes * inc) / sd))

test_nb <- test |> mutate(bonus_inc_employed = 0, bonus_inc_self = 0)
d <- test |>
  mutate(mu_other = predict(fit_tr, newdata = test_nb, re.form = NULL),
         emp_chr = as.character(emp), vt = as.character(month_type)) |>
  left_join(sig_tr, by = c("emp_chr", "vt")) |>
  left_join(cvu, by = "profile_id") |>
  mutate(mu_net = income - rent - mu_other, sd_net = sqrt(s^2 + v_u),
         pit = pnorm((net - mu_net) / sd_net), point = mu_net)
ann <- d |> group_by(profile_id, emp_chr, income) |>
  summarise(actual = sum(net), M = sum(mu_net), S = sqrt(sum(s^2) + 144 * first(v_u)), .groups = "drop") |>
  mutate(pit = pnorm((actual - M) / S), point = M) |>
  left_join(train |> group_by(profile_id) |> summarise(naive = sum(net)), by = "profile_id")
for (g in BONUS_GROUPS) {
  pg <- bon_tr$p[bon_tr$employment_status == g]; sz <- bon_tr$sizes[[which(bon_tr$employment_status == g)]]
  i1 <- which(d$moy == 12 & d$emp_chr == g)
  d$pit[i1]   <- vapply(i1, function(i) pit_mix(d$net[i], d$mu_net[i], d$sd_net[i], pg, sz, d$income[i]), numeric(1))
  d$point[i1] <- d$mu_net[i1] + pg * mean(sz) * d$income[i1]
  i2 <- which(ann$emp_chr == g)
  ann$pit[i2]   <- vapply(i2, function(i) pit_mix(ann$actual[i], ann$M[i], ann$S[i], pg, sz, ann$income[i]), numeric(1))
  ann$point[i2] <- ann$M[i2] + pg * mean(sz) * ann$income[i2]
}
cov_tab <- function(x) c(coverage80 = mean(x$pit >= 0.1 & x$pit <= 0.9), coverage50 = mean(x$pit >= 0.25 & x$pit <= 0.75))
oos_overall <- data.frame(
  horizon = c("monthly", "annual total"),
  n = c(nrow(d), nrow(ann)),
  coverage80 = c(cov_tab(d)[1], cov_tab(ann)[1]), coverage50 = c(cov_tab(d)[2], cov_tab(ann)[2]),
  rmse_model = c(sqrt(mean((d$net - d$point)^2)), sqrt(mean((ann$actual - ann$point)^2))),
  rmse_naive_repeat_2025 = c(NA, sqrt(mean((ann$actual - ann$naive)^2))),
  mean_bias_actual_minus_pred = c(mean(d$net - d$point), mean(ann$actual - ann$point)))
show(oos_overall)
oos_group <- d |> group_by(employment_status = emp_chr, month_type = vt) |>
  summarise(n = n(), coverage80 = mean(pit >= 0.1 & pit <= 0.9), coverage50 = mean(pit >= 0.25 & pit <= 0.75),
            mean_bias_chf = mean(net - point), rmse = sqrt(mean((net - point)^2)), .groups = "drop") |>
  arrange(emp_f(employment_status), month_type)
oos_annual <- ann |> group_by(employment_status = emp_chr) |>
  summarise(n = n(), coverage80 = mean(pit >= 0.1 & pit <= 0.9), coverage50 = mean(pit >= 0.25 & pit <= 0.75),
            mean_bias_chf = mean(actual - point), rmse_model = sqrt(mean((actual - point)^2)),
            rmse_naive = sqrt(mean((actual - naive)^2))) |> arrange(emp_f(employment_status))
pit_deciles <- data.frame(decile = 1:10,
                          monthly_share = as.vector(table(cut(d$pit, seq(0, 1, 0.1), include.lowest = TRUE))) / nrow(d),
                          annual_share = as.vector(table(cut(ann$pit, seq(0, 1, 0.1), include.lowest = TRUE))) / nrow(ann))
cat("\nBy employment x month type (monthly):\n"); show(oos_group)
cat("\nAnnual totals by employment:\n"); show(oos_annual)
cat("\nPIT decile shares (calibrated = 0.10 each):\n"); show(pit_deciles)
save_tab(oos_overall, "05b_oos_overall"); save_tab(oos_group, "05b_oos_by_group")
save_tab(oos_annual, "05b_oos_annual"); save_tab(pit_deciles, "05b_oos_pit_deciles")

# ---- 6. Model parameters (machine-readable) & inventory -------------------------
section("6. MODEL PARAMETERS")
P <- function(block, parameter, value, se = NA_real_, employment_status = "all", month = NA_integer_,
              key = NA_character_, unit = "CHF/month", source = "") {
  data.frame(block = block, parameter = parameter, employment_status = employment_status, month = month,
             key = key, value = value, se = se, unit = unit, source = source)
}
reg_sd_excess <- panel |> filter(regular) |> group_by(employment_status = as.character(employment_status)) |>
  summarise(sd_regular_excess = sd(excess))
k_tab <- sigma_tab |> group_by(employment_status) |>
  mutate(k = sigma_eps_chf / sigma_eps_chf[var_type == "regular"]) |> ungroup() |>
  filter(var_type %in% c("Feb", "Aug", "Dec"))
vol_coef <- coef(vol_lm)
params <- bind_rows(
  P("mean", "base_nonrent_outflow", base$outflow_chf, base$se, base$employment_status, base$moy,
    unit = "CHF/month", source = paste0("LMM ", chosen, ": population-average city, non-bonus month")),
  if (has_city) P("mean", "city_offset", city_off$offset_chf, city_off$se, key = city_off$city,
                  source = "LMM: city fixed effect, centred on population-average city"),
  P("mean", "student_month_effect", bc$student_month$effect_chf, NA, "student", bc$student_month$moy,
    source = "LMM: student x calendar-month effect inside base (December = reference 0); Feb/Sep = tuition-like peaks"),
  P("bonus", "p_bonus", bonus$p_bonus, NA, as.character(bonus$employment_status), 12L, unit = "probability",
    source = "Dec excess > 3 SD and > 5% of income; independent across years (Fisher test 4d)"),
  P("bonus", "bonus_size_given_bonus_mean", bonus_slope$mean_bonus_share_lmm, bonus_slope$se, bonus_slope$employment_status, 12L,
    unit = "share of monthly income", source = "LMM slope on detected bonus Decembers"),
  P("bonus", "bonus_size_quantile", bonus_deciles$size_share_income, NA, bonus_deciles$employment_status, 12L,
    key = paste0("q", round(100 * bonus_deciles$quantile)), unit = "share of monthly income",
    source = "empirical; sample uniformly from these to draw a bonus size"),
  P("random_effects", "sigma_u", sigma_u, source = "LMM client random intercept SD (prior for new clients)"),
  P("shocks", "sigma_eps", sigma_tab$sigma_eps_chf, NA, sigma_tab$employment_status, NA, key = sigma_tab$var_type,
    source = "FGLS residual SD by employment x variance type ('Dec_bonus' = bonus-size noise: do NOT use, size is drawn)"),
  P("shocks", "k_multiplier_vs_regular", k_tab$k, NA, k_tab$employment_status, NA, key = k_tab$var_type, unit = "ratio",
    source = "sigma_it = sigma_i * k[emp, month type]"),
  P("shocks", "log_sigma_i_coef", unname(vol_coef), NA, key = names(vol_coef), unit = "log-scale coefficient",
    source = "log(sigma_i) ~ emp + log(income): prediction for NEW clients"),
  P("shocks", "sigma_i_shrinkage_weight", w_shrink, unit = "weight", source = "weight on own empirical log-sigma (known clients)"),
  P("shocks", "acf_lag1", acf_tab$acf_season_adjusted[1], unit = "correlation",
    source = "within-client, season-adjusted (includes -1/(n-1) centring artefact)"),
  P("shocks", "excess_kurtosis_client_standardised", kurt(shock_c$zc), unit = "-", source = "~0 -> Normal given sigma_i"),
  P("feb_aug_events_optional", "p_outflow_event", events$share_outflow_event, NA, as.character(events$employment_status),
    NA, key = as.character(events$month_type), unit = "probability",
    source = "optional refinement: |excess| > 3 client SD; replaces Gaussian Feb/Aug widening with a lump outflow"),
  P("feb_aug_events_optional", "median_outflow_event", events$median_outflow_event_chf, NA, as.character(events$employment_status),
    NA, key = as.character(events$month_type), unit = "CHF", source = "size of the lump outflow"),
  P("drift_not_for_use", "yoy_regular_net_change", drift$yoy_change_mean_chf, drift$yoy_change_se,
    as.character(drift$employment_status), unit = "CHF/month per year", source = "2 data points per client: do not extrapolate")
) |> filter(!is.na(value))
write.csv(params |> mutate(across(c(value, se), ~ signif(.x, 6))), file.path(OUT, "model_parameters.csv"), row.names = FALSE)
cat("model_parameters.csv:", nrow(params), "rows (blocks:", paste(unique(params$block), collapse = ", "), ")\n")
show(params |> filter(!block %in% c("mean")) |> select(-source))

# ---- 6b. The same parameters re-estimated on 2025 ONLY (for the frontend's backtest on 2026) ----
section("6b. PARAMETERS RE-ESTIMATED ON 2025 ONLY (frontend backtest)")
# The frontend tests its simulator by predicting 2026 from 2025. model_parameters.csv uses both years,
# so it would have seen the answer. Here everything that feeds a forecast is recomputed from 2025 months
# alone: regular-month SD, bonus detection, the mean model, strata SDs, client effects and sigma_i shrinkage.
# (The model STRUCTURE f_mean was chosen by BIC on both years; that choice is not re-made here.)
p25 <- panel |> filter(year == 2025L)
sd25 <- p25 |> group_by(profile_id) |> summarise(sd_reg_within = sd(excess[regular]), n_reg = sum(regular), .groups = "drop")
stopifnot(nrow(sd25) == 1200, all(sd25$n_reg == 9), all(is.finite(log(sd25$sd_reg_within))))
dec25 <- p25 |> filter(moy == 12) |> left_join(sd25, by = "profile_id") |>
  mutate(bonus = excess > 3 * sd_reg_within & excess > 0.05 * income, bonus_share = excess / income)
bonus25 <- dec25 |> group_by(employment_status) |>
  summarise(p_bonus = mean(bonus), size_mean = if (any(bonus)) mean(bonus_share[bonus]) else NA_real_)
bonus_deciles25 <- dec25 |> filter(bonus, employment_status %in% BONUS_GROUPS) |> group_by(employment_status) |>
  reframe(quantile = seq(0.05, 0.95, by = 0.10), size_share_income = quantile(bonus_share, seq(0.05, 0.95, by = 0.10)))

mm25 <- mm |> filter(year == 2025L) |> select(-bonus_flag) |>
  left_join(dec25 |> select(profile_id, bonus_flag = bonus), by = "profile_id") |>
  mutate(bonus_flag = bonus_flag & moy == 12 & emp %in% BONUS_GROUPS,
         bonus_inc_employed = (bonus_flag & emp == "employed") * inc_k,
         bonus_inc_self     = (bonus_flag & emp == "self_employed") * inc_k,
         var_type = factor(ifelse(bonus_flag, "Dec_bonus", as.character(month_type)),
                           levels = c("regular", "Feb", "Aug", "Dec", "Dec_bonus")),
         stratum = interaction(emp, var_type, drop = TRUE, sep = "|"))
fg25 <- fit_fgls(f_mean, mm25)
bc25 <- base_city(fg25$fit, mm25)
vc25 <- as.data.frame(VarCorr(fg25$fit))
sigma_u25 <- vc25$sdcor[vc25$grp == "pid"]
sig25 <- data.frame(stratum = names(fg25$sigma), sigma_eps_chf = unname(fg25$sigma)) |>
  separate(stratum, into = c("employment_status", "var_type"), sep = "\\|")
k25 <- sig25 |> group_by(employment_status) |>
  mutate(k = sigma_eps_chf / sigma_eps_chf[var_type == "regular"]) |> ungroup() |>
  filter(var_type %in% c("Feb", "Aug", "Dec"))

# sigma_i from 2025: 9 regular months, minus 1 year mean -> df = 8
cs25 <- prof |> transmute(profile_id, employment_status, city = as.character(city), income, rent) |>
  left_join(sd25, by = "profile_id")
vol25 <- lm(log(sd_reg_within) ~ employment_status + log(income), data = cs25)
var_s25 <- 1 / (2 * 8)
tau2_25 <- max(summary(vol25)$sigma^2 - var_s25, 0)
w25 <- tau2_25 / (tau2_25 + var_s25)
re25 <- ranef(fg25$fit, condVar = TRUE)$pid
base_reg25 <- bc25$base |> filter(moy %in% reg_months, !(employment_status == "student" & moy == 9)) |>
  group_by(employment_status) |> summarise(base_regular = mean(outflow_chf))
client_effects25 <- cs25 |>
  left_join(data.frame(profile_id = rownames(re25), u_outflow_chf = re25[, 1],
                       u_postsd_chf = sqrt(attr(re25, "postVar")[1, 1, ])), by = "profile_id") |>
  mutate(employment_status = as.character(employment_status)) |>
  left_join(base_reg25, by = "employment_status") |>
  left_join(bc25$city_off |> select(city, city_offset = offset_chf), by = "city") |>
  mutate(regular_outflow_hat_chf = base_regular + city_offset + u_outflow_chf,
         regular_net_hat_chf = income - rent - regular_outflow_hat_chf,
         sigma_reg_empirical = sd_reg_within,
         sigma_reg_pred = exp(fitted(vol25)),
         sigma_reg_shrunk = exp(w25 * log(sd_reg_within) + (1 - w25) * fitted(vol25)),
         # 9 regular months around one mean: sd() divides by df = 8, so only the log-scale bias is undone
         sigma_reg_sim_chf = sigma_reg_shrunk * exp(-log_sd_bias(8))) |>
  select(profile_id, employment_status, city, income, rent, u_outflow_chf, regular_outflow_hat_chf, regular_net_hat_chf,
         sigma_reg_empirical, sigma_reg_pred, sigma_reg_shrunk, u_postsd_chf, sigma_reg_sim_chf)
stopifnot(nrow(client_effects25) == 1200, !anyNA(client_effects25))
write.csv(client_effects25, file.path(OUT, "client_effects_fit2025.csv"), row.names = FALSE)

src25 <- " (fit on 2025 only)"
vol_coef25 <- coef(vol25)
params25 <- bind_rows(
  P("mean", "base_nonrent_outflow", bc25$base$outflow_chf, bc25$base$se, bc25$base$employment_status, bc25$base$moy,
    source = paste0("LMM ", chosen, ": population-average city, non-bonus month", src25)),
  P("mean", "city_offset", bc25$city_off$offset_chf, bc25$city_off$se, key = bc25$city_off$city,
    source = paste0("LMM: city fixed effect, centred on population-average city", src25)),
  P("mean", "student_month_effect", bc25$student_month$effect_chf, NA, "student", bc25$student_month$moy,
    source = paste0("LMM: student x calendar-month effect inside base (December = reference 0)", src25)),
  P("bonus", "p_bonus", bonus25$p_bonus, NA, as.character(bonus25$employment_status), 12L, unit = "probability",
    source = paste0("Dec excess > 3 SD (2025 regular months) and > 5% of income", src25)),
  P("bonus", "bonus_size_given_bonus_mean", bonus25$size_mean[bonus25$employment_status %in% BONUS_GROUPS], NA,
    as.character(bonus25$employment_status[bonus25$employment_status %in% BONUS_GROUPS]), 12L,
    unit = "share of monthly income", source = paste0("empirical mean of detected bonus Decembers", src25)),
  P("bonus", "bonus_size_quantile", bonus_deciles25$size_share_income, NA, as.character(bonus_deciles25$employment_status), 12L,
    key = paste0("q", round(100 * bonus_deciles25$quantile)), unit = "share of monthly income",
    source = paste0("empirical; sample uniformly from these to draw a bonus size", src25)),
  P("random_effects", "sigma_u", sigma_u25, source = paste0("LMM client random intercept SD", src25)),
  P("shocks", "sigma_eps", sig25$sigma_eps_chf, NA, sig25$employment_status, NA, key = sig25$var_type,
    source = paste0("FGLS residual SD by employment x variance type", src25)),
  P("shocks", "k_multiplier_vs_regular", k25$k, NA, k25$employment_status, NA, key = k25$var_type, unit = "ratio",
    source = paste0("sigma_it = sigma_i * k[emp, month type]", src25)),
  P("shocks", "log_sigma_i_coef", unname(vol_coef25), NA, key = names(vol_coef25), unit = "log-scale coefficient",
    source = paste0("log(sigma_i) ~ emp + log(income)", src25)),
  P("shocks", "sigma_i_shrinkage_weight", w25, unit = "weight", source = paste0("weight on own empirical log-sigma", src25))
) |> filter(!is.na(value))
write.csv(params25 |> mutate(across(c(value, se), ~ signif(.x, 6))), file.path(OUT, "model_parameters_fit2025.csv"), row.names = FALSE)
cat("model_parameters_fit2025.csv:", nrow(params25), "rows | client_effects_fit2025.csv: 1200 clients\n")
cat("2025-only vs both years: base employed Jan", round(bc25$base$outflow_chf[1]), "vs", round(base$outflow_chf[1]),
    "| Zurich offset", round(bc25$city_off$offset_chf[bc25$city_off$city == "Zurich"]), "vs",
    round(city_off$offset_chf[city_off$city == "Zurich"]),
    "| P(bonus) employed", round(bonus25$p_bonus[bonus25$employment_status == "employed"], 3), "vs",
    round(bonus$p_bonus[bonus$employment_status == "employed"], 3),
    "| sigma_i shrinkage weight", round(w25, 2), "vs", round(w_shrink, 2), "\n")

inventory_params <- data.frame(
  parameter = c("Initial cash, investments, debt, loan rate, goals", "Reference income Y_i and rent R_i",
                "Base non-rent outflow by employment x month", "City cost-of-living offset",
                "December bonus incidence and size", "Client outflow offset u_i (BLUP) and prior SD sigma_u",
                "Client shock scale sigma_i and month-type multipliers", "Shock autocorrelation and tails",
                "Investments vs age (imputation for new users)", "Year-2 drift",
                "Income growth, wage shocks, job loss", "Inflation of spending and rent",
                "Investment return and volatility", "Cash -> investment contributions", "Interest on cash",
                "Loan payment / term / amortisation", "Taxes, pensions, retirement transition",
                "Life events", "Macro factors, cross-client correlation"),
  status = c("observed (per client)", "observed (per client, constant)", rep("estimated", 6),
             "estimated (weak, R2 0.43)", "estimated, not for use", rep("external assumption", 9)),
  where = c("client_static.csv", "client_static.csv", "model_parameters.csv: mean/base_nonrent_outflow",
            "model_parameters.csv: mean/city_offset", "model_parameters.csv: bonus",
            "client_effects.csv + random_effects/sigma_u", "client_effects.csv + shocks", "shocks",
            "tables/04g_investments_regression.csv", "drift_not_for_use", rep("scenario input", 9)))
save_tab(inventory_params, "06_parameter_inventory")
show(inventory_params)

# ---- 7. Cross-check vs existing calibration (frontend/src/model/params.json) -----
section("7. CROSS-CHECK vs frontend/src/model/params.json (read-only)")
pj <- file.path(ROOT, "frontend", "src", "model", "params.json")
J <- if (HAS_JSON && file.exists(pj)) jsonlite::fromJSON(pj, simplifyVector = TRUE) else NULL
if (!is.null(J) && is.null(J$bonus)) {
  # the frontend no longer has its own spending calibration: it reads THIS script's outputs
  # (frontend/scripts/import-r-model.ts), so there is nothing left to cross-check.
  cat("Skipped: the frontend now uses this model (R/output/*.csv -> frontend/src/model/spending.json).\n")
} else if (!is.null(J)) {
  q_med <- function(qs) qs[ceiling(length(qs) / 2)]
  emp_season <- season |> filter(employment_status == "employed") |> arrange(moy)
  xc <- data.frame(
    quantity = c("shock lag-1 autocorrelation", "P(bonus) employed", "median bonus size employed",
                 "Feb extra spending employed (share of income)", "Aug extra spending employed (share of income)",
                 "ledger negative months"),
    params_json = c(J$shock_autocorr_lag1, J$bonus$employed$probability, q_med(J$bonus$employed$size_quantiles),
                    J$season$employed[2], J$season$employed[8], J$data_checks$negative_months),
    this_eda = c(acf_tab$acf_season_adjusted[1], bonus$p_bonus[bonus$employment_status == "employed"],
                 bonus$size_median[bonus$employment_status == "employed"],
                 -emp_season$excess_share_income[2], -emp_season$excess_share_income[8], sum(panel$negative)),
    note = c("", "same detection rule", "same detection rule",
             "different baseline: EDA is vs same-year regular months", "as above", ""))
  show(xc)
  save_tab(xc, "07_crosscheck_params_json")
} else {
  cat("Skipped (jsonlite not installed or params.json missing).\n")
}

cat("\nTables:", length(list.files(TAB, pattern = "csv$")), "| Done in",
    round(as.numeric(difftime(Sys.time(), t_start, units = "secs"))), "s\n")
