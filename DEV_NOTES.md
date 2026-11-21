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
| **ε<sub>t</sub>** personal luck (idiosyncratic) | surprise expenses, December bonus, uncertainty about your usual spending | **learned** from 28,800 months (each person's own 24) | **predicted & tested**: 80% range caught 78.5% of real 2026 results |
| **w<sub>t</sub>** the economy (macroeconomic) | inflation vs pay, interest rates, market returns, recessions, house prices | the economy you pick (presets = UBS scenarios S101–S110) or say in the chat | assumed, **shared by every path** |
| **θ** parameters | seasonality, bonus odds, peer ranges, regressions | `ml/train.py` | learned |

**Two kinds of variables (as the UBS presenter put it): idiosyncratic and macroeconomic.**
- **Idiosyncratic = this person.** Their income, rent, spending habit, decisions, and personal luck. These differ per path and per person. One message can contain them ("I do a master's").
- **Macroeconomic = the whole economy.** Inflation, rates, markets, recession, house prices. **One setting for every path** (the "🌍 The economy" bar), so decisions are always compared under the same conditions. The same message can contain them too ("…and there's a recession in 2 years"): the chat puts the decision in a path and the recession in the economy.
- **In the Monte Carlo** each future draws **personal luck** (learned) and, with "Uncertain economy", **economy luck** (random recessions, ~1 in 10 years, the same for every path in that future).

**Does anything actually *predict*?** Only the personal-luck part, and it predicts the *spread* of normal months, not life outcomes. It was tested properly: trained on 2025, predicted 2026, compared with reality for 1,200 people (calibration 10% → 9.3%, 50% → 49.9%, 90% → 87.9%; "A ends higher than B" statements on 19,980 pairs: said 99.8% → 99.9% true). Decision effects are **not** predicted, because the data contains no decisions. They are explicit, labelled assumptions, and unknowns are drawn dotted. Economy scenarios are stress tests, not forecasts. That matches UBS FAQ #18: *"Can we claim our model is accurate? Only to the extent supported by validation evidence."*

**Why it is a twin and not a calculator** (UBS capabilities C01–C20, `ai-and-technology.md` §2):
- **personalized:** it starts from *this* person's data and learns *their* spending habit (C01, C02);
- **updates itself:** "I now earn 1,500" changes its state (C03, C14);
- **reacts to decisions:** in plain words, including follow-ups and corrections (C04, C05, C07, C13);
- **distinguishes decisions from external conditions:** paths vs the economy (§2 of scenario-modelling);
- **constraints:** funding gaps, down payment from own cash, debt ≥ 0 (C08);
- **compares paths fairly:** same luck, same economy (C09);
- **uncertainty:** ranges, drivers, break-even, unknowns, economy (C10);
- **goal tracking** (C11);
- **explains itself:** answers, stories, "how did the twin get this?" (C12, C18);
- **validated:** live checks, backtest, 47 + 38 tests (C15, C19);
- **transparent:** every number tagged data / learned / you / assumption / unknown / economy (C16, C17);
- **responsible:** no advice, "in this simulation", fictional (C20).

### Checked against the UBS brief (the deck's "What success looks like after 24 hours")

| UBS asks | Status | Where |
|---|---|---|
| MUST · Fictional client profile | ✅ 1,200 fictional people from UBS's data; Alexia by default | person line, profile picker |
| MUST · One working scenario | ✅ 11 event types, any combination, in plain words; 7 ready-made paths | chat, `+` buttons |
| MUST · Before / after comparison | ✅ baseline vs every path: cards, chart, "vs baseline", answer card | outcome cards, chart |
| MUST · Transparent assumptions | ✅ every number has a source tag and a note, editable; unknowns marked and dotted; prompt visible | "The numbers behind", "how did the twin get this?" |
| BONUS · Conversational AI | ✅ a chat that answers, acts, remembers context, updates itself, edits paths, checks its own numbers | chat |
| BONUS · Sensitivity & uncertainty | ✅ Monte Carlo (personal + economy luck, calibrated on real data), drivers, break-even, peer-range robustness, unknown ranges, economy stress tests | chart bands, "what matters most", answer confidence, economy bar |
| "Success is helping someone understand a decision" | ✅ direct answers with computed confidence, plain-English story, break-even ("pays off only if salary +24%") | answer card, story card |

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
                                                 chart, outcome cards, break-even, checks
```

- The **LLM never does maths**. It only (1) turns words into a fixed JSON format and (2) turns computed numbers into words.
- The **engine** is normal code: exact accounting formulas plus randomness that our **model learned from the data**.
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

## 2. The model (`ml/train.py`)

### What "model" means here
We do **not** train a model to predict "what if I do a master's?". The data has nobody doing a master's, so that's impossible to learn honestly. We train on **how months behave**: how much spending jumps around, when bonuses come, which months are expensive. The engine then uses that to make realistic futures.

### What it learns (all from the 28,800 months)

| # | What | How | Result today |
|---|---|---|---|
| 1 | **Seasonality** (expensive months) | for each job status and calendar month: average % above or below the person's normal spending. Kept only if statistically clear (\|t\| > 3), otherwise 0 | Feb and Aug higher for everyone; students +34% in Feb |
| 2 | **December bonus** | a December counts as a bonus if it is > 3 standard deviations above the person's other months. Probability = how often, minus the false-alarm rate in other months | employed: 54% of years, median 61% of a month's pay |
| 3 | **Personal level** | each person's average non-rent spending over 24 months, plus its uncertainty (standard error) | Alexia: CHF 1,336/mo ± 426 |
| 4 | **Spending response** | linear regression: non-rent spending ~ income + rent + age + household + status. Picked by 5-fold cross-validation | R² ≈ 0.05: spending barely depends on these, so we start from the person's own level and add only the **change** the regression predicts |
| 5 | **Volatility** | regression: monthly spending std-dev ~ income, √income, rent, age, household, status | R² ≈ 0.80: works well; used when someone's situation changes |
| 6 | **Shock shape** | the real distribution of "surprise" months (201 quantiles), not a bell curve | skewed toward big expenses; no month-to-month memory (autocorrelation −0.05) |
| 7 | **Defaults** | medians: income by status × age band, rent by city × household | e.g. employed 20–24: CHF 8,070 (69 people) |

### How we know it's right: the backtest
`train.py` re-learns everything using **2025 only**, simulates 2026 for all 1,200 people (1,000 futures each), and compares with the real 2026 ledger:
- the "8 in 10" range caught **78.5%** of real results (perfect = 80%)
- the middle-half range caught **49.8%** (perfect = 50%)
- typical error CHF 2,281, vs CHF 2,445 for a simple average
- better at predicting cash crunches (Brier 0.0012 vs 0.0025)

**Calibration curve:** does "we said X%" match reality at every level, not just at 80%?

| we said | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% |
|---|---|---|---|---|---|---|---|---|---|
| really happened | 9.3% | 18.7% | 28.3% | 37.6% | 49.9% | 59.0% | 68.8% | 78.5% | 87.9% |

**"A ends higher than B" statements:** the answers say things like "in X% of futures, A ends higher". We tested exactly that kind of sentence on **19,980 random pairs of real people** (2026):

| we said | 0.2% | 11% | 35% | 66% | 88% | 99.8% |
|---|---|---|---|---|---|---|
| really happened | 0.1% | 11% | 34% | 67% | 92% | 99.9% |

So when we say "≥ 95%", the data says it was true 99.9% of the time. That is why a **high-confidence** answer needs at least 95%.
The "cash goes below zero" probabilities are calibrated too (said <5% → 0% happened, said >95% → 100% happened).

Training also saves the **peer range** for every default: e.g. employed people aged 20–24 earn CHF 4,963 (10th percentile) to CHF 10,519 (90th). The answer's confidence uses these ranges (see §5b).

These numbers are saved in `params.json` and shown in the app under *Can you trust this?*.

### Outputs
- `frontend/src/model/params.json` (35 KB): everything learned, plus the backtest and data checks.
- `frontend/src/model/profiles.json` (830 KB): every person's starting state, goals, personal calibration and real ledger.

Both are **bundled into the frontend**, so there's no loading step that could fail during a demo. Training is deterministic (fixed seed): same data, same files, byte for byte.

### How to change it
- Run: `cd ml && uv run train.py`, then reload the browser. Run `cd frontend && pnpm test` afterwards.
- Thresholds are at the top of `train.py`: `BONUS_Z`, `SEASON_T`, `MIN_GROUP`, `SEED`.
- **Try a better model:** change `FEATURE_SETS` / `fit_regressions` (e.g. gradient boosting). Keep it **only if the backtest numbers get better**. If you add a new kind of feature, also teach `regPredict` in `frontend/src/lib/resolve.ts` how to compute it.
- Add a dependency: `uv add <pkg>==<version>`. The `uv.lock` keeps it reproducible.

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
income    = planned income (+ maybe a December bonus, drawn from what we learned)
spending  = (rent + usual spending + uncertainty about "usual") × (1 + seasonal %) + surprise
cash      = cash + income + new loans − spending − extra costs − one-off costs − money moved to investments − loan payments
invest    = (invest + money moved in) × (1 + return) × (1 − market shock)
debt      = debt + interest − loan payment          (never below 0)
net worth = cash + invest − debt
```
All amounts are CHF per month, in 2025 francs (no inflation). Income is after tax.

### Many futures (Monte Carlo)
- We run **500 futures** per path. Each draws different surprise months, bonuses and (if set) market returns from the learned patterns.
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

### The 11 event types

| type | what it does | default when a number is missing |
|---|---|---|
| `start_job` | status → employed, income → salary | median salary for employed people of that age band (**data**) |
| `study` | status → student for N months, tuition every 6 months, then a job | length and tuition from `scenario-assumptions.csv` (**data**); salary premium = 0% (**unknown**) |
| `relocate` | new rent (and income if given) from that month | known Swiss city: median rent there (**data**); abroad: keeps current values (**unknown**); moving cost 0 (**unknown**) |
| `income_change` | income × (1 + %) for a while or forever | % not given → 0 (**unknown**) |
| `household_change` | single / couple / family / shared housing | median rent for that household in that city (**data**) |
| `recurring_expense` | extra monthly cost | amount not given → 0 (**unknown**) |
| `one_off` | single cost (>0) or money in (<0) | 0 (**unknown**) |
| `invest` | monthly amount and/or lump sum moved into investments | 0 (**unknown**) |
| `market_shock` | investments fall by X% | 30% (**assumption**) |
| `take_loan` | cash now, monthly repayments | median rate of the 283 loans (**data**); 5-year term (**assumption**) |
| `buy_home` | own money (down payment) leaves cash, a mortgage is paid to the seller, the home is added to net worth, rent stops, upkeep starts. Interest-only mortgage | price: **unknown** (must be set; without a price nothing happens and the card warns "needs a price"); down payment 20%, mortgage 2%, upkeep 1%/yr (**assumption**) |

**Buying a home: why cash drops but net worth doesn't.** On the purchase month, cash falls by the down payment (e.g. 120k for a 600k flat). Net worth stays flat, because that money became part of a home worth 600k and the mortgage covers the other 480k. In the net worth view the selected path's **cash is drawn as a dotted line**, a 🏠 marker shows the month, and a note under the chart says it in words.
**Down-payment check:** a down payment must come from money you *have* (banks require own funds). In every one of the 500 futures the engine checks cash just before the purchase (`SimResult.homeBuys`). The card shows "🏠 down payment OK", "⚠ down payment short in X%" or "⚠ can't pay the 60k down payment at 25". "Can I afford a flat…?" questions answer **no** if the own money is missing (tested: a student with no job, flat 300k at 25 → 0%, "No").

**One path can hold many events.** "Do a master's now, lose my job at 25 and buy a flat at 28" becomes **one path with 3 events** (one line on the chart). "Master's **or** work?" becomes **two paths** (two lines). One question can create 1–3 paths.

Events are applied **in time order**, so "study, then move" works.

After the events, the resolver applies the **learned spending response**. When income, status, household, rent or age changes, spending changes by what the regression predicts (shown as a `learned` line).

### The five source labels

| label | meaning |
|---|---|
| `from data` | read from the CSVs, or a median of them |
| `learned` | fitted by `train.py` |
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
- **Break-even** (`breakEven`): "how much would income have to change, from the moment of the decision, for this path to end level with the baseline?" Solved by bisection. This is how we handle **unknowns honestly**: instead of guessing the master's salary premium, we say "it pays off only if salary is +24%".
- **Facts** (`buildFacts`): a small JSON with rounded results (medians, ranges, risk %, goals, drivers, break-even, unknown inputs). **This is the only thing LLM #2 sees.**
- **Number check** (`verifyNumbers`): takes every number in the AI paragraph (understands "254k", "12,000", "35%") and looks for it in the facts. The UI shows "✓ all 13 numbers checked against the model", or lists the ones it couldn't find.
- **Template** (`templateExplanation`): the paragraph used when the AI is offline. It also appears instantly while the AI is writing.

- **Same random months, compared one by one:** every path uses the same 500 random futures, so "in 98% of futures A ends higher" compares future #1 of A with future #1 of B, and so on.

---

## 5b. Answering the question, and how confident to be (`frontend/src/lib/answer.ts`)

The explanation card describes the chart in general. When someone **asks a question**, they also get a separate **answer card** above the outcome cards. It holds a direct answer (*"No. … the chance is 0%"*, *"Starting work ends higher…"*) plus a **confidence level computed by the app, never by the AI**.

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
  - **break-even / goal-seeking**: a 1-D optimization (docs §10, §30) that turns an unknown into a question you can answer ("does a master's raise pay 24%?");
  - **robustness against real peer ranges** (answer confidence, §5b);
  - **parameter uncertainty**: the personal spending level is sampled with its standard error, a simple Bayesian-style step (docs §20);
  - **explicit unknowns** (red "unknown" tags) instead of silent guesses.
- **Causal (docs §19, P(Y|X) ≠ P(Y|do(X))):** our decisions act on an explicit **structural model** (income, rent, costs, debt). "Do a master's" is a *do()*-operation on the plan, not a correlation from the data. The one correlational piece is the learned *spending response* regression; it is labelled `learned`, has CV R² 0.05, and is small.
- **Not built yet (honest next steps):** **state updating** (C03/C14: add a new month of real data → re-calibrate the person), and **multi-stage planning / optimization** ("what's the latest age I can buy a flat and keep cash > 0?"). Both fit the current engine.

---

## 6. The LLM and the backend (`backend/`)

### What the backend is
A ~170-line Node server (`server.ts`) with no framework. It holds the API key and talks to **any OpenAI-compatible API**. Today that's **Together AI** with `deepseek-ai/DeepSeek-V4.1-Flash-1017`, reasoning **off**.

| endpoint | in | out |
|---|---|---|
| `GET /api/health` | – | which model, JSON mode, reasoning |
| `GET /api/schema` | – | the exact JSON Schemas we demand |
| **`POST /api/chat`** (used by the app) | the new message + **the last 12 chat messages + the twin's current STATE (income, rent, cash, spending, goals, "if nothing changes" results) + every PATH on screen (id, events, results) + selected/target path** | `{ reply, profile_update, new_paths[], edit {path_id, path, changes}, remove_path_ids[], horizon_years, unsupported[] }`: the twin talks **and** acts in one turn |
| `POST /api/parse` | question + person summary + city list + scenario catalog | `{ scenarios[], horizon_years, unsupported[], note }` (older single-purpose endpoint, kept for tests and tools) |
| `POST /api/explain` | `{ facts }` | `{ headline, explanation, caveat }` |
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
- the **selected** path and the **target** path (when you click "Change this path").

One turn can do several things: `reply` (always: natural, short, answers questions with STATE/PATHS numbers, no canned slogans), `profile_update`, `new_paths`, `edit`, `remove_path_ids` (when you say it misunderstood), `horizon_years` (e.g. "until 40" at 20 → 25 years). The reply's numbers are checked: numbers from the data or from your message (also ÷12 / ×12) pass; anything else is shown as "ℹ calculated by the twin". Distress messages get care and Swiss help lines (143, 147, 144) first.

**Tested** with the exact transcript (`pnpm test:live`, "chat:"): "just say hi and nothing else" → "Hi!"; "what are my financials?" → her income, rent, spending, cash and monthly gap; "kid at 35 instead" → edits that path, keeps the 1M and the mansion; "where's the 1M income" → adds it to that path; "rent should be 2K" → rent update, not saving; "I meant rent, not saving" → removes the wrong path and fixes the rent; explicit target edit → that path only.

- **Chat (`components/Chat.tsx`):** everything you type goes into one conversation. Your messages appear on the right; the twin's replies on the left say what it did:
  - "＋ Master's in Zurich: 🎓…" (click to select that path);
  - "🧠 Updated what I know: income 1,200 → 1,500";
  - "✏️ Changed Master's degree: ✓ flat price 600k → 500k".
  For questions, the direct answer and its confidence badge appear in the same bubble. "how did the twin get this?" opens the explanation window.
- **The twin updates itself (state updating):** facts about today ("I now earn 1,500", "my rent went up to 1,100", "I have 10k saved") become a `profile_update`. It is applied on top of the data in the order you said it (`applyUpdates` in `App.tsx`), and **every path recomputes from the new state**. A purple "The twin knows" strip shows what changed, with undo. Offline, simple keyword rules catch "I earn / I have / my rent is".
- **Follow-ups on a path:** select a card, then use the "Change this path" bar (one-click ideas, "✏️ write your own change…", undo). "Write your own" puts the chat in **reply mode** ("✏️ Changing Master's degree"). The AI returns the complete updated path, keeping everything you didn't mention and keeping values you set by hand (`fixed`). The old version is stored for **undo**. Your hand-set profile numbers (`g.*`) are kept; event numbers are passed to the AI as `fixed`.
- **"How did the twin get this?" window:** plain story first (your message, what the twin understood as a readable list of events, each follow-up and what changed). The exact instructions, the raw JSON and the settings sit in one folded "Technical details" section.

## 6c. Showing what nobody knows (`lib/unknowns.ts`)

When a path depends on an **unknown** number that actually changes it (e.g. a degree's salary premium, rent abroad, a moving cost):
- the path's line turns **dotted from the month that number starts to matter**, a "?" marks the month, and the card shows "? unknowns from 22";
- for the selected path, a **hatched band** shows how far the line could move if the unknown were different. The ranges are **illustrative**: ±20 points for %, ±25% for "kept as today" values, 0 to 20% of income for an unknown monthly cost, 0 to 3 months of income for an unknown one-off cost. A note under the chart says that and how to fix it (set the number, or say it in a follow-up).

## 7. The UI (`frontend/src/`)

### What the user sees, top to bottom (`App.tsx`)
1. **Person line:** avatar, name, age, city, savings, income, rent, goals. A dropdown on the right picks any of the 1,200 fictional people.
2. **The hook:** one big sentence about the person's situation today, e.g. *"If nothing changes, Alexia's cash runs out at age 20."*
3. **The question box:** type anything and press *Explore*. A question creates paths **and** an **answer card** (§5b) above the outcome cards, which you can close with ✕. Below the box are two labelled rows:
   - **"Add a ready-made path · instant, no AI"**: the `+` buttons. Each one adds **one new path** with a fixed recipe (e.g. *+ Master's degree* = study for 2 years, then a job). Every missing number is filled from the data. Hover a button to read its recipe. They never call the AI, so they always work.
   - **"Or try a question · the AI turns it into a path"**: example questions (in quotes). Clicking one is the same as typing it. They are **made for the person** (`lib/suggest.ts`, rules, no AI): a student gets "master's or work?", a retiree gets "markets fall 30%?" or "a medical bill at 72?". The goal question uses what is still **missing** to reach the goal (target − savings). The `+` buttons also adapt: no "master's" from age 40, no "start working" for retirees or people 60+, no "lose income" for retirees.
4. **Outcome cards:** one per path. Under the name is one line saying what the path does (e.g. "job now · no income for 6 months at 25 · buy a home for 600k at 28"). Then a big number (net worth at the end), the difference vs the baseline, "cash runs out at…" or "cash stays positive", and goals reached. Clicking a card selects it; the card colour is its chart line. "compare others to this" makes it the baseline. × removes it.
5. **Chart:** median line per path; shaded range only for the selected path (keeps it calm). Years: 3–30.
   - **Net worth vs cash:** *cash* = money in the bank. *Net worth* = cash + investments + home − debts. For someone with only a bank account (like Alexia) they are the **same**, so the app shows one chart called "Money" and no toggle. The toggle appears as soon as any path has investments, a home or a loan. Example: buying a flat makes cash drop by the down payment while net worth stays flat.
   - The **black dots** are the real bank balance from the data (first 24 months). They appear in the cash view, or in the single "Money" view.
   - **🎯 markers = the person's goals** from `synthetic-goals.csv` (each has an amount and a date, e.g. emergency savings CHF 12,800 by Dec 2029). The marker sits at that amount and date, so it looks "low" on a chart that goes to 750k. Under the chart, a **goals strip** lists each goal with the % of futures that reach it, per path (path colours). A goal counts as reached if **cash + investments** are above the target at its date. A home doesn't count, because you can't spend it.
6. **The story:** the AI paragraph, a highlighted **break-even** line, the main caveat, and "✓ all N numbers checked". The break-even reads "catches up only if income is X% higher" when a path is behind the baseline, or "stays ahead even if income were X% lower" when it is ahead. If you change things quickly, only the newest explanation is shown (older answers are dropped).
7. **The numbers behind [path]** (folded). The first line says what the path does and **who made it**: the data, a `+` button, the AI from your question, or the offline rules. **"see the prompt" / "see how"** opens a window with the steps: your question → the exact instructions sent to the AI (folded, with a copy button) → the AI's raw JSON → the recipe → "the app filled the gaps". The explanation card has the same link for the paragraph. Below that line: every number with its source label. Click a value to change it (instant recompute); ↺ resets it. Below that, the *what matters most* bars.
8. **Can you trust this?** (folded): the summary shows ✓ accounting, ✓ backtest, ✓ AI numbers. Opening it shows details in 4 plain blocks.

**Demo button** (top right, or open `/?demo`): loads Alexia with *Start working* (baseline), *Master's degree* and *Move abroad*. This is the challenge's own example.

### Files
| file | what |
|---|---|
| `App.tsx` | page layout, state (paths, baseline, selection), ask flow, explanation flow |
| `components/Outcome.tsx` | outcome card |
| `components/Chart.tsx` | chart (Recharts) |
| `components/Details.tsx` | assumption list (editable), source chips, driver bars |
| `components/Trust.tsx` | trust summary and details |
| `components/HowMade.tsx` | the "see the prompt / see how" window (native `<dialog>`) |
| `components/Answer.tsx` | the answer card (answer + computed confidence + reasons) |
| `lib/answer.ts` | verdict + confidence (§5b) and the facts the answer-AI may use |
| `lib/suggest.ts` | example questions made for each person |
| `index.css` | all styles. Colours are CSS variables at the top; dark mode is automatic |
| `lib/api.ts` | calls to the backend, with timeout and cache |
| `lib/fallback.ts` | offline keyword parser |
| `lib/fmt.ts` | CHF / % formatting |

### How to change it
- **Texts:** directly in `App.tsx` / components (all plain English strings).
- **Quick buttons:** `presets()` in `resolve.ts`. They adapt to the person: no "start working" or "master's" for retirees or people 60+. **Example questions:** `EXAMPLES` in `App.tsx`.
- **Colours:** `COLORS` in `App.tsx` (path colours) and the CSS variables in `index.css`.
- **The opening sentence:** the `hook` in `App.tsx`.
- **Default person:** `useState('P00001')` in `App.tsx`.

---

## 8. Tests

| command | what it checks | needs |
|---|---|---|
| `cd frontend && pnpm test` | 41 tests: down-payment check (broke student can't pay, worker can; "can I afford" = no), answer confidence (clear case = high, unknown premium = not high, near-tie = low, goal 0% = high, 0%-return investing = tie, afford questions), suggestions fit every one of the 1,200 people, French/Swiss number formats, accounting identities for every preset on 3 different people, home purchase (net worth unchanged, cash drops), age-appropriate presets, offline parser, the edge cases from `pre_docs/evaluation/technical-validation.md` (zero income, higher tuition, loan payoff, transfers), real ledger inside the range, overrides, break-even, reproducibility, number checker | nothing |
| `cd frontend && pnpm test:live` | 36 tests with the **real LLM** (all pass): 7 conversation-with-context cases from a real transcript; 23 earlier ones: 11 simple questions checked field by field; 10 very complex sentences, each parsed, simulated, **answered**, all numbers verified and the confidence copied exactly; a full explanation check. Passed 3 full runs in a row (66/66) after the last fixes | backend running with a key |
| `cd backend && pnpm typecheck` | backend types | nothing |
| `cd frontend && pnpm build` | frontend types and production build | nothing |
| `cd ml && uv run train.py` | re-trains and prints the data checks and backtest | uv |

---

## 9. Running and troubleshooting

- Everything at once: `node demo.mjs`, then open `http://localhost:5173/?demo`.
- **For the real demo: `node demo.mjs --prod`**, then open `http://localhost:4173/?demo`. It builds once and serves the static build: about 120 MB of memory instead of about 700 MB for the dev server (the dev server re-processes the 830 KB `profiles.json`). Use it on laptops with little RAM.
- Separately: `cd backend && pnpm dev` (auto-restarts on change) and `cd frontend && pnpm dev`.
- **"AI offline" badge:** is the backend running? Is `LLM_API_KEY` set in `backend/.env`? Check `curl localhost:8000/api/health`.
- **Port busy:** another dev server is running. Close it (or change `PORT` in `.env` and the proxy target in `frontend/vite.config.ts`).
- **The LLM gives bad JSON:** set `LLM_JSON_MODE=json_object` and restart.
- **You changed `train.py`:** rerun it; the frontend reloads by itself.
- **The chart is blank:** never add `max-width` to `.recharts-surface` (Firefox renders the SVG empty). The chart sits in `.chart-box`, which already prevents overflow.
- **Phone layout:** checked at 390 and 360 px in every state (demo, answer, all sections open, prompt window): no sideways scroll, nothing clipped.
- **Security:** deliberately ignored for the demo. CORS is open, the server listens on all network interfaces, and there's no auth. The key stays on the backend, never in the browser.

---

## 10. Known limits and next ideas

**Limits:** synthetic data (see section 1 quirks), 2025 francs, after-tax income only, investment return 0% unless set, the band shows normal ups and downs, not doubt about the assumptions.

**Next ideas, by owner:**
- **ML:** fit investment return and volatility from public index data (`pre_docs/resources_2/data/financial-markets-data.md`); try a better spending model and keep it only if the backtest improves; show a small backtest chart.
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
| change what the model learns | `ml/train.py`, then rerun it and check the backtest |
| add a quick button | `presets()` in `frontend/src/lib/resolve.ts` |
| change the example questions | `EXAMPLES` in `frontend/src/App.tsx` |
| change the look | `frontend/src/index.css` |
| change the number of simulated futures | `simulate(..., paths)` in `frontend/src/lib/sim.ts` |
| see the exact JSON the AI must return | `curl localhost:8000/api/schema` or `backend/schema.ts` |
| prove it works to a judge | open *Can you trust this?*, switch the chart to *Cash* (real data dots), run `pnpm test` |
