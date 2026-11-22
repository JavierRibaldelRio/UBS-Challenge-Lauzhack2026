# =============================================================================
# state.R - client inputs and the initial state X(0)
#
# Every stock comes from exactly ONE source (see EDA section 1-2):
#   cash        <- client_static.cash_t0   (ledger month-1 opening; the other 3 copies are ignored)
#   investments <- client_static.investments (assets with asset_type != "cash")
#   debt        <- client_static.debt        (liabilities principal)
# =============================================================================

load_clients <- function(output_dir) {
  st <- read.csv(file.path(output_dir, "client_static.csv"), stringsAsFactors = FALSE)
  ef <- read.csv(file.path(output_dir, "client_effects.csv"), stringsAsFactors = FALSE)
  keep_st <- c("profile_id", "age_at_start", "city", "employment_status", "household_type", "income", "rent",
               "cash_t0", "investments", "debt", "loan_rate", "goals_total_target")
  m <- merge(st[, keep_st], ef[, c("profile_id", "u_outflow_chf", "sigma_reg_shrunk")], by = "profile_id")
  if (nrow(m) != nrow(st)) stop("client_static and client_effects do not match one-to-one")
  m
}

# X(0): the state at the start of the first simulated month.
#   loan_term_months: remaining term if known (annuity); NA = unknown -> assumptions$debt_service.
initial_state <- function(profile_id, clients, loan_term_months = NA_integer_,
                          start_year = 2025L, start_month = 1L) {
  cl <- clients[clients$profile_id == profile_id, , drop = FALSE]
  if (nrow(cl) != 1) stop("Unknown or duplicated profile_id: ", profile_id)
  has_debt <- cl$debt > 0
  list(
    # static attributes (inputs to theta lookups)
    profile_id        = cl$profile_id,
    employment_status = cl$employment_status,
    city              = cl$city,
    household_type    = cl$household_type,
    u_outflow         = cl$u_outflow_chf,
    # calendar
    t     = 0L,                    # months already simulated
    year  = as.integer(start_year),
    month = as.integer(start_month),   # calendar month of the NEXT step
    age   = cl$age_at_start,
    # stocks
    cash        = cl$cash_t0,
    investments = cl$investments,
    debt        = cl$debt,
    loan_rate   = if (has_debt) cl$loan_rate else 0,
    loan_term_remaining = if (has_debt) as.integer(loan_term_months) else NA_integer_,
    # flow levels / indices that evolve with the macro inputs
    income      = cl$income,       # current monthly net income (reference value at t = 0)
    rent        = cl$rent,         # current monthly rent
    price_index = 1                # living-cost index (1 at t = 0)
  )
}
