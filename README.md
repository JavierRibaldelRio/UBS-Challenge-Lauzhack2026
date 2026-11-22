# [Lauzhack 2026](https://lauzhack.com)

## USEFUL LINKS

[Google Docs Plan & Understanding](https://docs.google.com/document/d/1Nwf3SoaL9csPrZBiiXJPQGaQfBoytl8wBbCtf3ApGYI/edit?usp=sharing)


LauzHack is a student-run hackathon at EPFL in Lausanne, Switzerland.

q: Is there a specific topic?
a: No, all ideas are welcome, and you can choose to work on one or more of the challenges our sponsors will propose. There are prizes for the best hacks overall and the best challenge entries.

## 2026 Schedule

| Day | Time | Activity |
| --- | --- | --- |
| Saturday | 8:00–9:30 | Check-in and breakfast |
| Saturday | 10:00–10:15 | Opening ceremony |
| Saturday | 10:20–11:40 | Tech talks |
| Saturday | 11:40–12:00 | Team building |
| Saturday | 12:00 | Hacking starts |
| Saturday | 12:00–13:00 | Lunch |
| Saturday | 18:30–19:30 | Dinner |
| ... | ... | GRIND |
| Sunday | 0:00–1:00 | Midnight snack |
| Sunday | 7:00–9:00 | Breakfast |
| Sunday | 11:30–12:30 | Lunch |
| Sunday | 12:00 | Hacking ends |
| Sunday | 12:30–15:00 | Judging |
| Sunday | 15:00–17:00 | Closing ceremony |

## The event
You will get 24 hours to build your hack, optionally inspired by our sponsors’ challenges.
You can be in a team of up to 4, there will be a team-building opportunity before hacking.
After hacking is over, there will be one global ranking from our jury, and one per sponsor challenge.
We also have some fun workshops and games, with small prizes!

## Project evaluation
You will demo in 3 minutes to our jury for the global ranking, with 1 minute of Q&A.
You will also demo to sponsors whose challenge you are working on, if any.

Prizes for the global ranking are awarded based on
(1) how innovative, original and unexpected your project is;
(2) how convincing, smooth, and easy to follow your demo is; and
(3) how much of a difference your project can make in the world.
Prizes for sponsor challenges are awarded according to each sponsor’s criteria.

Slides are not allowed, though you can prepare images and videos as backup if your demo doesn’t work as expected.

You are encouraged to use existing libraries and APIs, you may use existing code you wrote, but you must clearly state what you created during the event and what you reused.

> Criteria, in a nutshell: IMPACT, NOVELTY, DEMO.


## Sponsors and Partners

### Gold Sponsors

- Logitech
- Loterie Romande
- IMC

### Silver Sponsors

- JetBrains
- Nexthink
- Scholé AI
- AXA
- UBS
- SBB

- - -

### Other Partner (anything below this cant have challenges)

- EPFL (organizer)

### Community Partners

- SwissDevJobs
- START Hack
- Socraft

### Food and Drinks Partners

- La Semeuse
- Fizzy
- Pragers
- Snacky

> Each sponsor will have their own challenges

## Team members

- [Cagan Efe Calidag](https://www.linkedin.com/in/cagancalidag), Paris-Saclay (ME)
    - Cybersecurity interest, web development (react), ai agent/harness/tool and mcp develooment, local ai
- [Sebastián Luna Valoroso](https://www.linkedin.com/in/sebastián-luna-valoroso-a73777372/) - Barcelona, Spain (discord: salv2.0 / Sardina)
    - "I’m Sebastián, 3rd year Data Engineering student at the Universitat Politècnica de Catalunya (UPC), Spain. I'm particularly interested in building ML and information retrieval systems, processing multimedia information, and solve real-world problems efficiently."
- [Joshua Hurlimann](www.linkedin.com/in/joshua-hürlimann) (discord: joshua_77639 / Joshua)
    - third year of Microengineering Bachelor at EPFL
    - "I'm familiar with coding in python, C++ (and Assembly, though I don’t think it will be of much help here) but I'm motivated to learn and put in the work necessary to build something great this weekend. "
- [Javier Ribal del Rio](https://www.linkedin.com/in/javier-ribal-del-rio) - Valencia, Spain (discord: ribal21 / Ribal21)
    - "I'm a 3rd-year student pursuing a double degree in Computer Engineering and Business Administration at UPV.
    I'm also a Project Manager at Hyperloop UPV, a student engineering team developing a high-speed transportation prototype.
    My strongest area is backend development, with experience in JavaScript, Rust and Go. I'm also familiar with React and R for data analysis."


## Sponsor chosen: UBS
### Challenge

**AI Financial Twin** — "One choice, many possible futures. Don't predict the future, make it explorable."
Build a fictional person's financial state, let a user change a life decision, recompute, compare against a
baseline, and explain the trade-offs with transparent assumptions. Full brief: [`pre_docs/`](pre_docs/README.md)
(rubric: [`pre_docs/evaluation/`](pre_docs/evaluation/)).

### Idea:

A twin you can **talk to**, whose every number is **traceable**:

1. You **chat** with the twin: ask *"What if I do a master's, or start working?"*, tell it what changed (*"I now earn 1,500"*), or change a path (*"have the kid at 35 instead"*). It sees the conversation, your current numbers and every path on screen, so it understands follow-ups.
2. An LLM turns the words into **scenario JSON** — it describes the decision, it never invents money.
3. Every blank is filled **from the data** and tagged with where it came from (`DATA` / `LEARNED` / `YOU` / `ASSUMPTION` / `UNKNOWN`).
4. A **Monte Carlo engine** (exact accounting formulas + randomness from **models estimated in R**: monthly spending from the 28,800-month ledger, and optionally Swiss inflation and unemployment from public data) simulates 500 futures per path.
5. You see bands, risk of running out of cash, goal chances, **what matters most**, and a **break-even** ("the master pays off only if salary is +23%").
6. An LLM writes a plain-English paragraph from the computed facts only — and the app **checks every number** in it against the engine.
7. A question gets a **direct answer** ("No — 0% chance of reaching your goal"), with a **confidence level computed by the simulator** (paired futures + real peer ranges + unknowns), backed by a test on ~20,000 pairs of real people.

**How it maps to UBS's brief** (all 4 MUSTs and both BONUSes): see [DEV_NOTES.md → "What the model actually does"](DEV_NOTES.md), and [diagram.html](diagram.html) for the visual version. The model separates **idiosyncratic** variables (the person: decisions + personal luck) from **macroeconomic** ones (the economy: inflation, unemployment, rates, recession, markets, house prices, shared by every path).

---

# Financial Twin — project documentation

## 1. Run the demo

### 1.1 Install the tools (once per laptop)

Everything is pinned: Node `26.13.1`, pnpm `11.28.13`, uv `0.13.9` (in [`mise.toml`](mise.toml)), Python `3.13` + numpy/pandas
(in [`ml/uv.lock`](ml/uv.lock)), all JS packages at exact versions (in each `pnpm-lock.yaml`).

**Easiest: use [mise](https://mise.jdx.dev)** (it installs the exact Node/pnpm/uv versions for this folder):

```bash
# Linux / macOS
curl https://mise.run | sh            # then restart the terminal (or follow the printed "activate" line)
# Windows (PowerShell)
winget install jdx.mise                # then restart the terminal

git clone <this repo> && cd UBS-Challenge-Lauzhack2026
mise trust && mise install             # installs node 26.13.1, pnpm 11.28.13, uv 0.13.9
```

**Without mise:** install [Node 26.13.1](https://nodejs.org), then `npm i -g pnpm@11.28.13`, and
[uv 0.13.9](https://docs.astral.sh/uv/getting-started/installation/) (only needed to retrain the model).

### 1.2 Install the project

```bash
cd frontend && pnpm install --frozen-lockfile && cd ..
cd backend  && pnpm install --frozen-lockfile && cd ..
cp backend/.env.example backend/.env   # Windows: copy backend\.env.example backend\.env
```

Edit `backend/.env` and paste the Together AI key into `LLM_API_KEY=`. Nothing else is required.
The trained model is already committed (`frontend/src/model/*.json`), so Python is **not** needed to run the demo.

### 1.3 Start

```bash
node demo.mjs          # development (auto-reload), http://localhost:5173/?demo
node demo.mjs --prod   # for the real demo: built + served statically (~120 MB RAM), http://localhost:4173/?demo
```

Open **http://localhost:5173/?demo** — this loads the challenge example (Alexia: *start working* as baseline vs *master's* vs *move abroad*).
Other people on the same Wi-Fi can open `http://<your-ip>:5173`.

Separate terminals, if you prefer: `cd backend && pnpm dev` and `cd frontend && pnpm dev`.

### 1.4 It never breaks (by design)

| If… | then… |
|---|---|
| no API key / no internet / LLM down | the chat uses offline keyword rules, the A/B texts use a template. Badge says *AI offline*. Presets always work. |
| LLM returns bad JSON | backend validates with zod, asks the LLM to fix it once, then falls back. |
| the model rejects `json_schema` | set `LLM_JSON_MODE=json_object` (or `none`) in `backend/.env`. |
| network dies mid-demo | every successful LLM answer is cached in the browser and replayed for the same question. **Rehearse your demo questions once.** |
| Python breaks | not needed at demo time — model files are bundled into the frontend. |

### 1.5 Other commands

```bash
cd frontend && pnpm test                     # 95 validation tests (R model parity, economy forecast, backtest, accounting identities, edge cases, home purchase, number checker, scenario tree, A/B comparison…)
cd frontend && pnpm test:live                # 67 tests with the REAL LLM (incl. 10 very complex sentences + answers, multi-turn conversation, branching, A/B texts) (backend must be running with a key)
cd frontend && pnpm build && pnpm preview    # production build on http://localhost:4173 (/api still proxied)
Rscript R/eda.R && Rscript R/macro.R         # re-estimate the spending model and the economy forecast -> R/output/*.csv
cd frontend && pnpm model:import             # R/output/*.csv -> src/model/spending.json, macro.json (then pnpm backtest)
cd ml && uv sync --frozen && uv run train.py # data checks, defaults and people from pre_docs/Data -> params.json, profiles.json (deterministic)
curl localhost:8000/api/schema               # the exact JSON Schema the LLM must follow
```

LLM settings (`backend/.env`): `LLM_BASE_URL` (default Together `https://api.together.ai/v1`), `LLM_MODEL`
(default `deepseek-ai/DeepSeek-V4.1-Flash-1017`), `LLM_REASONING` (`off` = no thinking, fast), `LLM_JSON_MODE`, `LLM_TIMEOUT_MS`.
Full explanation of every part: **[DEV_NOTES.md](DEV_NOTES.md)**. Any OpenAI-compatible server works
(OpenAI, Together, Groq, Ollama `http://localhost:11434/v1`, LM Studio, vLLM).

---

## 2. How it works (simple English)

```
 "What if I do a master's      ┌───────────┐  scenario JSON   ┌──────────────┐  month-by-month plan
  or start working?"  ───────► │ LLM #1    │ ───────────────► │  RESOLVER    │  + every number tagged
  (or a preset button)         │ (words →  │  (no money       │ fills blanks │    DATA/LEARNED/YOU/
                               │  JSON)    │   invented)      │ from data    │    ASSUMPTION/UNKNOWN
                               └───────────┘                  └──────┬───────┘
                                                                     ▼
 ┌──────────────┐  facts only   ┌───────────────────────────────────────────────────────┐
 │ LLM #2       │ ◄──────────── │ ENGINE  = exact formulas (cash, investments, debt)    │
 │ (numbers →   │               │         + randomness from the R models (spending, eco)│
 │  paragraph)  │               │ 500 paths per choice, same random numbers for all     │
 └──────┬───────┘               │ → bands, risk, goals, drivers, break-even, checks     │
        ▼                       └───────────────────────────────────────────────────────┘
 number checker: every number in the paragraph must exist in the engine output ✓
```

### 2.1 Formulas vs. trained model — who does what?

We **do not** let a model replace the accounting. The data has **no examples of decisions** (nobody in it does a master's or moves),
so a model trained to predict "what if" would only repeat averages. Instead:

| Part | Method | Why | Where it runs |
|---|---|---|---|
| Cash, investments, debt, net worth | **Formulas** (`cash[t+1] = cash[t] + income − spending − costs − transfers − loan payments`) | must be exact; judges test it | browser, [`sim.ts`](frontend/src/lib/sim.ts) |
| Your usual spending (excl. rent), month by month | **Estimated**: mixed model base[status, month] + city offset + small personal offset (σ<sub>u</sub> ≈ CHF 16: no persistent personal level in the data) | what the data *can* teach; structure chosen by BIC | estimated in [`R/eda.R`](R/eda.R), imported by [`import-r-model.ts`](frontend/scripts/import-r-model.ts), used in the browser |
| Feb/Aug spending spikes, city costs | **Estimated** in CHF per status and month (employed +373 in Feb), city offsets (Fribourg −121 … Zurich +176); students' tuition-like Feb/Sep peaks left out inside a study event | real patterns | same |
| Month-to-month spending surprises | **Estimated**: normal around each person's own spread (shrunk toward similar people), wider in Feb/Aug/Dec | real pattern in the ledger | same |
| December bonus | **Estimated**: 55% of employed people get one (typical 60% of a month's pay), 27% of self-employed | real pattern in the ledger | same |
| Inflation and unemployment (economy "Forecast (Swiss data)") | **Estimated**: VAR(1) on Swiss data 1991–2025 (World Bank); job loss for employees via the national rate + Swiss benefit rules (labelled assumptions) | the UBS data has no macro variation | estimated in [`R/macro.R`](R/macro.R) |
| Defaults (salary, rent by city, tuition) | **Data medians** (e.g. "median of 69 employed people aged 20-24") | nothing made up | resolver, [`resolve.ts`](frontend/src/lib/resolve.ts) |
| Things not in the data (degree premium, abroad salary, investment return) | **UNKNOWN / ASSUMPTION**, editable | honest | shown as red/orange tags |

**Monte Carlo** = run the same choice 500 times with different random months (and, in the forecast economy, different economies) → the shaded band (80% of paths),
"cash below zero in X% of paths", "goal reached in X% of paths". All choices use the **same** random numbers, so differences come from the
decision, not luck. Fixed seed → same result every time.

### 2.2 Is it right? (verifiable)

- **Backtest** (`pnpm backtest`): the R model estimated on 2025 only, the app's own engine simulates 2026 for all 1,200 profiles, compared with the real 2026 ledger:
  the 80% band contained **78.2%** of real outcomes (target 80), the 50% band **50.1%** (target 50). Typical error CHF 1,831 vs 2,445 for a naive average
  (the previous model: 2,281); cash-crunch prediction (Brier) 0.0006 vs 0.0025 (previous: 0.0012).
- **Economy backtest** (`R/macro.R`, 2005–2024): 1 year ahead the 80% range held 70% of the time for inflation and 95% for unemployment.
- **Live checks** in the UI for the selected path: cash identity, net worth = assets − debts (transfers don't change it), debt never negative, reproducible seed.
- **Tests** (`pnpm test`): the boundary cases from [`technical-validation.md`](pre_docs/evaluation/technical-validation.md) (zero income, higher tuition, loan payoff, transfers…).
- **Data checks**: the source ledger itself has 0 identity / 0 continuity violations.

### 2.3 The LLM contract

**LLM #1 — `POST /api/parse`** must return (strict JSON Schema generated from [`backend/schema.ts`](backend/schema.ts)):

```jsonc
{
  "scenarios": [                       // 1-3 paths the user wants to compare
    { "name": "Master in Zurich", "catalog_id": "S001",   // closest of the 120 catalog ideas, or null
      "events": [
        { "type": "study",             // start_job | study | relocate | income_change | household_change |
                                       // recurring_expense | one_off | invest | market_shock | take_loan | buy_home
          "label": "Master", "start_month": 0, "duration_months": 24,
          "monthly_net_income_chf": null, "income_change_pct": null, "monthly_amount_chf": null,
          "amount_chf": null, "annual_tuition_chf": null, "city": null, "household_type": null,
          "annual_rate_pct": null, "drop_pct": null, "down_payment_pct": null }
      ] }
  ],
  "horizon_years": null,
  "unsupported": ["taxes"],            // what we cannot model -> shown to the user
  "note": null
}
```
Rule: **any number the user did not say is `null`** → the resolver fills it from data and labels it. Months are counted from the start date (age 20 for Alexia: "at 25" → 60).

**LLM #2 — `POST /api/explain`** gets only the computed `facts` (medians, ranges, risks, goals, drivers, break-even) and returns
`{ headline, explanation, caveat }`. The frontend then checks every number in the text against the facts (`✓ all N numbers traced to the engine`).

### 2.4 Repo layout

```
pre_docs/          challenge material + synthetic data (given)
R/                 eda.R (spending model, LMM) + macro.R (inflation & unemployment VAR) -> R/output/*.csv; data/ = World Bank series
ml/                train.py (pandas, uv-pinned) -> data checks, defaults, people
backend/           server.ts: OpenAI-compatible LLM gateway (parse / explain), schema.ts = JSON contract
frontend/          React + Vite app (PC-first: chat | resizable divider | scenario tree, A/B tiles, comparison, charts)
  scripts/         import-r-model.ts (R/output/*.csv -> src/model/spending.json, macro.json)
  src/model/       model artifacts, committed: params.json + profiles.json (ml/train.py), spending.json + macro.json (R), backtest.json (pnpm backtest)
  src/lib/         resolve.ts (data → plan), sim.ts (engine + checks), analysis.ts (drivers, break-even, facts, number check),
                   compare.ts (A/B facts + "fits better" rule), tree.ts (tree layout), fallback.ts (offline parser), api.ts (calls + cache)
  src/components/  Tree (scenario tree), Tiles (A/B + comparison), CompareChart (year by year), Chat, Details, Trust, HowMade
demo.mjs           starts backend + frontend
mise.toml          pinned toolchain
```

### 2.5 Who works on what next

- **Models (Sebastián, Joshua)** — `R/`: calibrate investment return/volatility from public index data (see `pre_docs/resources_2/data/financial-markets-data.md`) next to `macro.R`; widen the inflation ranges; try a better spending model and keep it only if `pnpm backtest` gets better; add a backtest plot.
- **Backend (Javier)** — `backend/`: test Together models for JSON reliability (`LLM_JSON_MODE`), tune prompts in `server.ts`, add a few-shot example per event type.
- **Frontend (Cagan)** — polish the demo flow, add more presets from the 120-scenario catalog. (The UI is PC-first on purpose.)
- **Everyone** — rehearse the 3-minute demo below with the real API key (answers get cached).

### 2.6 Suggested 3-minute demo

**The full script, with exact sentences, timings, a pre-demo checklist, fixes for problems, and judge FAQs, is in [demo.txt](demo.txt).** Short version:

1. *(20 s)* Open the page. The big sentence says it: *"If nothing changes, Alexia's cash runs out at age 20."* The black dots on the chart are her **real** bank balance from the data; the band is what someone in her situation would have. In year 2 her dots are above it: she spent less than students like her, and in the data such differences don't carry over from one year to the next (across all 1,200 people the real balance is inside the band 78% of the time).
2. *(40 s)* Click **▶ Demo**: the scenario tree shows *Today* branching into *Start working* (**A**, green), *Master's* (**B**, blue) and *Move abroad*. Read the two tiles ("So far / Ahead", written for Alexia from the computed numbers, every number checked) and the A vs B comparison: *fits your goals better* (computed: cash first, then goals, then money), labelled **Not financial advice**.
3. *(40 s)* Click the *Master's* card → **The numbers behind it**: tuition **from data** (her row in scenario-assumptions.csv), salary **from data** (median of 69 peers), salary premium **unknown**. Break-even: "catches up only if income is 23% higher". Set the premium to 30% → everything recomputes instantly.
4. *(40 s)* Click the chat idea *"Work now, lose my job for 6 months at 25, then buy a flat for 300k at 28"* → one new node with 3 events (a branch of *Start working*), compared as **B**, plus a direct answer in the chat with a **confidence level computed by the simulator**. Optional: **⑂ Branch off** a tile to add a later decision.
5. *(40 s)* Open **Can you trust this?**: maths checks 5/5; estimated on 2025 and tested on 2026, the "8 in 10" range caught 78.2% of real results. "Don't predict the future, make it explorable."

### 2.7 Limitations (say them before the judges do)

- Synthetic data: incomes don't depend on age (≈ CHF 8k net at every age), spending barely depends on income — so "start working at 20" looks very rich. The salary pill is editable.
- No education/abroad data → degree premium and abroad numbers are UNKNOWN (we show break-even instead of guessing).
- Constant 2025 CHF (no inflation); net income (taxes already inside); investment return 4% a year (UBS's illustrative rate from financial-concepts.md; editable, shared by every path).
- The band shows month-to-month variability, not uncertainty about the assumptions (that's the drivers panel). Not a forecast, not advice.

### 2.8 What we built vs. reused (LauzHack rule)

- **Reused:** challenge data, docs and the starter-kit modelling convention (`pre_docs/`, by Stefania Stan / UBS); open-source libraries
  (React, Vite, Recharts, zod, openai SDK, numpy, pandas, vitest); the "move abroad" preset numbers come from the starter kit's `scenario_config.json`.
- **Built during the event:** everything in `ml/`, `backend/`, `frontend/`, `demo.mjs`.

