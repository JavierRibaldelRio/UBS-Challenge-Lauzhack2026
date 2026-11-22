# =============================================================================
# engine.R - loads the deterministic financial state-transition engine
#
#   source("R/engine/engine.R")                      # from the repo root
#   theta   <- load_theta(file.path(R_DIR, "output", "model_parameters.csv"))
#   clients <- load_clients(file.path(R_DIR, "output"))
#   sim     <- simulate_client("P00001", 120, theta, clients)
#   validate_simulation(sim); yearly_summary(sim)
#
# Base R only. Reads the EDA outputs; never writes to them.
# =============================================================================

local({
  here <- tryCatch(dirname(normalizePath(sys.frame(1)$ofile)), error = function(e) NULL)
  if (is.null(here)) {
    a <- commandArgs(trailingOnly = FALSE)
    f <- sub("^--file=", "", a[grepl("^--file=", a)])
    here <- if (length(f) == 1 && file.exists(file.path(dirname(normalizePath(f)), "transition.R"))) dirname(normalizePath(f))
            else if (file.exists("R/engine/transition.R")) normalizePath("R/engine")
            else stop("Cannot locate R/engine/. Source it from the repo root: source('R/engine/engine.R')")
  }
  assign("ENGINE_DIR", here, envir = globalenv())
  assign("R_DIR", dirname(here), envir = globalenv())
})
for (.f in c("params.R", "state.R", "transition.R", "simulate.R", "validate.R")) source(file.path(ENGINE_DIR, .f))
rm(.f)
