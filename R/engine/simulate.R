# =============================================================================
# simulate.R - roll transition() forward month by month for one client
# =============================================================================

# Inputs may be: a list of scalars (constant), a list whose elements are vectors (path indexed by t),
# or a function(state, t) returning such a list (a policy / scenario generator).
resolve_input <- function(x, state, t) {
  if (is.function(x)) return(x(state, t))
  out <- lapply(x, function(v) if (is.null(v) || length(v) == 1) v else v[[min(t, length(v))]])
  out
}

simulate_state <- function(state0, months, params, decision = default_decision(), macro = default_macro()) {
  if (months < 1) stop("months must be >= 1")
  rows <- vector("list", months)
  s <- state0
  for (t in seq_len(months)) {
    step <- transition(s, resolve_input(decision, s, t), resolve_input(macro, s, t), params)
    rows[[t]] <- step$flows
    s <- step$state
  }
  sim <- as.data.frame(do.call(rbind, rows))
  sim <- cbind(profile_id = state0$profile_id, employment_status = state0$employment_status,
               city = state0$city, sim, stringsAsFactors = FALSE)
  attr(sim, "final_state") <- s
  attr(sim, "assumptions") <- params$assumptions
  sim
}

simulate_client <- function(profile_id, months, params, clients, decision = default_decision(),
                            macro = default_macro(), loan_term_months = NA_integer_) {
  s0 <- initial_state(profile_id, clients, loan_term_months = loan_term_months)
  simulate_state(s0, months, params, decision, macro)
}

# Year-end view: stocks at December (or the last month), flows summed over the year.
yearly_summary <- function(sim) {
  sim$year_label <- sim$year
  agg <- aggregate(sim[, c("income", "bonus", "rent", "living", "extra_spending", "debt_payment",
                           "debt_interest", "inv_return", "cash_interest", "invest_contrib", "cash_negative")],
                   by = list(year = sim$year_label), FUN = sum)
  last <- sim[!duplicated(sim$year_label, fromLast = TRUE), c("year", "age", "cash_close", "inv_close",
                                                               "debt_close", "nw_close")]
  out <- merge(last, agg, by = "year")
  names(out)[names(out) == "cash_negative"] <- "months_cash_negative"
  out
}
