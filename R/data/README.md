# External data (public, Switzerland)

`worldbank_che.csv` is downloaded once by `Rscript R/macro.R` (if the file is missing) and kept in the repo so every run is reproducible offline.

| Column | Indicator | Source | Years |
|---|---|---|---|
| `inflation_pct` | Inflation, consumer prices (annual %), `FP.CPI.TOTL.ZG` | World Bank API, country `CHE` | 1960–2025 |
| `unemployment_pct` | Unemployment, total (% of labour force, modelled ILO estimate), `SL.UEM.TOTL.ZS` | World Bank API, country `CHE` | 1991–2025 |

- Licence: World Bank data, CC BY 4.0 (attribution: The World Bank, World Development Indicators).
- Interpretation (from `pre_docs/resources/data/swiss-economic-data.md`): national annual rates. Inflation is not a personal spending index, and an aggregate unemployment rate is not a personal probability. The twin turns them into a personal risk only through labelled assumptions (`R/output/macro_parameters.csv`, block `labour_assumption`).
- The ILO rate (~4.9% in 2025) is higher than SECO's registered rate (2.8% in 2025): the ILO definition also counts people who are not registered. The twin scales the forecast ILO rate by `registered_share` (their 2025 ratio), so it matches the SECO duration (also a registered figure) in the job-loss flow `s = f·u/(1−u)`, `f = 1/duration`.
- Only employees can lose their job in the twin: the self-employed are not insured against unemployment in Switzerland.

Labour-market facts used as assumptions (sources in `macro_parameters.csv`):
- 70% of insured earnings (80% with children to support or an insured salary ≤ CHF 3,797/month), insured earnings capped at CHF 148,200/year (SECO, AVIG Art. 22).
- Up to 400 daily allowances (~18 months) with ≥ 18 months of contributions, 200 (~9 months) under 25 without children, 520 (~24 months) from 55 (AVIG Art. 27).
- Average unemployment duration ~7 months (swissinfo.ch, citing SECO data).
