# Dev notes: how everything works, and how to change it

Simple English, one topic per section. If you only read one thing, read **0** and the **"I want to…"** table at the end.
Setup and run commands are in the [README](README.md#1-run-the-demo).

---

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
- **Managed fine-tuning** (no cluster needed): `tg files upload train.jsonl`, then `tg fine-tuning create --training-file <id> --model <base> --lora`. This would teach a small LLM our JSON format. Today DeepSeek already gets 10/10 of our live test questions right, so this isn't needed.
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

### The 10 event types

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

---

## 6. The LLM and the backend (`backend/`)

### What the backend is
A ~170-line Node server (`server.ts`) with no framework. It holds the API key and talks to **any OpenAI-compatible API**. Today that's **Together AI** with `deepseek-ai/DeepSeek-V4.1-Flash-1017`, reasoning **off**.

| endpoint | in | out |
|---|---|---|
| `GET /api/health` | – | which model, JSON mode, reasoning |
| `GET /api/schema` | – | the exact JSON Schemas we demand |
| `POST /api/parse` | question + person summary + city list + scenario catalog | `{ scenarios[], horizon_years, unsupported[], note }` |
| `POST /api/explain` | `{ facts }` | `{ headline, explanation, caveat }` |

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
- **Parse rules (short version):** use only the 10 event types; **any number the user didn't say → null**; "at 25" → months from now; "A or B" → two scenarios; anything we can't model → `unsupported`.
- **Explain rules:** plain English, use **only** numbers from the facts, say "in this simulation", never give advice, mention the cash risk and the break-even.

### Measured with the real API (`pnpm test:live`)
- 10/10 test questions parsed correctly, in **0.6–2.6 s** each. These include "A or B", ages → months, money amounts, "Berlin" → abroad, part-time 60% → −40%, a car + insurance, and a lottery question with tax (taxes correctly listed as unsupported).
- Explanation in about **1.5 s**, with 13/13 numbers verified.

### How to change it
- **Other model:** change `LLM_MODEL` in `.env`, restart, run `pnpm test:live`.
- **Better answers:** edit the rules in `parseSystemPrompt` / `EXPLAIN_SYSTEM`. Add a line per mistake you see. Run `pnpm test:live`.
- **New field in the JSON:** `schema.ts` (backend) + `types.ts` (frontend) + use it in `resolve.ts`.

---

## 7. The UI (`frontend/src/`)

### What the user sees, top to bottom (`App.tsx`)
1. **Person line:** avatar, name, age, city, savings, income, rent, goals. A dropdown on the right picks any of the 1,200 fictional people.
2. **The hook:** one big sentence about the person's situation today, e.g. *"If nothing changes, Alexia's cash runs out at age 20."*
3. **The question box:** type anything and press *Explore*. Below it:
   - **quick buttons** (`+ Master's degree`…) add a path instantly, without AI
   - **example questions** (in quotes) go through the AI
4. **Outcome cards:** one per path. A big number (net worth at the end), the difference vs the baseline, "cash runs out at…" or "cash stays positive", and goals reached. Clicking a card selects it; the card colour is its chart line. "compare others to this" makes it the baseline. × removes it.
5. **Chart:** median line per path; shaded range only for the selected path (keeps it calm). Toggles: Net worth / Cash (Cash shows the **real ledger dots** from the data) and 3–30 years.
6. **The story:** the AI paragraph, a highlighted **break-even** line, the main caveat, and "✓ all N numbers checked".
7. **The numbers behind [path]** (folded): every number with its source label. Click a value to change it (instant recompute); ↺ resets it. Below that, the *what matters most* bars.
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
| `index.css` | all styles. Colours are CSS variables at the top; dark mode is automatic |
| `lib/api.ts` | calls to the backend, with timeout and cache |
| `lib/fallback.ts` | offline keyword parser |
| `lib/fmt.ts` | CHF / % formatting |

### How to change it
- **Texts:** directly in `App.tsx` / components (all plain English strings).
- **Quick buttons:** `presets()` in `resolve.ts`. **Example questions:** `EXAMPLES` in `App.tsx`.
- **Colours:** `COLORS` in `App.tsx` (path colours) and the CSS variables in `index.css`.
- **The opening sentence:** the `hook` in `App.tsx`.
- **Default person:** `useState('P00001')` in `App.tsx`.

---

## 8. Tests

| command | what it checks | needs |
|---|---|---|
| `cd frontend && pnpm test` | 31 tests: accounting identities for every preset on 3 different people, the edge cases from `pre_docs/evaluation/technical-validation.md` (zero income, higher tuition, loan payoff, transfers), real ledger inside the range, overrides, break-even, reproducibility, number checker | nothing |
| `cd frontend && pnpm test:live` | 12 tests with the **real LLM**: 10 questions parsed and checked field by field, then a full explanation with every number verified | backend running with a key |
| `cd backend && pnpm typecheck` | backend types | nothing |
| `cd frontend && pnpm build` | frontend types and production build | nothing |
| `cd ml && uv run train.py` | re-trains and prints the data checks and backtest | uv |

---

## 9. Running and troubleshooting

- Everything at once: `node demo.mjs`, then open `http://localhost:5173/?demo`.
- Separately: `cd backend && pnpm dev` (auto-restarts on change) and `cd frontend && pnpm dev`.
- **"AI offline" badge:** is the backend running? Is `LLM_API_KEY` set in `backend/.env`? Check `curl localhost:8000/api/health`.
- **Port busy:** another dev server is running. Close it (or change `PORT` in `.env` and the proxy target in `frontend/vite.config.ts`).
- **The LLM gives bad JSON:** set `LLM_JSON_MODE=json_object` and restart.
- **You changed `train.py`:** rerun it; the frontend reloads by itself.
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
