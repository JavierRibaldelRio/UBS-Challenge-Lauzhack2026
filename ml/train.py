"""Prepare the Financial Twin's data artifacts from the synthetic challenge data.

Reads  : pre_docs/Data/*.csv
         The UBS synthetic data is NOT in this repo (private challenge material). To reproduce,
         copy UBS's challenge "Data/" folder to pre_docs/Data/ (git-ignored); see README §1.6.
Writes : frontend/src/model/params.json    (data checks, defaults from the data, scenario catalog)
         frontend/src/model/profiles.json  (the 1,200 people: state today, goals, real ledger)

Run    : cd ml && uv run train.py          (deterministic, pinned deps)

Nothing is estimated here. The models live in R and are imported by the frontend:
  - monthly spending (level, seasonality, December bonus, shocks): R/eda.R  -> frontend/src/model/spending.json
  - economy forecast (inflation, unemployment):                    R/macro.R -> frontend/src/model/macro.json
  (cd frontend && pnpm model:import), and the backtest is run by the app's own engine (pnpm backtest).

What this script produces:
  1. Data checks - the ledger's own accounting (opening + net = closing, month-to-month continuity)
  2. Anchors     - data medians used as defaults: income by status x age band, rent by city x household,
                   study tuition and duration (scenario-assumptions.csv)
  3. Profiles    - each person's state today, loans, goals and the real 24-month closing-cash ledger
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

SEED = 20260  # Monte Carlo seed used by the app (fixed: same results on every machine)
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "pre_docs" / "Data"
OUT = ROOT / "frontend" / "src" / "model"

STATUSES = ["employed", "self_employed", "part_time", "student", "unemployed", "retired"]
MIN_GROUP = 5  # minimum sample size for a median anchor, else fall back to a coarser group


def r(x, n=4):
    return float(round(float(x), n))


# ----------------------------------------------------------------------------- load
def load():
    need = ["synthetic-profiles.csv", "synthetic-cash-balances.csv", "synthetic-assets.csv", "synthetic-liabilities.csv",
            "synthetic-goals.csv", "scenario-assumptions.csv", "scenario-catalog.csv"]
    missing = [f for f in need if not (DATA / f).exists()]
    if missing:
        raise SystemExit(
            f"Missing UBS data in {DATA}: {', '.join(missing)}\n"
            "The synthetic data is not committed (private UBS challenge material). Copy UBS's challenge 'Data/' folder to "
            "pre_docs/Data/ to re-train (README §1.6). The app does not need it: frontend/src/model/*.json is committed."
        )
    prof = pd.read_csv(DATA / "synthetic-profiles.csv")
    cash = pd.read_csv(DATA / "synthetic-cash-balances.csv")
    assets = pd.read_csv(DATA / "synthetic-assets.csv")
    liab = pd.read_csv(DATA / "synthetic-liabilities.csv")
    goals = pd.read_csv(DATA / "synthetic-goals.csv")
    assum = pd.read_csv(DATA / "scenario-assumptions.csv")
    catalog = pd.read_csv(DATA / "scenario-catalog.csv")
    return prof, cash, assets, liab, goals, assum, catalog


def validate_ledger(cash: pd.DataFrame) -> dict:
    """Check the data's own accounting: opening + net = closing, and month-to-month continuity."""
    ident = (cash.opening_cash_chf + cash.net_transactions_chf - cash.closing_cash_chf).abs() > 0.011
    c = cash.sort_values(["profile_id", "month"])
    prev_close = c.groupby("profile_id").closing_cash_chf.shift(1)
    cont = ((prev_close - c.opening_cash_chf).abs() > 0.011) & prev_close.notna()
    neg = cash.closing_cash_chf < 0
    flagged = cash.status == "negative_balance_requires_financing"
    return {
        "rows": int(len(cash)),
        "identity_violations": int(ident.sum()),
        "continuity_violations": int(cont.sum()),
        "negative_months": int(neg.sum()),
        "negative_flag_mismatch": int((neg != flagged).sum()),
    }


def build_panel(prof: pd.DataFrame, cash: pd.DataFrame) -> pd.DataFrame:
    """One row per profile-month, in time order."""
    p = cash.merge(prof, on="profile_id").sort_values(["profile_id", "month"])
    p["t"] = p.groupby("profile_id").cumcount()
    return p


# ----------------------------------------------------------------------------- anchors (defaults from the data)
def band(age: int) -> str:
    lo = (age // 5) * 5
    return f"{lo}-{lo + 4}"


def stat(x: pd.Series) -> dict:
    """median + the peer range (10th-90th percentile) -> lets the app test 'what if this person is at the low/high end of their peers'"""
    return {"median": r(x.median(), 2), "p10": r(x.quantile(0.1), 2), "p90": r(x.quantile(0.9), 2), "n": int(len(x))}


def anchors(prof: pd.DataFrame, assum: pd.DataFrame) -> dict:
    inc = {}
    for s in STATUSES:
        d = prof[prof.employment_status == s]
        by_band = {}
        for b, g in d.groupby(d.age_at_start.map(band)):
            if len(g) >= MIN_GROUP:
                by_band[b] = stat(g.reference_monthly_net_income_chf)
        inc[s] = {"all": stat(d.reference_monthly_net_income_chf), "by_age_band": by_band}

    rent = {}
    for c, g in prof.groupby("city"):
        by_h = {}
        for h, gh in g.groupby("household_type"):
            if len(gh) >= MIN_GROUP:
                by_h[h] = stat(gh.reference_monthly_rent_chf)
        rent[c] = {"all": stat(g.reference_monthly_rent_chf), "by_household": by_h}

    canton = prof.groupby("city").canton.first().to_dict()
    tuition = assum[assum.parameter == "annual_tuition_chf"].value.astype(float)
    duration = assum[assum.parameter == "study_duration_years"].value.astype(float)
    return {
        "income_by_status": inc,
        "rent_by_city": rent,
        "city_canton": canton,
        "study": {
            "annual_tuition_chf_values": sorted({r(v, 2) for v in tuition}),
            "annual_tuition_chf_median": r(tuition.median(), 2),
            "duration_years_median": r(duration.median(), 2),
            "source": "scenario-assumptions.csv (S001, synthetic_assumption, not in ledger)",
        },
    }


# ----------------------------------------------------------------------------- export
def export_profiles(prof, panel, assets, liab, goals, assum) -> list[dict]:
    inv = assets[assets.asset_type == "investment_portfolio"].groupby("profile_id").value_chf.sum()
    led = panel.groupby("profile_id").closing_cash_chf.apply(list)
    out = []
    for p in prof.itertuples():
        pid = p.profile_id
        L = liab[liab.profile_id == pid]
        G = goals[goals.profile_id == pid]
        A = assum[assum.profile_id == pid]
        study = {row.parameter: float(row.value) for row in A.itertuples()}
        out.append(
            {
                "id": pid,
                "name": p.display_name,
                "age": int(p.age_at_start),
                "city": p.city,
                "canton": p.canton,
                "status": p.employment_status,
                "household": p.household_type,
                "as_of": p.as_of_date,
                "income": r(p.reference_monthly_net_income_chf, 2),
                "rent": r(p.reference_monthly_rent_chf, 2),
                "cash": r(p.opening_cash_chf, 2),
                "investments": r(inv.get(pid, 0.0), 2),
                "loans": [
                    {"principal": r(l.opening_principal_chf, 2), "annual_rate": r(l.annual_interest_rate, 4), "type": l.liability_type}
                    for l in L.itertuples()
                ],
                "goals": [
                    {"name": g.goal_name, "target": r(g.target_amount_chf, 2), "date": g.target_date, "priority": g.priority}
                    for g in G.itertuples()
                ],
                "study_assumption": study or None,
                "ledger_closing_cash": [r(x, 2) for x in led[pid]],
            }
        )
    return out


def main():
    prof, cash, assets, liab, goals, assum, catalog = load()
    checks = validate_ledger(cash)
    panel = build_panel(prof, cash)

    params = {
        "version": 2,
        "seed": SEED,
        "units": "CHF per month, constant 2025 francs (no inflation), months indexed from each profile's as_of_date",
        "source": {
            "files": ["synthetic-profiles.csv", "synthetic-cash-balances.csv", "synthetic-assets.csv", "synthetic-liabilities.csv", "synthetic-goals.csv", "scenario-assumptions.csv"],
            "profile_months": int(len(panel)),
            "profiles": int(prof.profile_id.nunique()),
            "period": f"{cash.month.min()} to {cash.month.max()}",
            "income_convention": "reference_monthly_net_income_chf treated as constant net income; spending = income - net_transactions",
        },
        "data_checks": checks,
        "anchors": anchors(prof, assum),
        "catalog": catalog.rename(columns={"scenario": "name"})[["id", "category", "name", "baseline", "intervention"]].to_dict("records"),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "params.json").write_text(json.dumps(params, indent=1, ensure_ascii=False))
    profiles = export_profiles(prof, panel, assets, liab, goals, assum)
    (OUT / "profiles.json").write_text(json.dumps(profiles, separators=(",", ":"), ensure_ascii=False))

    print("data checks     ", checks)
    print(f"wrote {OUT / 'params.json'} and profiles.json ({len(profiles)} profiles)")
    print("spending and economy models: R/eda.R + R/macro.R, then `cd frontend && pnpm model:import`")


if __name__ == "__main__":
    main()
