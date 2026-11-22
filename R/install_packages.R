# One-time setup: install the packages used by R/eda.R into the user library.
# Run from the repo root:  Rscript R/install_packages.R
#
# Notes (Fedora):
#  - Packages are compiled from CRAN source into R_LIBS_USER (no sudo needed).
#  - lme4 depends on nloptr. If nloptr fails to build, install the system library
#    (sudo dnf install nlopt-devel) and rerun this script. eda.R falls back to
#    nlme (shipped with R) for the mixed models if lme4 is unavailable.

lib <- Sys.getenv("R_LIBS_USER")
if (!nzchar(lib)) stop("R_LIBS_USER is not set")
dir.create(lib, recursive = TRUE, showWarnings = FALSE)
.libPaths(c(lib, .libPaths()))

pkgs    <- c("dplyr", "tidyr", "lme4", "jsonlite")
missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]

if (length(missing)) {
  message("Installing: ", paste(missing, collapse = ", "), " -> ", lib)
  install.packages(missing, lib = lib, repos = "https://cloud.r-project.org",
                   Ncpus = max(1L, parallel::detectCores() - 1L))
}

ok <- vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)
print(ok)
if (!all(ok)) {
  message("Not installed: ", paste(pkgs[!ok], collapse = ", "),
          if (!ok[["lme4"]]) "\n  For lme4 try: sudo dnf install nlopt-devel, then rerun." else "")
  quit(status = 1)
}
message("All packages available.")
