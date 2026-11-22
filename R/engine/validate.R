# =============================================================================
# validate.R - accounting identities that every simulated path must satisfy
# =============================================================================

validate_simulation <- function(sim, tol = 1e-9) {
  lagged <- function(x) c(NA, head(x, -1))
  err <- list(
    # cash: closing = opening + operating net flow + cash interest - debt service - prepayment - investing
    cash_identity = with(sim, cash_close - (cash_open + operating_net + cash_interest - debt_payment -
                                              debt_prepay - invest_contrib)),
    # investments: closing = opening + return + contribution
    investment_identity = with(sim, inv_close - (inv_open + inv_return + invest_contrib)),
    # debt: closing = opening + interest - scheduled payment - prepayment
    debt_identity = with(sim, debt_close - (debt_open + debt_interest - debt_payment - debt_prepay)),
    # operating flow is income + bonus - rent - living - extra (rent and living are separate items)
    operating_identity = with(sim, operating_net - (income + bonus - rent - living - extra_spending)),
    # net worth = cash + investments - debt (each stock counted once)
    net_worth_definition = with(sim, nw_close - (cash_close + inv_close - debt_close)),
    # change in net worth = operating flow + cash interest + investment return - debt interest;
    # transfers (investing, principal repayment, prepayment) must not change net worth
    net_worth_change = with(sim, (nw_close - nw_open) - (operating_net + cash_interest + inv_return - debt_interest)),
    # scheduled payment = interest + principal repaid
    payment_split = with(sim, debt_payment - (debt_interest + principal_repaid)),
    # continuity: month t opens where month t-1 closed
    continuity_cash = with(sim, cash_open - lagged(cash_close)),
    continuity_investments = with(sim, inv_open - lagged(inv_close)),
    continuity_debt = with(sim, debt_open - lagged(debt_close)),
    # non-negativity of stocks that cannot be negative
    investments_non_negative = pmin(sim$inv_close, 0),
    debt_non_negative = pmin(sim$debt_close, 0)
  )
  data.frame(check = names(err),
             max_abs_error = vapply(err, function(e) max(abs(e), na.rm = TRUE), numeric(1)),
             pass = vapply(err, function(e) all(abs(e) <= tol * pmax(1, abs(sim$nw_open)), na.rm = TRUE), logical(1)),
             row.names = NULL)
}
