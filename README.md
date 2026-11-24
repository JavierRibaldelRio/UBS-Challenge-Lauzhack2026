# Financial Twin

Financial Twin is an interactive scenario-modeling application for exploring how life decisions may affect a fictional individual's financial position. Rather than presenting a single forecast, it lets users compare alternative paths—such as entering employment, pursuing further education, or relocating—under transparent assumptions and uncertainty.

The project was developed for the UBS AI Financial Twin challenge at LauzHack 2026.

> **Important:** This prototype uses synthetic data and simulated outcomes. It is an educational decision-exploration tool, not financial advice or a guarantee of future results.

## LauzHack and the UBS challenge

[LauzHack](https://lauzhack.com) is a student-run hackathon held at the École polytechnique fédérale de Lausanne (EPFL) in Lausanne, Switzerland. This project was created in response to the UBS **AI Financial Twin** challenge:

> **One choice. Many possible futures.**
> **Do not predict the future. Make it explorable.**

The challenge asks teams to build an interactive computational representation of a fictional person's finances. A successful solution should let a user change a meaningful decision or life event, recompute its conditional consequences, compare it with a baseline, and explain the resulting trade-offs with clear assumptions and limitations. It explicitly focuses on making alternative futures explorable rather than claiming to predict a single future.

Financial Twin addresses this brief through a conversational scenario interface, transparent input provenance, accounting-based monthly simulation, and uncertainty-aware comparison of alternative paths. The complete challenge framework and reference material are available in [`pre_docs/README.md`](pre_docs/README.md).

## Overview

A user can begin with a fictional financial profile and describe a decision in natural language or select a predefined scenario. The application transforms that choice into a structured scenario, completes missing inputs from documented data-based defaults, and simulates the financial consequences month by month. It then compares the selected paths using projected cash, investments, debt, net worth, financial-goal attainment, and cash-shortfall risk.

Every output is intended to be inspectable. Values are identified according to their origin:

| Source | Meaning |
| --- | --- |
| Data | Derived from the supplied synthetic dataset |
| Learned | Estimated from patterns in the synthetic financial records |
| User | Provided or edited by the user |
| Assumption | A transparent, editable modeling assumption |
| Unknown | A value that cannot be supported by the available data |

## How the application works

1. **Define a baseline.** The app loads a fictional person's financial state, including income, recurring expenditure, savings, investments, debt, and goals.
2. **Create alternatives.** A user describes a change—such as studying, changing employment, or moving city—or chooses a scenario preset.
3. **Structure and resolve the scenario.** An LLM can translate natural-language input into schema-validated scenario data. A resolver fills only supported defaults and preserves the provenance of each value.
4. **Simulate financial paths.** The browser runs monthly accounting for each path, covering income, expenditure, transfers, loan payments, cash, assets, liabilities, and net worth.
5. **Explore uncertainty.** A Monte Carlo simulation runs 500 paired futures per alternative. Paths share the same random conditions so their differences reflect the decision rather than different luck.
6. **Compare and explain results.** The interface presents outcome ranges, cash-shortfall probability, goal-achievement probability, sensitivity drivers, and break-even estimates. Generated explanations are constrained to facts produced by the simulation and checked against its output.

## Financial and modeling approach

The core model is an accounting simulation, not a black-box prediction model. At every monthly step, it updates cash flows and balance-sheet quantities using relationships such as:

```text
cash(t + 1) = cash(t) + income - spending - event costs - transfers - debt payments
net worth = cash + investments + property - outstanding debt
```

The model combines deterministic financial identities with uncertainty estimated from the supplied synthetic ledger. The training process learns empirical monthly spending variation, seasonality, employment-related patterns, and spending responses to characteristics such as income, rent, household context, and age. Personal historical records calibrate the baseline where available.

Monte Carlo simulation represents variation in future monthly conditions rather than a certain forecast. The application uses the simulated distribution to report, for example:

- an 80% outcome range for projected financial quantities;
- the probability of cash falling below zero;
- the probability of meeting a savings or investment goal by its target date;
- assumptions and variables with the largest effect on a comparison; and
- the approximate condition under which one alternative becomes financially preferable to another.

The supplied synthetic dataset contains 1,200 fictional profiles and 28,800 monthly cash-balance observations across 2025–2026, together with synthetic assets, liabilities, goals, and scenario data. The data are used to calibrate the model; no real personal financial records are required.

For validation, the training workflow fits on 2025 observations and tests simulated 2026 outcomes against the held-out synthetic ledger. The user interface also checks accounting identities, non-negative debt balances, and reproducibility of the simulation seed.

## Technology stack

| Area | Technologies | Role |
| --- | --- | --- |
| Front end | React, TypeScript, Vite, Recharts | Interactive scenario editor, charts, and comparison interface |
| Back end | Node.js, TypeScript, Zod, OpenAI-compatible API | Scenario parsing, structured-output validation, and generated explanations |
| Modeling | Python, NumPy, pandas | Data preparation and deterministic calibration of simulation parameters |
| Simulation | TypeScript in the browser | Monthly cash-flow accounting and Monte Carlo scenario analysis |
| Tooling | pnpm, uv, mise | Reproducible JavaScript and Python environments |

The application is designed to remain usable without an LLM connection: predefined scenarios, the simulation engine, and fallback parsing and explanation behavior continue to work locally.

## Repository structure

```text
frontend/       React application and browser-based simulation engine
backend/        API service, schemas, and LLM integration
ml/             Model-calibration workflow
pre_docs/       Challenge documentation and synthetic source data
DEV_NOTES.md    Detailed architecture, data, and validation notes
demo.mjs        Development and production demo launcher
```

## Getting started

### Prerequisites

The project pins its toolchain in [`mise.toml`](mise.toml): Node.js 26.13.1, pnpm 11.28.13, uv 0.13.9, and Python 3.13 for model retraining. Using [mise](https://mise.jdx.dev) is recommended:

```bash
git clone <repository-url>
cd ai-financial-twin-lauzhack-2026
mise trust
mise install
```

### Install dependencies

```bash
cd frontend && pnpm install --frozen-lockfile && cd ..
cd backend && pnpm install --frozen-lockfile && cd ..
cp backend/.env.example backend/.env
```

To enable LLM-assisted natural-language interaction, set `LLM_API_KEY` in `backend/.env`. The model artifacts used by the demo are already included in `frontend/src/model`, so Python is not necessary to run the application.

### Run the application

```bash
node demo.mjs
```

Open `http://localhost:5173/?demo` to use the bundled demonstration profile. For a production-style local run:

```bash
node demo.mjs --prod
```

This serves the application at `http://localhost:4173/?demo`.

Alternatively, start each service independently:

```bash
cd backend && pnpm dev
cd frontend && pnpm dev
```

## Quality checks and retraining

```bash
cd frontend && pnpm test
cd frontend && pnpm build
cd backend && pnpm typecheck
cd ml && uv sync --frozen && uv run train.py
```

The test suite covers accounting identities, financial edge cases, scenario handling, and validation of generated numerical explanations. Retraining reads the synthetic data in `pre_docs/Data` and regenerates the frontend model artifacts deterministically.

## Team

| Member | University |
| --- | --- |
| Cagan Efe Calidag | Université Paris-Saclay |
| Sebastián Luna Valoroso | Universitat Politècnica de Catalunya |
| Joshua Hurlimann | École polytechnique fédérale de Lausanne |
| Javier Ribal del Rio | Universitat Politècnica de València |

## Further documentation

- [Architecture, methodology, and validation notes](DEV_NOTES.md)
- [Challenge brief](pre_docs/README.md)
- [Synthetic data documentation](pre_docs/Data/README.md)
- [Technical validation cases](pre_docs/evaluation/technical-validation.md)
