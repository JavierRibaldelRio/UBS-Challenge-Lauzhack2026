# =============================================================================
# transition.R - X(t+1) = F(X(t), A(t), Z(t); theta)     one deterministic month
#
# Timing convention (one month t):
#   - interest / returns accrue on OPENING balances;
#   - all flows (income, bonus, rent, living costs, debt service, decisions) settle during the month;
#   - investment contributions are added at month end (they start earning next month);
#   - income, rent and the price index are then indexed for the next month.
# Expected values replace random terms: E[shock] = 0, E[bonus] = P(bonus) x E[size | bonus] x income.
# =============================================================================

# Z(t): macro inputs, all ANNUAL rates. Each element may be a scalar (constant) or a vector indexed by
# month t (a path). Defaults are neutral (0%) so the engine reproduces the estimated model as is.
default_macro <- function() {
  list(
    inflation         = 0,     # living-cost (non-rent outflow) inflation
    rent_inflation    = NULL,  # NULL -> same as inflation
    wage_growth       = 0,     # growth of net income
    cash_rate         = 0,     # interest on positive cash (0 = consistent with the historical ledger)
    overdraft_rate    = 0,     # interest on negative cash (0 = ledger-consistent; see ENGINE.md issues)
    investment_return = 0,     # expected total return of the investment portfolio
    loan_rate_shift   = 0      # added to every client's loan rate (variable-rate assumption)
  )
}

# A(t): client decisions for the month, in CHF.
default_decision <- function() {
  list(
    invest         = 0,   # > 0: move cash into investments; < 0: withdraw (capped at the portfolio)
    debt_prepay    = 0,   # extra principal repayment from cash (capped at the outstanding balance)
    extra_spending = 0    # additional consumption (> 0) or savings effort (< 0) vs the estimated baseline
  )
}

monthly_rate <- function(annual) {
  if (any(annual <= -1)) stop("annual rates must be > -100%")
  (1 + annual)^(1 / 12) - 1
}

FLOW_NAMES <- c("t", "year", "month", "age",
                "cash_open", "inv_open", "debt_open", "nw_open",
                "income", "bonus", "rent", "living", "extra_spending", "operating_net",
                "cash_interest", "inv_return", "debt_interest", "debt_payment", "principal_repaid",
                "debt_prepay", "invest_contrib",
                "cash_close", "inv_close", "debt_close", "nw_close",
                "price_index", "cash_negative")

transition <- function(state, decision = default_decision(), macro = default_macro(), params) {
  a <- modifyList(default_decision(), decision)
  z <- modifyList(default_macro(), macro, keep.null = TRUE)
  if (is.null(z$rent_inflation)) z$rent_inflation <- z$inflation
  asm <- params$assumptions
  emp <- state$employment_status; m <- state$month
  if (!emp %in% rownames(params$base_outflow)) stop("No parameters for employment status: ", emp)
  if (!state$city %in% names(params$city_offset)) stop("No city offset for: ", state$city)

  # --- flows during the month -----------------------------------------------------
  income <- state$income
  bonus  <- if (m == 12) params$expected_bonus_share[[emp]] * income else 0          # expected value
  rent   <- state$rent
  living <- (params$base_outflow[emp, m] + params$city_offset[[state$city]] +
               if (isTRUE(asm$include_client_offset)) state$u_outflow else 0) * state$price_index
  extra  <- a$extra_spending
  operating_net <- income + bonus - rent - living - extra

  r_cash <- monthly_rate(if (state$cash >= 0) z$cash_rate else z$overdraft_rate)
  cash_interest <- state$cash * r_cash

  inv_return <- state$investments * monthly_rate(z$investment_return)
  invest <- max(a$invest, -(state$investments + inv_return))         # cannot withdraw more than held

  # --- debt -----------------------------------------------------------------------------
  i_loan <- monthly_rate(state$loan_rate + z$loan_rate_shift)
  debt_interest <- state$debt * i_loan
  n <- state$loan_term_remaining
  debt_payment <- if (state$debt <= 0) {
    0
  } else if (!is.na(n) && n > 0) {                                  # known term: annuity
    if (i_loan == 0) state$debt / n else state$debt * i_loan / (1 - (1 + i_loan)^(-n))
  } else if (asm$debt_service == "interest_only") {                  # MODELLING ASSUMPTION
    debt_interest
  } else if (asm$debt_service == "none") {                           # ledger-replication mode only
    0
  } else stop("Unknown debt_service assumption: ", asm$debt_service)
  principal_repaid <- debt_payment - debt_interest
  prepay <- min(max(a$debt_prepay, 0), max(state$debt + debt_interest - debt_payment, 0))

  # --- stock updates (the only place stocks change) --------------------------------------
  cash_close <- state$cash + operating_net + cash_interest - debt_payment - prepay - invest
  inv_close  <- state$investments + inv_return + invest
  debt_close <- state$debt + debt_interest - debt_payment - prepay
  if (abs(debt_close) < 1e-6) debt_close <- 0
  if (abs(inv_close) < 1e-9) inv_close <- 0

  flows <- c(t = state$t + 1, year = state$year, month = m, age = state$age,
             cash_open = state$cash, inv_open = state$investments, debt_open = state$debt,
             nw_open = state$cash + state$investments - state$debt,
             income = income, bonus = bonus, rent = rent, living = living, extra_spending = extra,
             operating_net = operating_net, cash_interest = cash_interest, inv_return = inv_return,
             debt_interest = debt_interest, debt_payment = debt_payment, principal_repaid = principal_repaid,
             debt_prepay = prepay, invest_contrib = invest,
             cash_close = cash_close, inv_close = inv_close, debt_close = debt_close,
             nw_close = cash_close + inv_close - debt_close,
             price_index = state$price_index, cash_negative = as.numeric(cash_close < 0))

  # --- next state ----------------------------------------------------------------------
  s <- state
  s$cash <- cash_close; s$investments <- inv_close; s$debt <- debt_close
  if (!is.na(n) && n > 0) s$loan_term_remaining <- n - 1L
  if (debt_close == 0) s$loan_term_remaining <- NA_integer_
  s$income      <- income * (1 + monthly_rate(z$wage_growth))
  s$rent        <- rent * (1 + monthly_rate(z$rent_inflation))
  s$price_index <- state$price_index * (1 + monthly_rate(z$inflation))
  s$t <- state$t + 1L
  if (m == 12L) { s$month <- 1L; s$year <- state$year + 1L } else s$month <- m + 1L
  if (s$t %% 12L == 0L) s$age <- state$age + 1
  list(state = s, flows = flows)
}
