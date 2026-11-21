"""Calibrate the Financial Twin cash-flow model from the synthetic challenge data.

Reads  : pre_docs/Data/*.csv
Writes : frontend/src/model/params.json    (learned model + validation report)
         frontend/src/model/profiles.json  (per-profile state + personal calibration)

Run    : cd ml && uv run train.py          (deterministic: fixed seed, pinned deps)

What is learned (all from the 28,800 synthetic profile-months):
  1. Seasonality    - extra spending per calendar month, per employment status (share of income)
  2. December bonus - probability and size of a 13th-month-style payment, per employment status
  3. Spending level - regression: "other" monthly spending (excl. rent) ~ income, rent, household, status, age
                      -> lets the twin say how spending responds when income/household/status changes
  4. Volatility     - regression: month-to-month spending std-dev ~ income, status
  5. Shock shape    - empirical distribution of standardized monthly spending surprises (for Monte Carlo)
  6. Anchors        - data medians used as defaults: income by status x age band, rent by city x household
Validation:
  - Backtest: fit on 2025 only, simulate 2026 with Monte Carlo, check the 80% band covers ~80% of real outcomes
  - Cross-validated R^2 of the spending-level regression on held-out profiles
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20260
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "pre_docs" / "Data"
OUT = ROOT / "frontend" / "src" / "model"

STATUSES = ["employed", "self_employed", "part_time", "student", "unemployed", "retired"]
HOUSEHOLDS = ["single", "couple", "family", "shared_housing"]
BONUS_Z = 3.0  # a December counts as a bonus if net inflow is > 3 std-devs above the person's Jan-Nov months
BONUS_MIN_SHARE = 0.05  # ...and at least 5% of monthly income
SEASON_T = 3.0  # keep a seasonal effect only if |mean / standard error| > 3
MIN_GROUP = 5 # minimum sample size for a median anchor, else fall back to a coarser group


def r(x, n=4):
    return float(round(float(x), n))


# ----------------------------------------------------------------------------- load
def load():
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


# ----------------------------------------------------------------------------- core fit
def build_panel(prof: pd.DataFrame, cash: pd.DataFrame) -> pd.DataFrame:
    """One row per profile-month. Income is the profile's reference net income (constant), so
    everything else in the net flow is spending: spend_t = income - net_t."""
    p = cash.merge(prof, on="profile_id")
    p["t"] = p.groupby("profile_id").cumcount()
    p["moy"] = p.month.str[5:7].astype(int) - 1  # 0 = January
    p["income"] = p.reference_monthly_net_income_chf
    p["rent"] = p.reference_monthly_rent_chf
    p["spend"] = p.income - p.net_transactions_chf
    return p


def fit_behaviour(panel: pd.DataFrame) -> dict:
    """Seasonality, December bonus, personal level/volatility, shock distribution."""
    pan = panel.copy()
    # December extra inflow, as an outlier test against the profile's own Jan-Nov months
    nd = pan[pan.moy != 11].groupby("profile_id").net_transactions_chf
    pan["net_ref"] = pan.profile_id.map(nd.mean())
    pan["net_sd"] = pan.profile_id.map(nd.std(ddof=1))
    pan["zn"] = (pan.net_transactions_chf - pan.net_ref) / pan.net_sd
    pan["extra"] = (pan.net_transactions_chf - pan.net_ref) / pan.income
    pan["outlier"] = (pan.zn > BONUS_Z) & (pan.extra > BONUS_MIN_SHARE)

    bonus = {}
    for s in STATUSES:
        d = pan[pan.employment_status == s]
        dec, other = d[d.moy == 11], d[d.moy != 11]
        if not len(dec):
            continue
        fp = other.outlier.mean()  # how often a normal month looks like a bonus
        p_b = max(0.0, (dec.outlier.mean() - fp) / (1 - fp))
        # a status "has a bonus" only if bonus Decembers are common (data-driven, not hard-coded)
        if p_b > 0.25:
            q = np.quantile(dec.extra[dec.outlier], np.linspace(0, 1, 21))
            bonus[s] = {
                "probability": r(p_b),
                "size_quantiles": [r(x) for x in q],
                "n_decembers": int(len(dec)),
                "false_positive_rate_other_months": r(fp),
            }
    pan["bonus_flag"] = (pan.moy == 11) & pan.employment_status.isin(bonus) & pan.outlier
    pan["bonus_amt"] = np.where(pan.bonus_flag, pan.net_transactions_chf - pan.net_ref, 0.0)
    # spending net of bonus (bonus is income, not negative spending)
    pan["spend_x"] = pan.spend + pan.bonus_amt

    # seasonality: deviation from the profile's own mean spend, as a share of that mean spend.
    # Keep a (status, month) effect only if it is statistically clear (|t| > SEASON_T); else 0.
    pmean = pan.groupby("profile_id").spend_x.transform("mean")
    pan["dev"] = (pan.spend_x - pmean) / pmean
    g = pan.groupby(["employment_status", "moy"]).dev
    mean, se = g.mean(), g.std(ddof=1) / np.sqrt(g.size())
    season = mean.where((mean / se).abs() > SEASON_T, 0.0).unstack().reindex(STATUSES).fillna(0.0)
    pan["season"] = [season.loc[s, m] for s, m in zip(pan.employment_status, pan.moy)]
    pan["other"] = pan.spend_x - pan.season * pmean - pan.rent

    # personal calibration
    g = pan.groupby("profile_id").other
    personal = pd.DataFrame({"mu": g.mean(), "sd": g.std(ddof=1), "n": g.size()})

    # standardized surprises -> empirical distribution
    pan["z"] = (pan.other - pan.profile_id.map(personal.mu)) / pan.profile_id.map(personal.sd)
    z = pan.z.replace([np.inf, -np.inf], np.nan).dropna().to_numpy()
    zq = np.quantile(z, np.linspace(0, 1, 201))
    # lag-1 autocorrelation of surprises (justifies independent monthly draws if ~0)
    pan = pan.sort_values(["profile_id", "t"])
    zl = pan.groupby("profile_id").z.shift(1)
    ok = zl.notna() & pan.z.notna()
    ac1 = float(np.corrcoef(pan.z[ok], zl[ok])[0, 1])

    return {
        "bonus": bonus,
        "season": {s: [r(x) for x in season.loc[s].to_numpy()] for s in STATUSES},
        "shock_quantiles": [r(x, 3) for x in zq],
        "shock_autocorr_lag1": r(ac1),
        "personal": personal,
        "panel": pan,
    }


# ----------------------------------------------------------------------------- regressions
FEATURE_SETS = {
    "linear": ["income", "rent", "age"],
    "linear+sqrt_income": ["income", "sqrt_income", "rent", "age"],
}


def design(df: pd.DataFrame, numeric: list[str]) -> tuple[np.ndarray, list[str]]:
    cols, names = [np.ones(len(df))], ["intercept"]
    for f in numeric:
        if f == "sqrt_income":
            cols.append(np.sqrt(df.income.to_numpy()))
        else:
            cols.append(df[f].to_numpy(dtype=float))
        names.append(f)
    for h in HOUSEHOLDS[1:]:
        cols.append((df.household == h).to_numpy(dtype=float))
        names.append(f"household={h}")
    for s in STATUSES[1:]:
        cols.append((df.status == s).to_numpy(dtype=float))
        names.append(f"status={s}")
    return np.column_stack(cols), names


def ols(X, y):
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    return beta


def cv_r2(df, numeric, target, k=5, seed=SEED):
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(df))
    folds = np.array_split(idx, k)
    pred = np.zeros(len(df))
    X, _ = design(df, numeric)
    y = df[target].to_numpy()
    for f in folds:
        train = np.setdiff1d(idx, f)
        pred[f] = X[f] @ ols(X[train], y[train])
    return 1 - np.sum((y - pred) ** 2) / np.sum((y - y.mean()) ** 2)


def fit_regressions(prof: pd.DataFrame, personal: pd.DataFrame) -> dict:
    df = prof.set_index("profile_id").join(personal)
    df = pd.DataFrame(
        {
            "income": df.reference_monthly_net_income_chf,
            "rent": df.reference_monthly_rent_chf,
            "age": df.age_at_start,
            "household": df.household_type,
            "status": df.employment_status,
            "mu": df.mu,
            "sd": df.sd,
        }
    ).dropna()

    out = {}
    for target, label in (("mu", "other_spending"), ("sd", "spending_volatility")):
        scores = {name: cv_r2(df, feats, target) for name, feats in FEATURE_SETS.items()}
        best = max(scores, key=scores.get)
        X, names = design(df, FEATURE_SETS[best])
        beta = ols(X, df[target].to_numpy())
        out[label] = {
            "target": "mean monthly non-rent spending (CHF)" if target == "mu" else "std-dev of monthly non-rent spending (CHF)",
            "form": best,
            "features": names,
            "coefficients": [r(b, 6) for b in beta],
            "cv_r2": {k: r(v) for k, v in scores.items()},
            "selected_cv_r2": r(scores[best]),
            "n_profiles": int(len(df)),
        }
    return out


# ----------------------------------------------------------------------------- anchors
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


# ----------------------------------------------------------------------------- backtest
def sample_shocks(zq: np.ndarray, rng, size):
    u = rng.random(size) * (len(zq) - 1)
    i = np.floor(u).astype(int)
    f = u - i
    return zq[i] * (1 - f) + zq[np.minimum(i + 1, len(zq) - 1)] * f


def backtest(prof: pd.DataFrame, panel: pd.DataFrame, n_paths=1000) -> dict:
    """Fit behaviour on 2025 only, then simulate 2026 for every profile and compare with the real ledger."""
    train = panel[panel.t < 12][list(panel.columns.intersection(["profile_id", "month", "opening_cash_chf", "net_transactions_chf", "closing_cash_chf", "status"]))]
    fit = fit_behaviour(build_panel(prof, train))
    personal, season, bonus = fit["personal"], fit["season"], fit["bonus"]
    zq = np.array(fit["shock_quantiles"])
    rng = np.random.default_rng(SEED)

    pr = prof.set_index("profile_id")
    test = panel[panel.t >= 12].sort_values(["profile_id", "t"])
    start_cash = panel[panel.t == 11].set_index("profile_id").closing_cash_chf

    inside80 = inside50 = 0
    gains = {}  # simulated 2026 cash change per profile (for the "A ends higher than B" check)
    real_gain = {}
    pit = []  # where the real result fell inside our predicted distribution (0..1); uniform = perfectly calibrated
    neg_pred, neg_real = [], []
    month_inside80 = month_total = 0
    abs_err_model, abs_err_naive = [], []
    brier_model, brier_naive = [], []
    pids = list(pr.index)
    for pid in pids:
        p = pr.loc[pid]
        inc, rent, s = p.reference_monthly_net_income_chf, p.reference_monthly_rent_chf, p.employment_status
        mu, sd, n_obs = personal.loc[pid, "mu"], personal.loc[pid, "sd"], personal.loc[pid, "n"]
        # parameter uncertainty: the personal mean is estimated from n_obs months (standard error sd/sqrt(n))
        mu_path = mu + sd / np.sqrt(n_obs) * rng.standard_normal(n_paths)
        flows = np.empty((n_paths, 12))
        for m in range(12):
            base = rent + mu_path
            spend = base * (1 + season[s][m]) + sd * sample_shocks(zq, rng, n_paths)
            income = np.full(n_paths, inc)
            if m == 11 and s in bonus:
                b = bonus[s]
                hit = rng.random(n_paths) < b["probability"]
                size = sample_shocks(np.array(b["size_quantiles"]), rng, n_paths)
                income = income + hit * size * inc
            flows[:, m] = income - spend
        paths = start_cash[pid] + np.cumsum(flows, axis=1)
        actual = test[test.profile_id == pid].closing_cash_chf.to_numpy()
        lo80, hi80 = np.quantile(paths, [0.1, 0.9], axis=0)
        lo50, hi50 = np.quantile(paths, [0.25, 0.75], axis=0)
        med = np.median(paths[:, -1])
        pit.append(float((paths[:, -1] <= actual[-1]).mean()))
        gains[pid] = paths[:, -1] - start_cash[pid]
        real_gain[pid] = actual[-1] - start_cash[pid]
        inside80 += lo80[-1] <= actual[-1] <= hi80[-1]
        inside50 += lo50[-1] <= actual[-1] <= hi50[-1]
        month_inside80 += int(((lo80 <= actual) & (actual <= hi80)).sum())
        month_total += 12
        abs_err_model.append(abs(med - actual[-1]))
        naive = start_cash[pid] + 12 * panel[(panel.profile_id == pid) & (panel.t < 12)].net_transactions_chf.mean()
        abs_err_naive.append(abs(naive - actual[-1]))
        went_neg = float((actual < 0).any())
        brier_model.append(((paths < 0).any(axis=1).mean() - went_neg) ** 2)
        neg_pred.append(float((paths < 0).any(axis=1).mean()))
        neg_real.append(went_neg)
        naive_path = start_cash[pid] + np.arange(1, 13) * (naive - start_cash[pid]) / 12
        brier_naive.append((float((naive_path < 0).any()) - went_neg) ** 2)

    # "A ends higher than B" statements: random pairs of people, model probability vs what really happened in 2026
    prng = np.random.default_rng(SEED + 1)
    pairs = prng.choice(len(pids), size=(20000, 2))
    said, real = [], []
    for i, j in pairs:
        if i == j:
            continue
        a, b = pids[i], pids[j]
        said.append(float((gains[a] > prng.permutation(gains[b])).mean()))
        real.append(float(real_gain[a] > real_gain[b]))
    said, real = np.array(said), np.array(real)
    bins = [(0, 0.05), (0.05, 0.2), (0.2, 0.5), (0.5, 0.8), (0.8, 0.95), (0.95, 1.01)]
    ends_higher = [
        {"said": f"{int(lo*100)}-{min(100, int(hi*100))}%", "pairs": int(m.sum()), "avg_said": r(said[m].mean(), 3), "real": r(real[m].mean(), 3)}
        for lo, hi in bins
        for m in [(said >= lo) & (said < hi)]
        if m.sum() > 0
    ]

    n = len(pids)
    return {
        "calibration_ends_higher": ends_higher,
        "method": "fit on 2025 (12 months), Monte Carlo 2026 from real Dec-2025 cash, compare with real 2026 ledger",
        "profiles": n,
        "paths_per_profile": n_paths,
        "coverage_80_year_end": r(inside80 / n),
        # calibration curve: "we said X% of results fall in this range" vs what really happened
        "calibration_central": [{"said": lv, "real": r(np.mean([abs(u - 0.5) <= lv / 200 for u in pit]), 3)} for lv in (10, 20, 30, 40, 50, 60, 70, 80, 90)],
        # probability check: grouped by how likely we said "cash goes below zero in 2026" was
        "calibration_negative_cash": [
            {"said": lab, "profiles": int(m.sum()), "avg_said": r(np.mean(np.array(neg_pred)[m]), 3), "real": r(np.mean(np.array(neg_real)[m]), 3)}
            for lab, m in (
                (lab, (np.array(neg_pred) >= lo) & (np.array(neg_pred) < hi))
                for lab, lo, hi in (("under 5%", 0, 0.05), ("5-50%", 0.05, 0.5), ("50-95%", 0.5, 0.95), ("over 95%", 0.95, 1.01))
            )
            if m.sum() > 0
        ],
        "coverage_50_year_end": r(inside50 / n),
        "coverage_80_all_months": r(month_inside80 / month_total),
        "median_abs_error_year_end_chf": r(np.median(abs_err_model), 2),
        "median_abs_error_naive_chf": r(np.median(abs_err_naive), 2),
        "brier_negative_cash_model": r(np.mean(brier_model)),
        "brier_negative_cash_naive": r(np.mean(brier_naive)),
        "naive_definition": "Dec-2025 cash + 12 x average 2025 monthly net flow, no uncertainty",
    }


# ----------------------------------------------------------------------------- export
def export_profiles(prof, panel, personal, assets, liab, goals, assum) -> list[dict]:
    inv = assets[assets.asset_type == "investment_portfolio"].groupby("profile_id").value_chf.sum()
    led = panel.sort_values(["profile_id", "t"]).groupby("profile_id").closing_cash_chf.apply(list)
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
                "calib": {"other_mu": r(personal.loc[pid, "mu"], 2), "other_sd": r(personal.loc[pid, "sd"], 2), "months": int(personal.loc[pid, "n"])},
                "ledger_closing_cash": [r(x, 2) for x in led[pid]],
            }
        )
    return out


def main():
    prof, cash, assets, liab, goals, assum, catalog = load()
    checks = validate_ledger(cash)
    panel = build_panel(prof, cash)
    beh = fit_behaviour(panel)
    reg = fit_regressions(prof, beh["personal"])
    bt = backtest(prof, panel)

    params = {
        "version": 1,
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
        "season": beh["season"],
        "bonus": beh["bonus"],
        "shock_quantiles": beh["shock_quantiles"],
        "shock_autocorr_lag1": beh["shock_autocorr_lag1"],
        "regressions": reg,
        "anchors": anchors(prof, assum),
        "backtest": bt,
        "catalog": catalog.rename(columns={"scenario": "name"})[["id", "category", "name", "baseline", "intervention"]].to_dict("records"),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "params.json").write_text(json.dumps(params, indent=1, ensure_ascii=False))
    profiles = export_profiles(prof, panel, beh["personal"], assets, liab, goals, assum)
    (OUT / "profiles.json").write_text(json.dumps(profiles, separators=(",", ":"), ensure_ascii=False))

    print("data checks     ", checks)
    print("bonus           ", {k: (v["probability"], v["size_quantiles"][10]) for k, v in beh["bonus"].items()})
    print("shock autocorr  ", beh["shock_autocorr_lag1"])
    for k, v in reg.items():
        print(f"{k:16s}", v["form"], "cv_r2", v["cv_r2"])
        print("                ", dict(zip(v["features"], v["coefficients"])))
    print("backtest        ", json.dumps(bt, indent=1))
    print(f"wrote {OUT / 'params.json'} and profiles.json ({len(profiles)} profiles)")


if __name__ == "__main__":
    main()
