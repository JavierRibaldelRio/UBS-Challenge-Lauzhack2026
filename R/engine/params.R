# =============================================================================
# params.R - load theta (estimated parameters from the EDA) + modelling assumptions
#
# theta is read-only input: R/output/model_parameters.csv is never modified here.
# =============================================================================

EMPLOYMENT_LEVELS <- c("employed", "self_employed", "part_time", "retired", "student", "unemployed")

# Modelling assumptions that are NOT estimated from data. Each is a deliberate, documented choice.
default_assumptions <- function() {
  list(
    # Debt service when the loan term is unknown (it is unknown for every loan in the data):
    #   "interest_only" : pay the monthly interest, principal stays constant   [MODELLING ASSUMPTION]
    #   "none"          : no payment, interest capitalises. Only for replicating the historical
    #                     ledger, which contains no loan cash flows (validation/backtest mode).
    # If a loan term is supplied in the state, an annuity schedule is used instead.
    debt_service = "interest_only",
    # Add the client's estimated outflow offset u_i (BLUP, sd ~2 CHF) to living costs.
    include_client_offset = TRUE
  )
}

load_theta <- function(path) {
  if (!file.exists(path)) stop("Parameter file not found: ", path, "\n  Run the EDA first: Rscript R/eda.R")
  p <- read.csv(path, stringsAsFactors = FALSE)
  pick <- function(block, parameter) p[p$block == block & p$parameter == parameter, , drop = FALSE]

  # Base non-rent outflow (living costs) by employment x calendar month, population-average city,
  # non-bonus month. Seasonal effects (Feb/Aug, student Feb/Sep, self-employed Dec) are inside it.
  b <- pick("mean", "base_nonrent_outflow")
  base <- matrix(NA_real_, length(EMPLOYMENT_LEVELS), 12, dimnames = list(EMPLOYMENT_LEVELS, month.abb))
  base[cbind(match(b$employment_status, EMPLOYMENT_LEVELS), b$month)] <- b$value
  if (anyNA(base)) stop("base_nonrent_outflow is incomplete in ", path)

  co <- pick("mean", "city_offset")
  city_offset <- setNames(co$value, co$key)

  bp <- pick("bonus", "p_bonus")
  bs <- pick("bonus", "bonus_size_given_bonus_mean")
  bonus_p <- setNames(bp$value, bp$employment_status)[EMPLOYMENT_LEVELS]
  bonus_size <- setNames(rep(0, length(EMPLOYMENT_LEVELS)), EMPLOYMENT_LEVELS)
  bonus_size[bs$employment_status] <- bs$value
  # Expected December bonus as a share of monthly income = P(bonus) x E[size | bonus].
  # Only groups with an estimated bonus term get one: for the other groups the rare bonus-like
  # inflows are already part of their base outflow mean, so adding them again would double count.
  expected_bonus_share <- ifelse(bonus_size > 0, bonus_p * bonus_size, 0)

  list(
    base_outflow = base,
    city_offset = city_offset,
    bonus_p = bonus_p,
    bonus_size = bonus_size,
    expected_bonus_share = expected_bonus_share,
    # Stochastic parameters, kept for the later Monte Carlo step (unused by the deterministic engine)
    sigma_eps = pick("shocks", "sigma_eps")[, c("employment_status", "key", "value")],
    k_multiplier = pick("shocks", "k_multiplier_vs_regular")[, c("employment_status", "key", "value")],
    assumptions = default_assumptions(),
    source = normalizePath(path)
  )
}
