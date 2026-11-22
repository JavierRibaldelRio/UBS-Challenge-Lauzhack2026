# Dev notes: how everything works, and how to change it

Simple English, one topic per section. If you only read one thing, read **0** and the **"I want to…"** table at the end.
Setup and run commands are in the [README](README.md#1-run-the-demo).

---

## ★ What the model actually does, and why we call it a Financial Twin

**The definition UBS gives** (`pre_docs/docs/scenario-modelling.md` §2): a twin evolves a financial state x<sub>t</sub> with x<sub>t+1</sub> = F(x<sub>t</sub>, a<sub>t</sub>, w<sub>t</sub>; θ), and *"must distinguish user-controlled decisions from external conditions."* Our model is exactly that, month by month:

| Part | In plain words | Where it comes from | Certain / learned / assumed |
|---|---|---|---|
| **x<sub>t</sub>** the state | cash, investments, home, debts, income, rent, spending, job, household, goals | the person's rows in the 6 CSV files | data |
| **F** the transition | the bookkeeping: cash + income − spending − costs − payments; net worth = assets − debts | formulas | **certain**, checked live |
| **a<sub>t</sub>** decisions (idiosyncratic) | the life events of a path: study, job, move, home, kid, loan… | you (chat or buttons); missing amounts filled from the data | assumed, every number labelled |
| **ε<sub>t</sub>** personal luck (idiosyncratic) | surprise expenses, December bonus, uncertainty about your usual spending | **estimated in R** (`R/eda.R`, mixed model) from 28,800 months | **predicted & tested**: 80% range caught 78.2% of real 2026 results |
| **w<sub>t</sub>** the economy (macroeconomic) | inflation vs pay, unemployment, interest rates, market returns, recessions, house prices | the economy you pick: **"Forecast (Swiss data)"** = inflation + unemployment drawn per future from a model of Swiss data (`R/macro.R`, World Bank 1991–2025); stress-test presets = UBS scenarios S101–S110; or say it in the chat | forecast: **estimated & tested** on 2005–2024; presets: assumed. Always **shared by every path** |
| **θ** parameters | spending by status × city × month, bonus odds and sizes, spread of surprises, VAR coefficients, peer ranges | `R/eda.R`, `R/macro.R` (→ `pnpm model:import`); peer ranges from `ml/train.py` | estimated |

**Two kinds of variables (as the UBS presenter put it): idiosyncratic and macroeconomic.**
- **Idiosyncratic = this person.** Their income, rent, spending habit, decisions, and personal luck. These differ per path and per person. One message can contain them ("I do a master's").
- **Macroeconomic = the whole economy.** Inflation, rates, markets, recession, house prices. **One setting for every path** (the "🌍 The economy" bar), so decisions are always compared under the same conditions. The same message can contain them too ("…and there's a recession in 2 years"): the chat puts the decision in a path and the recession in the economy.
- **In the Monte Carlo** each future draws **personal luck** (estimated) and, depending on the economy, **economy luck**: with "Forecast (Swiss data)" its own yearly inflation and unemployment (and so the chance that an employee loses their job), with "Uncertain economy" random recessions (~1 in 10 years). Economy luck is the same for every path in that future.

**Does anything actually *predict*?** Two parts. (1) Personal luck: it predicts the *spread* of normal months, not life outcomes. Tested properly: estimated on 2025, the app's own simulator predicted 2026, compared with reality for 1,200 people (calibration 10% → 10.4%, 50% → 50.1%, 90% → 89.1%; "A ends higher than B" statements on 19,980 pairs: said 99.9% → 99.9% true). (2) The economy forecast: national inflation and unemployment, tested on 2005–2024 (1 year ahead the 80% range held 70% of the time for inflation, 95% for unemployment). Decision effects are **not** predicted, because the data contains no decisions. They are explicit, labelled assumptions, and unknowns are drawn dotted. The national unemployment rate is turned into a personal risk only through labelled assumptions (same chance for every employee). Stress-test economies are not forecasts. That matches UBS FAQ #18: *"Can we claim our model is accurate? Only to the extent supported by validation evidence."*

**Why it is a twin and not a calculator** (UBS capabilities C01–C20, `ai-and-technology.md` §2):
- **personalized:** it starts from *this* person's data: status, city, income, rent, savings, goals, and their own spending spread (C01, C02). (A persistent personal spending *level* beyond status and city does not exist in this data: σ<sub>u</sub> ≈ CHF 16, see §2);
- **updates itself:** "I now earn 1,500" changes its state (C03, C14);
- **reacts to decisions:** in plain words, including follow-ups and corrections (C04, C05, C07, C13);
- **distinguishes decisions from external conditions:** paths vs the economy (§2 of scenario-modelling);
- **constraints:** funding gaps, down payment from own cash, debt ≥ 0 (C08);
- **compares paths fairly:** same luck, same economy (C09);
- **uncertainty:** ranges, drivers, break-even, unknowns, economy (C10);
- **goal tracking** (C11);
- **explains itself:** answers, stories, "how did the twin get this?" (C12, C18);
- **validated:** live checks, spending and economy backtests, 95 + 67 tests (C15, C19);
- **transparent:** every number tagged data / learned / you / assumption / unknown / economy (C16, C17);
- **responsible:** no advice, "in this simulation", fictional (C20).

### Checked against the UBS brief (the deck's "What success looks like after 24 hours")

| UBS asks | Status | Where |
|---|---|---|
| MUST · Fictional client profile | ✅ 1,200 fictional people from UBS's data; Alexia by default | person line, profile picker |
| MUST · One working scenario | ✅ 12 event types, any combination, in plain words; 7 ready-made paths | chat, `+` buttons |
| MUST · Before / after comparison | ✅ any two paths side by side (A green / B blue): tiles, year-by-year charts, the 4 UBS measures, answer in the chat | A/B tiles, comparison, chart |
| MUST · Transparent assumptions | ✅ every number has a source tag and a note, editable; unknowns marked and dotted; prompt visible | "The numbers behind", "how did the twin get this?" |
| BONUS · Conversational AI | ✅ a chat that answers, acts, remembers context, updates itself, edits paths, checks its own numbers | chat |
| BONUS · Sensitivity & uncertainty | ✅ Monte Carlo (personal + economy luck, calibrated on real data), drivers, break-even, peer-range robustness, unknown ranges, economy stress tests | chart bands, "what matters most", answer confidence, economy bar |
| "Success is helping someone understand a decision" | ✅ direct answers with computed confidence, plain-English story, break-even ("pays off only if salary +23%") | answer card, story card |

**Also from the guidelines:**
- **Demo order** (`evaluation/demo-and-submission.md`): problem → initial state → intervention → calculation → comparison → trade-offs → validation. This is followed in `demo.txt`.
- **Validation list** (`technical-validation.md`): cash identity, net worth identity, scenario isolation, boundary cases. Covered by the tests and the live checks.
- **Reporting template** (`scenario-modelling.md` §20): the **"⬇ scenario report (UBS template)"** link exports all 15 fields for the selected path.
- **FAQ rules:** inflation applied to *all* costs including one-offs; real vs nominal stated (constant 2025 francs); negative cash = funding gap; no silent currency conversion; "most money ≠ best" (answers mention cash risk).

**Honest gaps:** taxes are not modelled (incomes are net, as in the data); there's no optimizer that finds the best plan for you (break-even is a 1-D version); no game or RL; the twin doesn't yet re-learn from new months of bank data (only from facts you tell it).

## 0. The one-minute version

```
 you type a question ──► LLM #1 turns it into JSON ──► RESOLVER fills every missing number from the data
                                                             │
                                                             ▼
 you read a paragraph ◄── LLM #2 writes it ◄── facts ◄── ENGINE runs 500 possible futures per choice
 (every number in it is checked against the engine)          │
                                                             ▼
                                         scenario tree, A/B tiles + comparison, charts, break-even, checks
```

- The **LLM never does maths**. It only (1) turns words into a fixed JSON format and (2) turns computed numbers into words.
- The **engine** is normal code: exact accounting formulas plus randomness from **models estimated in R**: monthly spending from the data (`R/eda.R`), and, in the forecast economy, Swiss inflation and unemployment from public data (`R/macro.R`).
- **Every number** on screen has a source label: `from data`, `learned`, `you`, `assumption`, or `unknown`.
- If the AI or the internet fails, the app still works. Questions use keyword rules, and the paragraph comes from a template.

**Where things run:**

| Piece | Language | Folder | Runs when |
|---|---|---|---|
| Training (learn from data) | Python (numpy, pandas) | `ml/` | once, offline, ~5 seconds. Output is committed. |
| LLM gateway | TypeScript on Node | `backend/` | during the demo, port 8000 |
| Engine, resolver, UI | TypeScript, React | `frontend/` | in the browser, port 5173 |

---

## 1. The data (`pre_docs/Data/`)

Given by UBS. All fictional.

| File | What's in it | How we use it |
|---|---|---|
| `synthetic-profiles.csv` | 1,200 people: age, city, job status, household, net income, rent, starting cash | the person's starting state; medians become defaults |
| `synthetic-cash-balances.csv` | 24 months (2025-01 to 2026-12) of opening/net/closing cash for each person = 28,800 rows | **training data** for the model, plus the "real ledger" dots on the chart |
| `synthetic-assets.csv` | cash and investment snapshot per person | starting investments |
| `synthetic-liabilities.csv` | 283 personal loans (principal, rate; payment is always 0) | starting debt; median rate for new loans |
| `synthetic-goals.csv` | 1–3 goals per person (amount and date) | 🎯 markers and "goals reached" |
| `scenario-assumptions.csv` | study length (2 years) and tuition (1,200 / 2,500 / 4,800 / 8,000 per year) for 120 people | default tuition and study length |
| `scenario-catalog.csv` | 120 scenario ideas | the LLM tags each path with the closest idea (`catalog_id`) |

**Quirks (good to know, and to say in Q&A):**
- The README in `pre_docs/Data` lists files that don't exist (transactions, life-events, alexia-profile.json).
- The ledger only has the **net** flow per month, so we treat income as constant and say *spending = income − net flow*.
- Income does **not** depend on age (about CHF 8k net for employed people at every age). So "start working at 20" looks very rich. The salary is editable.
- Spending barely depends on income. Nobody in the data has an education level or lives abroad.
- The ledger's maths is perfect: 0 identity errors and 0 continuity errors. We check this in training.

---

## 2. The model (estimated in R: `R/eda.R`, `R/macro.R`)

### What "model" means here
We do **not** train a model to predict "what if I do a master's?". The data has nobody doing a master's, so that's impossible to learn honestly. We estimate **how months behave**: what people in a given situation spend each calendar month, how much it jumps around, when bonuses come. The engine then uses that to make realistic futures. The models are estimated in **R**; the app (TypeScript) only **reads** their estimates and runs the Monte Carlo.

```
Rscript R/eda.R    -> R/output/model_parameters.csv, client_effects.csv   (+ *_fit2025.csv: 2025 only, for the backtest)
Rscript R/macro.R  -> R/output/macro_parameters.csv, macro_backtest.csv, macro_forecast.csv   (data: R/data/worldbank_che.csv)
cd ml && uv run train.py          -> params.json (data checks, defaults/peer ranges, catalog), profiles.json (the 1,200 people)
cd frontend && pnpm model:import  -> src/model/spending.json, macro.json (+ spending_fit2025.json, tests only)
cd frontend && pnpm backtest      -> src/model/backtest.json
```

### Monthly spending (`R/eda.R`, linear mixed model, FGLS)
"Spending" = everything except rent (income − rent − net flow). Four structures were compared by BIC; the chosen one:

```
spending[i, t] = base[status, calendar month] + city offset + u_i + ε,     ε ~ N(0, (σ_i · k[status, month])²)
December bonus = Bernoulli(p[status]) × size × monthly income             (size: one of 10 equally likely values)
```

| Part | Result today |
|---|---|
| **base[status, month]** | employed: CHF 1,464 in a regular month, +373 in February, +357 in August |
| **city offset** | Fribourg −121 … Zurich +176 CHF/month vs the average city |
| **students' Feb / Sep peaks** | +1,045 / +835 (tuition-like). **Left out inside a `study` event**, whose tuition is explicit (no double counting) |
| **u_i** personal offset | σ<sub>u</sub> ≈ **CHF 16**: no persistent personal spending level beyond status and city. Checked directly: a person's 2025 deviation does not predict 2026 (correlation −0.04) |
| **σ_i** spread | each person's own regular-month SD, shrunk toward people like them (log σ ~ status + log income), with the small-sample bias of a log SD undone (+6%); × k ≈ 1.5 in Feb / Aug |
| **December bonus** | employed: 55% of years, typical size 60% of a month's pay; self-employed: 27%, 91% |
| **Defaults** (`train.py`) | medians: income by status × age band, rent by city × household, with peer ranges (10th–90th percentile) |

**What changes spending in a scenario:** status (e.g. student → employed), city (relocate), the calendar month, and the person's own correction if they tell the twin ("I spend 2,000 a month": the offset is kept). Income, household and age do not move the level in this data; income changes the spread.

### Economy forecast (`R/macro.R`, VAR(1))
Annual model of Swiss **inflation** and **log unemployment** (World Bank: CPI inflation 1960–2025, ILO unemployment 1991–2025, CC BY 4.0), fitted by OLS on 1992–2025, stationary (|eigenvalues| 0.70, 0.43). Used only by the economy **"Forecast (Swiss data)"**:
- **2025 = observed** (inflation 0.15%, unemployment 4.9%); every simulated future then draws its own years.
- **Prices vs pay:** pay follows *last year's* inflation (Swiss wage rounds), prices follow this year's, so costs (rent, spending, extra and one-off costs) run ahead of pay while inflation rises.
- **Job loss (employees only, the self-employed are not insured):** job-finding chance f = 1/7 per month (average duration ~7 months, SECO via swissinfo.ch; labelled assumption, editable); job-loss chance s = f·u/(1−u), u = the forecast rate scaled to SECO's registered rate (2.8% in 2025). The same for every employee: an aggregate rate is not a personal probability.
- **While unemployed:** benefit 70% of pay (80% with children or pay ≤ CHF 3,797/month), insured pay ≤ CHF 148,200/year, for 18 months (9 under 25 without children, 24 from 55) (AVIG Art. 22, 27); then the typical income of unemployed people in the data. Spending and its spread switch to R's "unemployed" group; no December bonus.

### How we know it's right: the backtests
**Spending (`pnpm backtest`, `src/test/backtest.ts`):** R estimates everything on **2025 only**; the app's own engine (`resolve` + `runPath`) simulates 2026 for all 1,200 people (1,000 futures each) from their real Dec-2025 cash and compares with the real 2026 ledger:

| | R model (now) | previous model (ml/train.py) | simple average |
|---|---|---|---|
| "8 in 10" range caught | **78.2%** | 78.5% | — |
| middle-half range caught | **50.1%** | 49.8% | — |
| typical error at year end | **CHF 1,831** | CHF 2,281 | CHF 2,445 |
| cash-crunch score (Brier, lower = better) | **0.0006** | 0.0012 | 0.0025 |

The previous model started from each person's own 24-month average; since that average does not persist, it carried noise forward (larger error) and needed a wide parameter-uncertainty band to compensate.

**Calibration curve:** does "we said X%" match reality at every level, not just at 80%?

| we said | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% |
|---|---|---|---|---|---|---|---|---|---|
| really happened | 10.4% | 22.0% | 30.3% | 41.5% | 50.1% | 59.6% | 69.4% | 78.3% | 89.1% |

**"A ends higher than B" statements:** the answers say things like "in X% of futures, A ends higher". We tested exactly that kind of sentence on **19,980 random pairs of real people** (2026):

| we said | 0.1% | 12% | 34% | 66% | 89% | 99.9% |
|---|---|---|---|---|---|---|
| really happened | 0.1% | 9% | 32% | 63% | 89% | 99.9% |

So when we say "≥ 95%", the data says it was true 99.9% of the time. That is why a **high-confidence** answer needs at least 95%.
The "cash goes below zero" probabilities are calibrated too (said <5% → 0% happened, said >95% → 100% happened).

**In-sample check (`pnpm test`):** the real month-24 cash lies inside the 80% band for 938 of 1,200 people (78%). One of the 22% outside is Alexia (P00001): she spent ~CHF 280/month less than similar students, so her real cash dots sit above the band in year 2. That is the honest answer under a model where personal levels don't persist.

**Economy (`R/output/macro_backtest.csv`, rolling origin 2005–2024):**

| | 1 year ahead | 2 years | 3 years |
|---|---|---|---|
| inflation: 80% range held | 70% | 68% | 67% |
| inflation: error vs "same as last year" | 1.04 vs 1.18 pts | 1.14 vs 1.46 | 1.19 vs 1.47 |
| unemployment: 80% range held | 95% | 95% | 89% |
| unemployment: error vs "same as last year" | 0.44 vs 0.40 pts | 0.61 vs 0.59 | 0.69 vs 0.59 |

Inflation ranges are a bit narrow, unemployment ranges a bit wide; for unemployment the model is not more accurate than repeating last year, it mainly adds the range.

These numbers are in `backtest.json` / `macro.json` and shown in the app under *Can you trust this?*.

### Outputs
- `frontend/src/model/spending.json` (150 KB) + `macro.json` (4 KB): the R models, written by `pnpm model:import` (never edit by hand).
- `frontend/src/model/backtest.json`: written by `pnpm backtest`; `pnpm test` recomputes it and fails if it no longer matches.
- `frontend/src/model/params.json` (35 KB) + `profiles.json` (760 KB): data checks, defaults, catalog, every person's starting state, goals and real ledger (`ml/train.py`).

All are **bundled into the frontend**, so there's no loading step that could fail during a demo. Everything is deterministic (fixed seeds): same data, same files.

### How to change it
- **Spending model:** edit `R/eda.R`, run `Rscript R/eda.R`, then `cd frontend && pnpm model:import && pnpm backtest && pnpm test`. Keep a change **only if the backtest numbers get better**. The import script checks the shape (6 statuses × 12 months, 12 cities, 1,200 clients) and that base + city + u rebuilds R's own per-person number.
- **Economy model:** edit `R/macro.R` (labour assumptions are in its `labour_assumption` block, with sources), run `Rscript R/macro.R`, then `pnpm model:import`. Delete `R/data/worldbank_che.csv` to download fresh World Bank data.
- **Defaults / people:** `cd ml && uv run train.py` (thresholds at the top: `MIN_GROUP`, `SEED`). Add a dependency: `uv add <pkg>==<version>`.

### Do we need GPUs (Together GPU clusters)?
**No, not for this.** Training is 1,200 people × 24 months, about 5 seconds on a laptop CPU. A GPU would not help, and a big neural network would just overfit 28,800 rows.

When Together compute *would* make sense:
- **Managed fine-tuning** (no cluster needed): `tg files upload train.jsonl`, then `tg fine-tuning create --training-file <id> --model <base> --lora`. This would teach a small LLM our JSON format. Today DeepSeek already gets 11/11 of our live test questions right, so this isn't needed.
- **GPU clusters** (H100 from about $2–4 per GPU-hour, launched in the console at `api.together.ai/clusters` or with `tg clusters create`): only for training large models from scratch. Not useful with this data size.

---

## 3. The engine and Monte Carlo (`frontend/src/lib/sim.ts`)

### One month, one future
For every month `t`:
```
income    = planned income (+ maybe a December bonus: Bernoulli(p) × size × income)
            [forecast economy: if an employee loses the job → benefit, then the typical unemployed income]
spending  = (rent + otherMu[t] + error of the personal offset + otherSd[t] · z) × cost multiplier      z ~ N(0, 1)
            otherMu[t] = base[status, month] + city offset + u (− students' Feb/Sep peaks inside a study event)
            otherSd[t] = σ_i × spread change with status & income × k[status, month]
            cost multiplier = 1, except in the forecast economy (prices vs pay)
available = cash + income + new loans − spending − extra costs − one-off costs − loan payments − down payments
            (extra and one-off costs are scaled by the same cost multiplier)
invest    = invest × (1 + r)  then  + money moved in (end of month)   × (1 − market shock)
            money moved in ≤ available cash (budget constraint) ; selling (negative) ≤ what is held
cash      = available − money moved in
debt      = debt + interest − loan payment          (never below 0)
net worth = cash + invest + homes/assets − debt
```
All amounts are CHF per month, in 2025 francs (constant purchasing power). Income is after tax.

### Investments (all checked against UBS's own formulas in `pnpm test`)
- **Return** r = the economy's yearly return, applied as the monthly rate (1 + R)^(1/12) − 1, so 12 months compound to exactly R. Default **R = 4%**, UBS's illustrative rate (`financial-concepts.md` §6: "CHF 10,000 at 4% for five years ≈ CHF 12,167"); the test reproduces 12,167 exactly. Monthly saving matches UBS's annuity formula FV = A((1+r)^n − 1)/r exactly (`scenario-modelling.md` §5, contributions at the end of each period).
- **Where the return goes:** into the investments' value, so into **net worth**. Never into cash, never into income. Cash only changes when money is moved in or out.
- **The return is an economy condition** (UBS §2 lists "investment returns" under external conditions w): one setting shared by every path, so two paths are compared under the same markets. "Invest 200 at 7%" sets the economy's return to 7% for every path, and the chat says so. With "Uncertain economy" it also has ups and downs (volatility) and random recessions.
- **Selling / withdrawals** (UBS catalog S068, S098): a negative `invest` amount moves value back to cash; never more than is held; net worth unchanged that month.
- **Budget constraint** (UBS `scenario-modelling.md` §14): money is only invested if it is there. When cash is short, the planned amount is skipped (the tile says "investing skipped when cash is short"). Before this rule, a broke person "investing" 500/mo looked 13k richer from money she never had.
- **Not learned from data:** the CSVs hold one snapshot of investments, no returns, so nothing can learn them honestly. That is why the return is a labelled, editable assumption with UBS's illustrative value, not a learned number.

### Raises
A raise is permanent (no duration). `income_change` with `repeat_every_months: 12` = a yearly raise that compounds (+2% for 10 years = ×1.02^10 ≈ +21.9%). Separate permanent raises also stack (×1.02 × 1.02). A change WITH a duration is temporary (job loss, part-time for a while). UBS lists income growth as an assumption to make explicit (`scenario-modelling.md` §11).

### Many futures (Monte Carlo)
- We run **500 futures** per path. Each draws different surprise months, bonuses, the error of the personal offset and (if set) market returns from the estimated model; with "Forecast (Swiss data)" also its own yearly inflation and unemployment (2 normals per year) and job loss / finding (2 uniforms per month, always drawn, so paths stay aligned).
- From these we get the **median line**, the **shaded range** (10th–90th percentile = "8 in 10 futures land here"), the **% of futures where cash goes below zero**, and the **% where a goal is reached**.
- **Same random numbers for every path** ("common random numbers"). So when two paths differ, it's because of the decision, not luck.
- **Fixed seed** (`params.seed`): every refresh and every laptop gives the same result.
- Speed: 4 paths × 500 futures × 120 months takes milliseconds in the browser.

### Live accounting checks (`checks()`)
These run on the selected path every time anything changes. You can see them under *Can you trust this?*:
1. opening + inflows − outflows = closing, every month
2. net worth only moves with income, spending, costs, interest and investment growth. Moving money into investments or repaying principal doesn't change it.
3. debt is never negative
4. same seed gives identical results
5. negative cash is flagged

### How to change it
- **More or fewer futures:** the `paths` argument of `simulate()` (default 500).
- **A new kind of money flow:** add an array to `Plan` in `resolve.ts`, fill it there, and use it in `runPath` (cash line and ledger row). Then make sure `checks()` still passes (`pnpm test`).
- **Turn on market noise:** the investment return and volatility pills (default 0%). They are `g.ret` / `g.vol` in `resolve.ts`.

---

## 4. The resolver: from JSON to a month-by-month plan (`frontend/src/lib/resolve.ts`)

Input: the person + a list of **events** (from the LLM, a preset button, or the offline parser). Output: a `Plan` (arrays of income, rent, spending etc. for every month) plus a list of **assumptions**. Each assumption has a source label and a short note saying where the number comes from.

### The 12 event types

| type | what it does | default when a number is missing |
|---|---|---|
| `start_job` | status → employed, income → salary | median salary for employed people of that age band (**data**) |
| `study` | status → student for N months, tuition every 6 months, then a job | length and tuition from `scenario-assumptions.csv` (**data**); salary premium = 0% (**unknown**) |
| `relocate` | new rent (and income if given) from that month | known Swiss city: median rent there (**data**); abroad: keeps current values (**unknown**); moving cost 0 (**unknown**) |
| `income_change` | income × (1 + %) for a while or forever; with `repeat_every_months` a recurring raise that compounds | % not given → 0 (**unknown**) |
| `household_change` | single / couple / family / shared housing | median rent for that household in that city (**data**) |
| `recurring_expense` | extra monthly cost | amount not given → 0 (**unknown**) |
| `one_off` | single cost (>0) or money in (<0) | 0 (**unknown**) |
| `invest` | monthly amount and/or lump sum moved into investments (only if the cash is there); negative = selling | 0 (**unknown**) |
| `market_shock` | investments fall by X% | 30% (**assumption**) |
| `take_loan` | cash now, monthly repayments | median rate of the 283 loans (**data**); 5-year term (**assumption**) |
| `buy_home` | own money (down payment) leaves cash, a mortgage is paid to the seller, the home is added to net worth, rent stops, upkeep starts. Interest-only mortgage | price: **unknown** (must be set; without a price nothing happens and the card warns "needs a price"); down payment 20%, mortgage 2%, upkeep 1%/yr (**assumption**) |

| `buy_asset` | buy something you keep that is not a home (car, motorbike, boat, equipment): own money leaves cash, the item becomes an **asset** that **loses value every year**, optional loan, monthly running costs | price: **unknown** until set; paid in full (100% own money), loses 15%/yr, loan over 4 years at the data's median rate (**assumption**); running costs **unknown** |

**What events are based on:** the 12 types are fixed (they cover UBS's scenario categories). Their default numbers come from the data where it has them (salary, rent, tuition, loan-rate medians), otherwise they are labelled assumptions or "unknown". **Assets** = everything you own besides cash and investments (homes and `buy_asset` items). Value changes without money moving (a car losing value, a house-price drop) are recorded separately (`revalue`), so the live "net worth = assets − debts" check stays exact.

**Buying a home: why cash drops but net worth doesn't.** On the purchase month, cash falls by the down payment (e.g. 120k for a 600k flat). Net worth stays flat, because that money became part of a home worth 600k and the mortgage covers the other 480k. In the **Net worth** view the selected path also shows its **cash (dotted)**, its **assets (green: home, car…)** and its **debt (red, below zero: mortgage and loans)**, a 🏠/🚗 marker shows the month, and a note says it in words: "cash −200,000, debt +800,000 (mortgage), assets +1,000,000".
**Down-payment check:** a down payment must come from money you *have* (banks require own funds). In every one of the 500 futures the engine checks cash just before the purchase (`SimResult.homeBuys`). The card shows "🏠 down payment OK", "⚠ down payment short in X%" or "⚠ can't pay the 60k down payment at 25". "Can I afford a flat…?" questions answer **no** if the own money is missing (tested: a student with no job, flat 300k at 25 → 0%, "No").

**One path can hold many events.** "Do a master's now, lose my job at 25 and buy a flat at 28" becomes **one path with 3 events** (one line on the chart). "Master's **or** work?" becomes **two paths** (two lines). One question can create 1–3 paths.

Events are applied **in time order**, so "study, then move" works.

After the events, the resolver builds **non-rent spending month by month from the R model**: base[status, month] + city offset + the person's offset. When status or city changes, spending changes by what the model says (shown as a `learned` line, "Spending response to the new situation"); inside a `study` event the students' Feb / Sep peaks are left out because the event pays tuition explicitly.

### The five source labels

| label | meaning |
|---|---|
| `from data` | read from the CSVs, or a median of them |
| `learned` | estimated in R (`R/eda.R`) from all 1,200 ledgers |
| `you` | typed, edited, or said in the question |
| `assumption` | not in the data; a stated default (e.g. a preset's numbers, 0% investment return) |
| `unknown` | nobody knows; we use "no change" and highlight it in red so the user can set it |

### How to add a new event type (checklist)
1. `backend/schema.ts`: add it to `EVENT_TYPES` (reuse the existing fields if possible).
2. `frontend/src/lib/types.ts`: add it to `EventType`.
3. `frontend/src/lib/resolve.ts`: add a `case` in `applyEvent`. Every number goes through `A(...)` with a source label.
4. `backend/server.ts`: add one line to the rules in `parseSystemPrompt` explaining when to use it.
5. Optional: `fallback.ts` keyword rule and a preset in `presets()`.
6. Add a test in `frontend/src/test/engine.test.ts`, then run `pnpm test` and `pnpm test:live`.

---

## 5. Analysis: why, break-even, facts (`frontend/src/lib/analysis.ts`)

- **What matters most** (`drivers`): nudge each input by ±10% (return by ±1 point), rerun without randomness, and measure how far the end net worth moves. The longest bar matters most.
- **Break-even** (`breakEven`): "how much would income have to change, from the moment of the decision, for this path to end level with the baseline?" Solved by bisection. This is how we handle **unknowns honestly**: instead of guessing the master's salary premium, we say "it pays off only if salary is +23%".
- **Facts** (`buildFacts`): a small JSON with rounded results (medians, ranges, risk %, goals, drivers, break-even, unknown inputs). **This is the only thing LLM #2 sees.**
- **Number check** (`verifyNumbers`): takes every number in the AI paragraph (understands "254k", "12,000", "35%") and looks for it in the facts. The UI shows "✓ all 13 numbers checked against the model", or lists the ones it couldn't find.
- **Template** (`templateExplanation`): the paragraph used when the AI is offline. It also appears instantly while the AI is writing.

- **Same random months, compared one by one:** every path uses the same 500 random futures, so "in 98% of futures A ends higher" compares future #1 of A with future #1 of B, and so on.

---

## 5b. Answering the question, and how confident to be (`frontend/src/lib/answer.ts`)

The A/B comparison describes the two selected paths. When someone **asks a question**, they also get a separate **direct answer** in the chat bubble (with "why?" for the reasons). It holds a direct answer (*"No. … the chance is 0%"*, *"Starting work ends higher…"*) plus a **confidence level computed by the app, never by the AI**.

**Which paths are compared:** the paths the question created. One new path is compared with the baseline; several are compared with each other (the two that end highest).

**Three kinds of question**, detected from the words:

| kind | example | answered by | confidence comes from |
|---|---|---|---|
| goal | "Can I reach my emergency savings goal by 2029 if…?" | the share of futures that reach the goal (from `synthetic-goals.csv`) | how far that share is from a coin flip: ≤5% or ≥95% is clear-cut |
| afford | "Can I afford a flat for 600k at 28…?" | the share of futures where cash never goes below zero | same |
| compare | anything else ("A or B?", "what if…?") | which path ends higher | the three checks below |

**The three checks for "compare":**
1. **Luck:** in how many of the 500 paired futures does the leader end higher? Differences below max(CHF 1,000, 0.2%) count as "the same" (e.g. investing at 0% return = a tie, not a win). **Backed by data** (the table in §2: ≥95% statements were right 99.9% of the time).
2. **Peer range from the data:** re-run with the leader's data-based numbers (salary, rent) at the **unlucky end of real peers** (10th/90th percentile) and the other path's at the **lucky end**. Does the leader still win?
3. **Unknowns:** does the result depend on a number nobody knows (degree premium, rent abroad)? Only unknowns that **actually change the result** count. We test each one; an unknown overridden by another event doesn't matter. If it matters: how far would income need to move to flip the result (break-even)?

**Rules:**
- **High:** luck ≥ 95% AND the peer test holds AND no unknown that matters (unless break-even > 50%).
- **Medium:** luck ≥ 80% AND (peer test holds OR break-even ≥ 20%).
- **Low:** everything else (e.g. a salary change of 9% would flip it).

The card lists the reasons in plain words.

**The AI's job:** it gets `answerFacts()` (numbers + confidence + reasons) and must (a) answer the question as asked, in the user's language, (b) use only those numbers, (c) copy the confidence level into a `confidence_level` field. The app checks the numbers (✓ N/N) and warns if the level differs.

**Tested live** (`pnpm test:live`, "complex + answer"): nine hard sentences. They include two paths with nine events and exact mortgage terms; a loan + master + "salary 15% higher afterwards"; "70% unemployment benefits" → −30%; an inheritance where half is invested; French; GBP (not converted, flagged); a long rambling sentence; a goal question; an afford question. All pass, every answer has 100% of its numbers verified, and the AI copied the computed confidence every time.

---

## 5c. Why Monte Carlo — and what the challenge docs say

The UBS docs (`pre_docs/docs/ai-and-technology.md` §9, `digital-twin-concepts.md`) are explicit: *"Monte Carlo… is not the definition of a Financial Twin… not inherently equivalent to forecasting."* A twin is defined by capabilities (C01–C20): representation, **scenario creation**, **counterfactual comparison**, **constraints**, **uncertainty exploration (C10)**, **goal tracking (C11)**, **validation (C15)**, **transparency/provenance (C16–C17)**, **state updating (C03/C14)**.

What that means for us:
- **Monte Carlo only covers one kind of uncertainty: normal month-to-month luck.** We keep it because it is the honest way to get ranges, cash-crunch risk and goal chances from the *learned* behaviour, and it is **calibrated against real data** (§2). Here it is a tool, not the product.
- **The uncertainty that decides "master's or work?" is about the assumptions**, not about luck. The docs point to sensitivity analysis, robust decisions, Bayesian parameter uncertainty and causal reasoning. We cover it with:
  - **sensitivity** ("what matters most" bars, §5);
  - **break-even / goal-seeking**: a 1-D optimization (docs §10, §30) that turns an unknown into a question you can answer ("does a master's raise pay 23%?");
  - **robustness against real peer ranges** (answer confidence, §5b);
  - **parameter uncertainty**: the personal spending offset is sampled with its posterior SD from the mixed model, a Bayesian-style step (docs §20);
  - **explicit unknowns** (red "unknown" tags) instead of silent guesses.
- **Causal (docs §19, P(Y|X) ≠ P(Y|do(X))):** our decisions act on an explicit **structural model** (income, rent, costs, debt). "Do a master's" is a *do()*-operation on the plan, not a correlation from the data. The one correlational piece is the *spending response* to a new status or city (from the R model); it is labelled `learned`.
- **Not built yet (honest next steps):** **state updating** (C03/C14: add a new month of real data → re-calibrate the person), and **multi-stage planning / optimization** ("what's the latest age I can buy a flat and keep cash > 0?"). Both fit the current engine.

---

## 6. The LLM and the backend (`backend/`)

### What the backend is
A ~170-line Node server (`server.ts`) with no framework. It holds the API key and talks to **any OpenAI-compatible API**. Today that's **Together AI** with `deepseek-ai/DeepSeek-V4.1-Flash-1017`, reasoning **off**.

| endpoint | in | out |
|---|---|---|
| `GET /api/health` | – | which model, JSON mode, reasoning |
| `GET /api/schema` | – | the exact JSON Schemas we demand |
| **`POST /api/chat`** (used by the app) | the new message + **the last 12 chat messages + the twin's current STATE (income, rent, cash, spending, goals, "if nothing changes" results) + every PATH on screen (id, events, results) + selected/target path** | `{ reply, profile_update, new_paths[] (each may name a `parent_id`: a branch lists only its new events), edits[] {path_id, path | null, add_events[], changes} (several paths at once, e.g. "add to all"), remove_path_ids[], macro_update, horizon_years, unsupported[] }`: the twin talks **and** acts in one turn |
| `POST /api/parse` | question + person summary + city list + scenario catalog | `{ scenarios[], horizon_years, unsupported[], note }` (older single-purpose endpoint, kept for tests and tools) |
| `POST /api/explain` | `{ facts }` | `{ headline, explanation, caveat }` |
| `POST /api/compare` | `{ facts }` from `compareFacts()` (A and B) | `{ first: {so_far, ahead}, second \| null, comparison, caveat }`: the tiles and the A vs B text |
| `POST /api/answer` | `{ facts }` from `answerFacts()` | `{ short_answer, reasoning, confidence_level, confidence_sentence }` |
| `POST /api/edit` | follow-up text + the current path (events) + numbers the user set by hand (`fixed`) | `{ path (the complete updated path), changes[], unsupported[], note }` |

`/api/parse` also returns `profile_update` (income, rent, cash, investments, usual spending: only what the user said), for **facts about today** ("I now earn 1,500"). They update the twin's state instead of creating a path.

Both POST answers also return `prompt: { system, user, settings }` (exactly what was sent to the AI) and `ms` (time taken). The UI shows these in the **"see the prompt"** window.

The frontend calls `/api/...` on port 5173, and Vite forwards it to port 8000, so there are never CORS problems.

### Settings (`backend/.env`, copied from `.env.example`)

| variable | today | notes |
|---|---|---|
| `LLM_BASE_URL` | `https://api.together.ai/v1` | any OpenAI-compatible URL (OpenAI, Groq, Ollama `http://localhost:11434/v1`…) |
| `LLM_API_KEY` | your key | never commit `.env` (it's gitignored) |
| `LLM_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | |
| `LLM_REASONING` | `off` | sends `reasoning: {enabled: false}` (Together's switch for hybrid models). Use `default` for other providers. |
| `LLM_JSON_MODE` | `json_schema` | strict structured output. If a model rejects it, use `json_object` or `none` (the schema is always in the prompt too) |
| `LLM_TIMEOUT_MS` | 25000 | |

Restart the backend after editing `.env`.

### How a call is made safe
1. The system prompt contains the rules **and** the JSON Schema (Together recommends both).
2. `response_format: json_schema` (strict) forces the shape. `temperature: 0` keeps it stable.
3. The answer is validated with **zod** (`schema.ts`). If it's invalid, the error is sent back once ("fix your JSON"), then the backend gives up.
4. On any failure the backend returns `{ok: false}`, and the **frontend falls back** (keyword rules or template).
5. The browser **caches** every successful answer (localStorage). The same question replays even without internet. Rehearse demo questions once.

### The prompts (in `server.ts`)
- **Parse rules (short version):** use only the 11 event types; several things in one life = one scenario with several events; **any number the user didn't say → null**; "at 25" → months from now; "A or B" → two scenarios; anything we can't model → `unsupported`.
- **Explain rules:** plain English, use **only** numbers from the facts, say "in this simulation", never give advice, mention the cash risk and the break-even.

### Measured with the real API (`pnpm test:live`)
- 11/11 test questions parsed correctly, in **0.6–2.6 s** each. These include "A or B", ages → months, money amounts, "Berlin" → abroad, part-time 60% → −40%, a car + insurance, a lottery question with tax (taxes correctly listed as unsupported), and one sentence with three life events (master's + job loss + flat), which became one path with 3 events.
- In the app, a question takes ~2–6 s end to end (the parse prompt includes the 120-scenario catalog).
- Explanation in about **1.5 s**, with 13/13 numbers verified.

### How to change it
- **Other model:** change `LLM_MODEL` in `.env`, restart, run `pnpm test:live`.
- **Better answers:** edit the rules in `parseSystemPrompt` / `EXPLAIN_SYSTEM`. Add a line per mistake you see. Run `pnpm test:live`.
- **New field in the JSON:** `schema.ts` (backend) + `types.ts` (frontend) + use it in `resolve.ts`.

---

## 6b. The twin talks, remembers and updates itself

### Why context matters (a real failure, fixed)
The first chat version sent each message **alone**: no history, no list of paths, none of the person's numbers. So "have the kid at 35 *instead*" created a new path with only a kid; "where's the 1M income?" got "I can't invent a 1M income"; "what are my financials?" got "I can't read out your numbers"; "until I buy the house it should be 2K a month" (right after asking about rent) became a savings plan. **The model (DeepSeek) wasn't the problem; it was given no context.**

Now every message goes to **`/api/chat`** with:
- **HISTORY**: the last 12 messages (yours and the twin's), so "it", "that", "instead" can be resolved;
- **STATE**: the twin's current numbers (after your updates), the monthly balance, goals, and the "if nothing changes" results, so it can answer "what's my rent?" or "explain my situation";
- **PATHS**: every path on screen with its id, events and results, so it can **edit** or **remove** the right one;
- the paths being compared (**A** and **B**), the **target** path (✏️ Change) and the **branch parent** (⑂ Branch off).

One turn can do several things: `reply` (always: natural, short, answers questions with STATE/PATHS numbers, no canned slogans), `profile_update`, `new_paths`, `edit`, `remove_path_ids` (when you say it misunderstood), `horizon_years` (e.g. "until 40" at 20 → 25 years). **Truthful history:** the chat history sent to the AI records what was *actually applied* in each turn ("[actions applied: …]" or "[no path, fact or economy was changed in this turn]"), and the prompt says PATHS is the truth. This stops the twin from believing its own earlier claim ("I've added it to all three") when nothing was changed. Edits are matched by path id or by name, and an edit that can't be matched is reported in the chat instead of vanishing.

The reply's numbers are checked: numbers from the data or from your message (also ÷12 / ×12) pass; anything else is shown as "ℹ calculated by the twin". Distress messages get care and Swiss help lines (143, 147, 144) first.

**Big requests** ("add 10 random paths", "branch them all out", "add a flat to all 13 paths") used to fail: every edit re-sent the whole path, the answer hit the token limit and the app wrongly said "AI offline". Now: up to 10 new paths per turn; inventing example *decisions* on request is allowed (amounts still null); a branch names its `parent_id` and lists only its new events; an edit that only adds uses `add_events` (a change or move still sends the complete path); chat answers may use 12k tokens, and if one is still cut off the backend asks once for a shorter answer. If the AI's answer fails for another reason, the chat says so instead of "AI offline". Bulk adds get no "direct answer" (nobody asked a question), the horizon only changes when the user talks about time or an event would fall off the chart, and ages/years of the paths' events count as known numbers in the reply check.

**Tested** with the exact transcript (`pnpm test:live`, "chat:"): "just say hi and nothing else" → "Hi!"; "what are my financials?" → her income, rent, spending, cash and monthly gap; "kid at 35 instead" → edits that path, keeps the 1M and the mansion; "where's the 1M income" → adds it to that path; "rent should be 2K" → rent update, not saving; "I meant rent, not saving" → removes the wrong path and fixes the rent; explicit target edit → that path only.

- **Chat (`components/Chat.tsx`):** everything you type goes into one conversation. Your messages appear on the right; the twin's replies on the left say what it did:
  - "＋ Master's in Zurich: 🎓…" (click to select that path);
  - "🧠 Updated what I know: income 1,200 → 1,500";
  - "✏️ Changed Master's degree: ✓ flat price 600k → 500k".
  For questions, the direct answer and its confidence badge appear in the same bubble. "how did the twin get this?" opens the explanation window.
- **The twin updates itself (state updating):** facts about today ("I now earn 1,500", "my rent went up to 1,100", "I have 10k saved") become a `profile_update`. It is applied on top of the data in the order you said it (`applyUpdates` in `App.tsx`), and **every path recomputes from the new state**. A purple "The twin knows" strip shows what changed, with undo. Offline, simple keyword rules catch "I earn / I have / my rent is".
- **Follow-ups on a path:** click **✏️ Change** on its tile, then use the chat's change bar (one-click ideas, "✏️ write your own change…", undo). "Write your own" puts the chat in **reply mode** ("✏️ Changing Master's degree"). The AI returns the complete updated path, keeping everything you didn't mention and keeping values you set by hand (`fixed`). The old version is stored for **undo**. Your hand-set profile numbers (`g.*`) are kept; event numbers are passed to the AI as `fixed`.
- **"How did the twin get this?" window:** plain story first (your message, what the twin understood as a readable list of events, each follow-up and what changed). The exact instructions, the raw JSON and the settings sit in one folded "Technical details" section.

## 6c. Showing what nobody knows (`lib/unknowns.ts`)

When a path depends on an **unknown** number that actually changes it (e.g. a degree's salary premium, rent abroad, a moving cost):
- the path's line turns **dotted from the month that number starts to matter**, a "?" marks the month, and the card shows "? unknowns from 22";
- for the selected path, a **hatched band** shows how far the line could move if the unknown were different. The ranges are **illustrative**: ±20 points for %, ±25% for "kept as today" values, 0 to 20% of income for an unknown monthly cost, 0 to 3 months of income for an unknown one-off cost. A note under the chart says that and how to fix it (set the number, or say it in a follow-up).

## 7. The UI (`frontend/src/`)

PC first (no phone layout on purpose). One screen, three parts: **chat on the left**, a **drag divider** (drag to resize, double-click to reset, the width is remembered), and **the twin** on the right.

### The right side, top to bottom (`App.tsx`)
1. **Person line:** avatar, name, age, city, job, household, savings, income, rent, and the goals from the data. On the right, the hook: *"If nothing changes, cash runs out at 20."* The person dropdown and **▶ Demo** sit in the top bar. If you told the twin something ("I now earn 1,500"), a purple **"The twin knows"** strip shows it, with "reset to the data".
2. **Your paths: the scenario tree** (`components/Tree.tsx`, layout in `lib/tree.ts`). UBS's docs describe this exact picture: a *scenario tree* of branching decisions (`examples/example-outputs.md` §3, `ai-and-technology.md` §21/§36).
   - The root is **Today · no change** (the data, nothing changes). Every other path is a node; a **branch keeps every decision of its parent and adds its own** (today → *Start working* → *+ flat at 28* → *+ a child at 26*…). Each node shows its name, net worth at the end, the event icons, and a dot: green = cash stays positive, amber = some risk, red = cash runs out / down payment missing.
   - **Click a node to compare it.** 1st click = **A (green)**, 2nd = **B (blue)**, a 3rd replaces B (A stays as the reference). Click a selected node again to drop it. **⇄ Swap** swaps A and B. Edges into A/B are coloured.
   - **+ New path** (or the **+** on any node) opens a panel: *branch from* (any node), the instant ready-made paths (no AI), or **"✦ Describe it in the chat…"**. A new path from the chat is placed automatically under the path whose decisions it contains (`inferParent`).
   - The root is labelled **BASELINE**. **Left to right is NOT a timeline**: it shows what builds on what (a branch continues its parent); the ages are inside each path. The canvas says so.
   - **Time on the links:** click a pill (or the link itself) to type a new time ("+3 yrs", half years OK). The branch's own decisions move (`shiftBranch` in `lib/tree.ts`), and so do their copies in every sub-branch; undo-able. Each link carries a small pill with when the branch's first NEW decision happens, counted from its parent's last decision: "now", "+8 yrs", "+1.5 yrs" (half-year steps), or "at 21" if it comes earlier. Hover for the full sentence. Pills on the A/B links take the A/B colour; "now" pills are quieter so real gaps stand out (`linkGap` in `App.tsx`).
   - **Move nodes:** drag a node to move it; its whole branch comes along and the link to its parent stretches. A click without movement still selects it. **↺** (bottom-right, only after moving something) puts every path back.
   - **New path card:** "+ New path" or a node's **+** opens a card NEXT TO that node, joined by a dashed connector: "Describe it in the chat…" first, then the ready-made paths (instant, no AI) with their recipe. The view pans, or zooms out just enough (never below 45%), so the node and its card sit side by side without covering anything; drag the card by its header to move it; Esc / ✕ closes it.
   - **Pan & zoom canvas:** scroll wheel = zoom towards the pointer; drag with the **middle button** (or drag empty space) = move; − / % / + / ⤢ (fit) in the corner. It fits itself until you move it; after that, a newly selected node is brought into view. The canvas height can be resized from its corner.
   - It can grow without limit: layout is O(n) (500 nodes in a few ms, tested), and **▾/▸ n** folds a branch. Simulations are **cached per node**: only nodes whose inputs changed are re-simulated; the "unknowns" envelopes and the confidence checks run only for A and B. The AI gets A, B, the path being edited and the 20 most recent paths (prompt size stays bounded).
3. **The A and B tiles** (`components/Tiles.tsx`): event chips with ages, net worth and cash at the end, flags (cash runs out / down payment / goals likely / unknowns), then **two short paragraphs written for the person** ("you"): **So far** = the real bank history in UBS's data (observed, not simulated) + what this path changes; **Ahead** = what tends to happen in the simulation. Buttons: **✏️ Change** (the chat rewrites this path; undo keeps the old version), **⑂ Branch off**, **🔢 Numbers**, **↶ Undo**, 🗑.
4. **A vs B** (only when both are selected): a personal comparison written by the AI, labelled **Not financial advice**. Next to it, the four measures UBS lists for every catalog scenario (*liquidity, net worth, goal feasibility, constraint breaches*): lowest cash, cash trouble %, net worth, each goal's %, with a ✓ on the better side. Above it: **"Fits your goals better, in this simulation: X"**. That verdict is **computed by the app** (`goalFit` in `lib/compare.ts`), never by the AI, with the weighting stated openly as UBS asks (`scenario-modelling.md` §13: preference weights must not be hidden): *1) not running out of cash, 2) your goals (high priority counts double), 3) net worth*. So more money does not automatically "win" (FAQ: *"Is the scenario with the most money always best? No"*). "How *fits better* is judged" unfolds the reasons and the confidence (§5b) that A or B ends with more net worth. The **break-even** line ("catches up only if income from 22 is 23% higher") sits below.
5. **Sensitivity** (`components/Sensitivity.tsx`, UBS `example-outputs.md` §5): left, a tornado per path (each input ±10%, return ±1 pt: income, rent, other living costs, one-off costs & tuition, investment return); right, pick an input and see A's and B's end net worth from −30% to +30%, "as assumed" marked, and the point where their order flips. Deterministic runs (no luck), the same change for both paths.
6. **Year by year** (`components/CompareChart.tsx`): two charts side by side, **Net worth** and **Cash in the bank**, one point per year, A green and B blue with A/B labels at the line ends, shaded = where 8 in 10 futures land, dotted = from the age an unknown number starts to matter. Cash chart: **black dots** = the real bank balance in the data, **🎯** = goals. Under it, each goal with A % and B %. The horizon (3–30 years) is chosen here. Colours validated for colour-blind readers (`--a`/`--b` in `index.css`), and every series also carries its letter.
6. **Folded:** **The numbers behind** (tabs A / B: what it does, who made it, *see the prompt*, ⬇ scenario report (UBS template), every number with its source, click to change, *what matters most*), **The economy** (presets, shared by every path), **Can you trust this?**.

### Facts about today the twin can hold (beyond the data)
- **A home you already own** ("assume I had a house worth 200k at 20, gifted"): `profile_update.home_value_chf` → `Profile.home` → `Plan.startHome`, counted in net worth from day one (never cash; house-price drops apply). This is NOT a `buy_home` event: buying converts cash into a home and leaves net worth flat. "For the baseline / from the start" always means a fact about today, applied to every path.
- **A cash floor** ("I never want my savings below 20k"): `profile_update.min_cash_chf` → `Profile.minCash`, a user-defined constraint (C_t ≥ C_min, UBS interaction 4). Every path shows "stays above your floor" / "below your floor in X%"; the cash chart draws the floor; "cash trouble" and "fits your goals better" include it (`belowFloor`, `breach` in `lib/compare.ts`).

### Honesty: nothing is claimed that does not take effect
The AI writes its reply BEFORE anything is simulated, so honesty is enforced by code, not by trust:
- **Backend (`/api/chat`):** a reply that claims a change ("Done", "I've added…") without any action in its JSON, or says something is "already" there without checking, is sent back once: do it, or say plainly that nothing changed. In branch mode, an edit of the parent is turned into a new branch (the original stays as it was).
- **App, after every turn:** everything the turn touched (and every path, if a fact or the economy changed) is re-simulated in the NEW state and the chat gets formal notices from the engine (`lib/effects.ts`): "⛔ Not taking effect: …" (investing with no cash, a purchase with no price, a down payment that is not there, a job during a study, an event after the end of the chart, an edit that changed nothing) and "⚠ …" (cash runs out, below your floor), each with how to make it possible. A decision that cannot take effect gets no "direct answer". If the twin still says "done" with nothing applied, the chat says so.
- **Facts for questions, computed by the engine:** `income_needed` per path (goal-seeking: the smallest income for which cash never goes below zero; UBS ai-and-technology §30) and `all_paths_ranked_by_net_worth_at_end` (including the baseline), so "how much do I need to earn?" and "which is best?" are answered with real numbers.
- **Number check:** numbers inside a question ("want me to test 4,000?") are suggestions, not claims, and are not flagged.

### Assumptions panel
"Assumptions" (folded; "📋 Assumptions (N)" on each tile) lists every number of a path in two groups: **Filled in for you** (you did not say it: source chip + one grey line saying why, e.g. "median of 69 employed people aged 20–24 (synthetic-profiles.csv)") and **You said**. Click any value to change it.

### How decisions combine (several at the same moment)
Events are applied in time order; ties keep their order (a branch's own events come after its parent's). Decisions that SET something from that month take the latest one (job → salary, move → rent, household → rent, study → student income); decisions that ADD stack (costs, one-offs, investing, loans, purchases, market drops); income changes multiply (−10% twice = −19%). Nothing is silently dropped. The engine and the data are monthly (the ledger is 24 monthly rows per person); the charts show one point per year for readability.

### The chat (left, `components/Chat.tsx`)
Everything the twin could do before still works from here: what-ifs (new paths), facts about today, goals, the economy, editing / removing paths, questions with a **direct answer + computed confidence** (in the bubble; **why?** unfolds the reasoning, the reasons and *see the prompt*). New:
- **Branch mode** (⑂ from a tile, a node's **+**, or "Describe it in the chat"): the bar says *"New branch of Start working"* with one-click ideas ("then buy a flat for 500k at 28"); the backend gets `fork_from_path_id` and returns a NEW path that copies the parent's events (the app re-adds any the AI forgot, `withParentEvents`).
- **Change mode** (✏️ Change): as before ("Change this path"), with one-click ideas.
- The AI also knows which paths are **A and B** ("compare them", "the green one").
- *Ideas to ask* (made for the person, `lib/suggest.ts`) sit above the input, open until you start.
- **Undo by chat:** "I didn't want any changes to the others" → `undo_path_ids`; the app restores the previous version exactly. The AI sees each path's `last_change`, `can_undo` and `undo_would_restore`, and must never undo a change the user asked for.
- **No price, no effect:** a home or asset without a price changes nothing (prices are not in the data). The chat says so right away and asks for one; the AI may not claim the simulator "will show" its effect.
- **Robust edits:** an "added" event that is really a change of an existing one (same type, same start or label, e.g. giving the house its price) is merged, not duplicated (`addEvents` in `lib/tree.ts`).

### The A/B text pipeline (`lib/compare.ts` → `POST /api/compare`)
`compareFacts()` builds the only numbers the AI may use: the person today, the **observed** ledger history, goals with priority, per path the decisions, yearly snapshots, end values, cash risk, goals, purchases, unknowns, and the computed comparison (who ends higher, in what % of paired futures, confidence, *fits goals better* + its reasons, break-even). The AI returns `{ first, second, comparison, caveat }`; the app checks **every number** (✓ N numbers checked) and shows a template instantly while it writes (and if the AI is down). Facts are sent in a fixed order (by id), so **swapping A and B costs no new AI call**; answers are cached in the browser like every other call.

### Files
| file | what |
|---|---|
| `App.tsx` | layout, state (tree, A/B selection, chat modes), per-node simulation cache, chat flow, A/B pipeline |
| `components/Tree.tsx` + `lib/tree.ts` | the scenario tree (layout, parent inference, branches keep parent decisions) |
| `components/Tiles.tsx` | A/B tiles and the comparison card |
| `components/CompareChart.tsx` | year-by-year chart (net worth / cash) for A and B |
| `components/Chat.tsx` | the chat (modes, ideas, answers with "why?") |
| `lib/compare.ts` | facts for the A/B text, the "fits your goals better" rule, offline template |
| `components/Details.tsx` | assumption list (editable), source chips, driver bars |
| `components/Economy.tsx` | economy presets |
| `components/Trust.tsx` | trust summary and details |
| `components/HowMade.tsx` | the "see the prompt / see how" window (native `<dialog>`) |
| `lib/answer.ts` | verdict + confidence (§5b) and the facts the answer-AI may use |
| `lib/suggest.ts` | example questions, change ideas and branch ideas made for each person / path |
| `index.css` | all styles. Colours are CSS variables at the top (`--a` green, `--b` blue); dark mode is automatic |
| `lib/api.ts` | calls to the backend, with timeout and cache |
| `lib/fallback.ts` | offline keyword parser |
| `lib/fmt.ts` | CHF / % formatting |

### How to change it
- **Texts:** directly in `App.tsx` / components (all plain English strings). The A/B writing rules: `COMPARE_SYSTEM` in `backend/server.ts`.
- **What "fits better" means:** `goalFit` + `FIT_RULE` in `lib/compare.ts` (keep the rule text in sync; it is shown to the user and to the AI).
- **Quick buttons:** `presets()` in `resolve.ts`. **Example questions / change ideas / branch ideas:** `lib/suggest.ts`.
- **Colours:** `--a` / `--b` (and dark-mode values) at the top of `index.css`. Re-validate for colour blindness if you change them.
- **Default person:** `useState('P00001')` in `App.tsx`.

## 8. Tests

| command | what it checks | needs |
|---|---|---|
| `cd frontend && pnpm test` | **R models** (`model.test.ts`, 13): parity with R (the engine's regular-month cash flow = R's `regular_net_hat` for all 1,200 people, < 1 rappen), relocate = difference of city offsets, self-employed December bonus (expected value and frequency), study leaves out the students' Feb / Sep peaks, `invNorm`; economy forecast: VAR stationary, today's economy untouched by the forecast code, same job losses in two paths of the same future, students / retirees / self-employed never lose a job, benefit rules (70/80%, cap, 18 months, then the unemployed income), expected-value line = Monte Carlo average, accounting checks in the forecast economy, wider range. **Backtest** (`backtest.test.ts`): recomputes `backtest.json` and fails if it changed or coverage leaves 72–88%. **Render** (`render.test.tsx`): the whole app renders with the bundled model, no NaN. Plus 80 tests (`engine.test.ts`): UBS edge cases (zero interest rate, negative return), repeated income cuts, effect notices, income-needed goal-seek, investments vs UBS's formulas (12,167 exactly; annuity), selling, budget constraint, compounding raises, the R spending model matters (without seasons, bonus and surprises the results change and the band shrinks), owned home (+200k net worth from day one, checks pass), cash floor, merged edits, link-time editing, scenario tree (parent inference, branches keep decisions, layout incl. 500 nodes), A/B comparison (cash decides first, offline text only uses checked numbers), down-payment check (broke student can't pay, worker can; "can I afford" = no), answer confidence (clear case = high, unknown premium = not high, near-tie = low, goal 0% = high, 0%-return investing = tie, afford questions), suggestions fit every one of the 1,200 people, French/Swiss number formats, accounting identities for every preset on 3 different people, home purchase (net worth unchanged, cash drops), age-appropriate presets, offline parser, the edge cases from `pre_docs/evaluation/technical-validation.md` (zero income, higher tuition, loan payoff, transfers), real month-24 cash inside the 80% range for 70–90% of all 1,200 people, overrides, break-even, reproducibility, number checker | nothing |
| `cd frontend && pnpm test:live` | 67 tests with the **real LLM** (10 full runs: 9 × 67/67, 1 × 66/67): honesty (blocked investing answered "no", income needed quoted, best branch includes the baseline, a bare "3000" acts, a long five-part message), starting salary after the degree, −20% a year for 2 years; yearly raise compounds, a chain of new nodes, "invest at 7%" = economy return, selling; a real 7-turn conversation replayed with the app's rules and re-simulated (house without a price, priced, moved, "assume I had a house" as a fact, wrong edit undone, gifted, cash floor); bulk requests from a real transcript (10 random paths, 13 edits, branch out), A/B texts (every number traced, the computed leaning respected, no advice words), one-path story, branching (`fork_from_path_id`); 7 conversation-with-context cases from a real transcript; 23 earlier ones: 11 simple questions checked field by field; 10 very complex sentences, each parsed, simulated, **answered**, all numbers verified and the confidence copied exactly; a full explanation check. Passed 3 full runs in a row (66/66) after the last fixes | backend running with a key |
| `cd backend && pnpm typecheck` | backend types | nothing |
| `cd frontend && pnpm build` | frontend types and production build | nothing |
| `cd frontend && pnpm backtest` | re-runs the spending backtest and writes `backtest.json` (after changing the model) | nothing |
| `Rscript R/eda.R` / `Rscript R/macro.R` | re-estimate the spending / economy models (then `pnpm model:import`) | R (+ lme4, tidyverse; jsonlite only to re-download data) |
| `cd ml && uv run train.py` | re-builds data checks, defaults and people | uv |

---

## 9. Running and troubleshooting

- Everything at once: `node demo.mjs`, then open `http://localhost:5173/?demo`.
- **For the real demo: `node demo.mjs --prod`**, then open `http://localhost:4173/?demo`. It builds once and serves the static build: about 120 MB of memory instead of about 700 MB for the dev server (the dev server re-processes the 760 KB `profiles.json`). Use it on laptops with little RAM.
- Separately: `cd backend && pnpm dev` (auto-restarts on change) and `cd frontend && pnpm dev`.
- **"AI offline" badge:** is the backend running? Is `LLM_API_KEY` set in `backend/.env`? Check `curl localhost:8000/api/health`.
- **Port busy:** another dev server is running. Close it (or change `PORT` in `.env` and the proxy target in `frontend/vite.config.ts`).
- **The LLM gives bad JSON:** set `LLM_JSON_MODE=json_object` and restart.
- **You changed `train.py`:** rerun it; the frontend reloads by itself.
- **You changed an R script:** rerun it, then `cd frontend && pnpm model:import && pnpm backtest`. If `pnpm test` says "backtest.json changed", you forgot `pnpm backtest`.
- **The chart is blank:** never add `max-width` to `.recharts-surface` (Firefox renders the SVG empty). The chart sits in `.chart-box`, which already prevents overflow.
- **Screen:** PC first (no phone layout on purpose). Below ~1200 px the comparison and the two charts stack; the chat width is set with the divider.
- **Security:** deliberately ignored for the demo. CORS is open, the server listens on all network interfaces, and there's no auth. The key stays on the backend, never in the browser.

---

## 10. Known limits and next ideas

**Limits:** synthetic data (see section 1 quirks), 2025 francs, after-tax income only, investment return 4% a year (UBS's illustrative rate, editable), the band shows normal ups and downs, not doubt about the assumptions. Forecast economy: cash keeps its value in today's francs (no interest, no erosion, as in every economy); benefits are applied to net pay (the law uses gross pay); the job-finding chance does not fall when unemployment rises; the 7-month duration is a secondary source (the SECO table was not reachable).

**Next ideas, by owner:**
- **Models (R):** fit investment return and volatility from public index data (`pre_docs/resources_2/data/financial-markets-data.md`) next to `R/macro.R`; widen the inflation ranges (70% held vs 80% wanted); try a better spending model and keep it only if the backtest improves; show a small backtest chart.
- **Backend:** few-shot examples in the prompt; a "clarifying question" flow when `note` is set.
- **Frontend:** a "change one thing" slider on the break-even value; more presets from the 120-scenario catalog; mobile polish.

---

## "I want to…"

| I want to… | go to |
|---|---|
| change the AI model or provider | `backend/.env` (`LLM_MODEL`, `LLM_BASE_URL`), restart the backend |
| make the AI understand something better | rules in `parseSystemPrompt`, `backend/server.ts` |
| change how the paragraph is written | `EXPLAIN_SYSTEM`, `backend/server.ts` |
| add a new kind of life event | checklist in section 4 |
| change a default (salary, rent, tuition…) | `resolve.ts` (where it calls `A(...)`) or the medians in `train.py` |
| change the spending model | `R/eda.R`, then `Rscript R/eda.R && cd frontend && pnpm model:import && pnpm backtest` and compare the backtest |
| change the economy forecast or the unemployment assumptions | `R/macro.R` (`labour_assumption` block), then `Rscript R/macro.R && cd frontend && pnpm model:import` |
| add a quick button | `presets()` in `frontend/src/lib/resolve.ts` |
| change the example questions | `EXAMPLES` in `frontend/src/App.tsx` |
| change the look | `frontend/src/index.css` |
| change the number of simulated futures | `simulate(..., paths)` in `frontend/src/lib/sim.ts` |
| see the exact JSON the AI must return | `curl localhost:8000/api/schema` or `backend/schema.ts` |
| prove it works to a judge | open *Can you trust this?*, switch the chart to *Cash* (real data dots), run `pnpm test` |
