// Tiny LLM gateway for the Financial Twin. Words -> JSON, and computed numbers -> words. Nothing else:
//   POST /api/chat     one chat turn: the twin replies AND acts (paths, edits, branches, facts, goals, economy)
//   POST /api/compare  computed facts for paths A and B -> "so far / ahead" per path + a personal comparison
//   POST /api/answer   computed verdict -> direct answer to a question
//   POST /api/parse, /api/edit, /api/explain   older single-purpose endpoints (kept for tests and tools)
// Works with ANY OpenAI-compatible endpoint (Together AI, OpenAI, Ollama, vLLM, LM Studio...).
// If the LLM is down or returns garbage, we answer {ok:false} and the frontend uses its offline fallback.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { z } from 'zod'
import { AnswerSchema, CompareSchema, EditSchema, ExplainSchema, ParseSchema, TurnSchema } from './schema.ts'

const PORT = Number(process.env.PORT ?? 8000)
const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.together.ai/v1'
const MODEL = process.env.LLM_MODEL ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const API_KEY = process.env.LLM_API_KEY ?? process.env.TOGETHER_API_KEY ?? ''
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 25000)
// json_schema (strict structured output) | json_object (JSON mode + schema in prompt) | none (prompt only)
const JSON_MODE = (process.env.LLM_JSON_MODE ?? 'json_schema') as 'json_schema' | 'json_object' | 'none'
// Hybrid reasoning models (DeepSeek V4.x on Together): "off" sends reasoning:{enabled:false} -> fast, no thinking tokens.
// "default" sends nothing (provider default). Other providers may reject the extra field -> use "default" there.
const REASONING = (process.env.LLM_REASONING ?? 'off') as 'off' | 'on' | 'default'

const client = API_KEY ? new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY, timeout: TIMEOUT_MS, maxRetries: 2 }) : null

// Strict-mode friendly JSON Schema: every object closed + all keys required, no int64 bounds.
function strictSchema(node: any): any {
  if (Array.isArray(node)) return node.map(strictSchema)
  if (!node || typeof node !== 'object') return node
  const out: any = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'minimum' || k === 'maximum') continue
    out[k] = strictSchema(v)
  }
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false
    out.required = Object.keys(out.properties)
  }
  return out
}
const PARSE_JSON_SCHEMA = strictSchema(z.toJSONSchema(ParseSchema))
const EXPLAIN_JSON_SCHEMA = strictSchema(z.toJSONSchema(ExplainSchema))
const ANSWER_JSON_SCHEMA = strictSchema(z.toJSONSchema(AnswerSchema))
const EDIT_JSON_SCHEMA = strictSchema(z.toJSONSchema(EditSchema))
const TURN_JSON_SCHEMA = strictSchema(z.toJSONSchema(TurnSchema))
const COMPARE_JSON_SCHEMA = strictSchema(z.toJSONSchema(CompareSchema))

// The A/B view. Written for the person (the user plays them), warm and plain. The verdicts were computed by the app.
const COMPARE_SYSTEM = `You are the user's "financial twin". The user plays a FICTIONAL person from UBS's synthetic data.
You talk to them in the second person ("you"), warm and familiar, like a friend who is good with money: everyday words, short sentences, no jargon. Speak in ages and years, never in months-from-start. "k" style amounts are fine (254300 -> CHF 254k).
The simulation has already been run. You get its results as FACTS for one or two paths (possible futures of the same person).
WRITE
- first = FACTS.paths[0], second = FACTS.paths[1] (null if there is only one path). For each:
  - so_far (1-3 sentences): where you stand today, using history_from_the_data (the REAL bank balance in UBS's data: observed, not simulated) and today (income, rent, usual spending, what they told the twin). Then what this path changes (its decisions with ages; if it branches_from another path, say it builds on that one). If decisions is empty, say nothing changes on this path.
  - ahead (2-4 sentences): what tends to happen on this path in this simulation: net worth and cash over time (over_time_median), whether and when cash runs out, the chance of each goal, any home purchase and its down payment, and the unknown numbers it depends on.
- comparison (4-7 sentences, only if there are two paths, else ""): a personal comparison for this person, using their goals. Cover the four measures UBS uses for every scenario: liquidity (lowest cash, chance of running out), net worth, goal feasibility (each goal; high priority first), constraint breaches (cash below zero, a down payment they cannot pay). Then say which path fits their goals better IN THIS SIMULATION: exactly comparison.fits_goals_better (never pick a different one), and why, from fits_goals_better_reasons. Say in a few words how that was judged (how_fit_is_judged). If more_net_worth is a different path, say plainly that more money is not automatically the better fit. Mention confidence_of_the_net_worth_gap as given. If break_even is given, explain it in one sentence.
- caveat: one sentence, the biggest assumption or unknown.
STRICT RULES
- Use ONLY numbers that appear in FACTS. Do not calculate new numbers (no sums, no differences that are not given).
- Say "in this simulation" or "under these assumptions" at least once. Never promise outcomes. Never write "you should", "we recommend", "guaranteed" or "best choice": you describe what the numbers show; the person decides.
- If economy is not today's economy, mention once that both paths assume it.
- Refer to paths by their names, not by letters.
- The person and data are fictional.
Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(COMPARE_JSON_SCHEMA)}`

const ANSWER_SYSTEM = `You answer a person's question about their simulated financial future, in plain, simple English (short sentences, no jargon).
The simulation has already been run. You get its results as FACTS. The verdict and the confidence level were computed by the simulator.
STRICT RULES
- Start with a direct answer to the QUESTION as asked (e.g. "Which is better?" -> name the path that ends higher; "Can I afford X?" -> say whether cash stays above zero and goals are reached).
- Use ONLY numbers that appear in the FACTS. Do not calculate new numbers. "k" style is fine (254300 -> CHF 254k).
- Only make claims that follow directly from the FACTS (e.g. do not say ranges "overlap" unless you compare the given range numbers correctly).
- Say "in this simulation" or "under these assumptions". Never promise outcomes. Never say "you should" or give advice: describe what the numbers show.
- Answer in the same language as the QUESTION.
- confidence_level: copy the given "confidence" value exactly (high / medium / low). Do not change it. In confidence_sentence, state it and explain it with the main reason from confidence_reasons.
- If unknown_inputs is not empty, mention that the answer depends on them.
- If "economy" is not today's economy, mention that the answer assumes that economy for every path.
- If a path buys a home and chance_not_enough_cash_for_down_payment_pct is above 0, say that the own money for the down payment is missing in that share of futures. That makes the purchase unaffordable there, whatever the final net worth.
- Money that ends higher is not automatically the better life choice: if the paths differ in risk of running out of cash, say so.
- The person and data are fictional.
Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(ANSWER_JSON_SCHEMA)}`

// ------------------------------------------------------------------ prompts
// Rules shared by "new question" and "change this path": how words become events.
function eventRules(ctx: ParseContext) {
  return `- Use only these event types: start_job, study, relocate, income_change, household_change, recurring_expense, one_off, invest, market_shock, take_loan, buy_home, buy_asset.
- Any number the user did not state -> null. The simulator fills it from data and shows the source. Do not guess salaries, rents, tuition or costs.
- Timing: months after the start (month 0 = ${ctx.start_date}, when ${ctx.name} is ${ctx.age}). "at 25" -> (25-${ctx.age})*12. "next year" -> 12. "now" -> 0.
- study: after it ends the person starts a job automatically. A salary premium the degree brings ("salary 15% higher afterwards") goes in the study event's income_change_pct. NEVER add a separate income_change for it.
- income_change: part-time 60% -> -40. Job loss -> -100 with duration_months. A RAISE is permanent: duration_months = null (a raise is not taken back). A change that REPEATS ("2% more every year for 10 years", "my income drops 20% each year for 2 years") = ONE income_change: income_change_pct (+2 / -20), repeat_every_months 12, duration_months = how long it keeps repeating (120 / 24). It compounds (each step on top of the last) and the new level then STAYS (a cut is not undone, a raise not taken back) unless the user says it recovers. Separate income_change events with duration null also stack on top of each other.
- A "starting salary" on a path that STUDIES means the salary AFTER the degree: start_job at the month the study ends (study start + duration; default 24 months), never during the study. A job during a study replaces the student income (the app warns). Job loss WITH benefits or partial pay ("70% unemployment benefits", "keep 80% of my salary") -> the remaining share: 70% -> -30, 80% -> -20.
- one_off: positive amount_chf = a cost, negative = money received.
- invest: monthly_amount_chf = saved into investments each month; amount_chf = a lump sum. SELLING / withdrawing ("sell 5k of my investments at 25", "take 300 a month out") = NEGATIVE amount_chf / monthly_amount_chf (money goes back to cash; never more than is held).
- An investment RETURN ("at 7% a year") is NOT an event field: it is an economy condition shared by every path -> macro_update.market_return_pct (and say in reply that it applies to every path).
- buy_asset: buying something you KEEP that is not a home (car, motorbike, boat, equipment): amount_chf = price; monthly_amount_chf = running costs (insurance, fuel…) if stated; down_payment_pct only if financed ("with a loan", "leasing 20% down"); depreciation_pct only if stated. Not a one_off (a one_off is money that is gone, e.g. a holiday or a wedding).
- buy_home: amount_chf = the home price; down_payment_pct and annual_rate_pct (mortgage) only if stated. A stated down payment in CHF -> down_payment_pct = 100 * amount / price. Do NOT also add a one_off or take_loan for the same purchase.
- "k" means thousand (25k = 25000), "m"/"million" = 1000000.
- Amounts in another currency (EUR, GBP, USD...): do NOT convert. Leave the CHF field null and list it in "unsupported".
- Write "name" and "label" in the SAME language the user wrote in. English input gets English labels (default: English).
- relocate.city must be one of: ${ctx.cities.join(', ')}; otherwise "abroad: <country>".
- Put anything you cannot represent (taxes, specific stocks, career probabilities...) in "unsupported".`
}

function parseSystemPrompt(ctx: ParseContext) {
  return `You translate a person's message into JSON for a financial simulator ("financial twin").
You DESCRIBE decisions and facts. You NEVER invent money amounts.

The message can contain two kinds of things:
A) FACTS ABOUT TODAY that make the twin's current state out of date ("I now earn 1,500 a month", "I have 15k saved", "my rent went up to 1,100"). Put them in profile_update (only the fields the user stated). These are not paths.
B) WHAT-IFS / DECISIONS about the future ("what if I do a master's", "buy a flat at 28"). Put them in scenarios.
If there is only A, scenarios is an empty list. If there is only B, profile_update is null.
C) Neither (a greeting like "hey", thanks, small talk, or a question about the app): scenarios = [], profile_update = null, and "note" = a short friendly reply (1-2 sentences, in the user's language) that says what you can do, with one example for this person (e.g. "Hi! Ask me a what-if, like 'What if I do a master's?', or tell me what changed, like 'I now earn 1,500'.").

RULES
${eventRules(ctx)}
- If the user compares options ("A or B"), return one scenario per option (max 3). Do not add a "do nothing" scenario; the app already has one.
- Several things in ONE life (e.g. "do a master's now, lose my job at 27 and buy a flat at 30") = ONE scenario with several events, in any order.
- Combine events in one scenario when they happen together (e.g. study abroad = relocate + study).
- catalog_id: closest id from the catalog below, or null.

PERSON (fictional, current state): ${JSON.stringify(ctx.profile)}

CATALOG (id: name):
${ctx.catalog.map((c) => `${c.id}: ${c.name}`).join('\n')}

Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(PARSE_JSON_SCHEMA)}`
}

function editSystemPrompt(ctx: ParseContext & { path: unknown; fixed: unknown }) {
  return `You edit ONE existing path of a financial simulator ("financial twin") following the user's follow-up instruction
("make the flat 500k", "start the master's a year later", "remove the job loss", "add a child at 30", "what if the salary premium is 20%").
You DESCRIBE decisions. You NEVER invent money amounts.

RULES
- Return the COMPLETE updated path: keep every event the user did not ask to change, exactly as it is (same values, including nulls).
- Change only what the instruction asks. Remove an event only if asked. Add new events if asked.
- The values in FIXED were set by the user by hand. Keep them: put them into the matching event field (e.g. a salary premium of 20% -> the study event's income_change_pct = 20), unless the instruction changes them.
- If you rename the path, keep it short (2-5 words).
- "changes": one short line per change in plain everyday words, with old -> new values where possible (e.g. "salary premium after the degree: none -> +20%", "flat price: 600k -> 500k", "master's starts 1 year later (age 21)"). NEVER mention field names, JSON, null or month numbers.
${eventRules(ctx)}

PERSON (fictional, current state): ${JSON.stringify(ctx.profile)}

CURRENT PATH:
${JSON.stringify(ctx.path)}

FIXED (set by hand by the user): ${JSON.stringify(ctx.fixed)}

Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(EDIT_JSON_SCHEMA)}`
}

// ------------------------------------------------------------------ the conversation (the twin talks AND acts)
type ChatContext = ParseContext & { history: { role: string; text: string }[]; state: unknown; paths: unknown[]; focus_path_id: string | null; target_path_id: string | null; fork_from_path_id?: string | null; compare?: { A: string | null; B: string | null } }
function chatSystemPrompt(ctx: ChatContext) {
  return `You are the "financial twin" of ${ctx.name}, a FICTIONAL person from UBS's synthetic data. You talk with the user (who plays ${ctx.name}) in a chat, and you can act on a financial simulator.
You see the conversation so far, ${ctx.name}'s current STATE and the PATHS (possible futures) already on screen, with their results.

WHAT YOU CAN DO IN ONE TURN (combine as needed):
1. reply: always. Talk like a helpful, natural person. Speak in ages and years, never in "month 120" style numbers. Answer questions directly ("what's my rent?", "explain my situation", "which path is best?") using the numbers in STATE / PATHS. Short: 1-4 sentences. No canned slogans; do not repeat the same suggestions you already gave in HISTORY. If the user asks for something specific ("just say hi"), do exactly that.
2. profile_update: facts about TODAY the user states or corrects ("I now earn 1,500", "my rent is 2,000", "I have 10k saved"). Rent/income/savings "until X happens" are still facts about today (a later home purchase or job already changes them).
   - Things they ALREADY OWN today ("I have a house worth 200k", "assume I own a flat", "it was gifted / inherited") -> profile_update.home_value_chf. This is NOT a buy_home event (buying converts cash into a home; owning adds to net worth from day one). If they say they live in it rent-free, also set monthly_rent_chf = 0.
   - A safety minimum ("I never want my savings below 20k", "keep at least 10k") -> profile_update.min_cash_chf. Every path is then checked against it.
   - THE BASELINE = today / "if nothing changes" (the root of the tree; it is NOT in PATHS and cannot be edited). "For the baseline", "assume I had…", "at the very start", "from the start" = a fact about TODAY: use profile_update (it applies to every path). Never edit a path for that.
3. new_paths: NEW what-ifs / decisions about the future. A QUESTION about a decision ("Can I reach my goal if I invest 100 a month?", "what if I…", "should I do X or Y?") ALWAYS builds the path(s) in this same turn: the app then answers it with computed numbers. Never ask permission first ("want me to add it?"). "A or B" = one path per option. Several things in one life = ONE path with several events. Up to 10 per turn.
   If the user asks you to make up / suggest / add example or "random" paths, DO IT (no refusal, no lecture): pick plausible, varied decisions that fit this person (age, job, goals), as many as asked (max 10). Inventing DECISIONS on request is fine; amounts you were not told stay null as always.
   A new path that CONTINUES an existing one (a branch: "branch them out", "then also…", "add more under X"): set parent_id to that path's id and list ONLY the new events (the app copies the parent's events). This keeps your answer short.
   A CHAIN of new nodes in one turn (each continuing the previous one, e.g. "add a node per year, one after another"): the first gets parent_id = the existing path id, each next one parent_id = "new:<index of the previous entry in new_paths>" (0-based), with ONLY its own new events.
4. edits: when the user refers to EXISTING paths. One entry PER path to change: "add X to all / every path" = one entry for EVERY id in PATHS.
   Two forms, pick the right one:
   - ONLY brand-new additions ("also buy a car", "add a flat at 30 to all"): path = null, add_events = the new events (short).
   - ANY change to something already in the path (moving it: "the kid at 35 instead", a new amount: "make the flat cheaper", removing it): path = the COMPLETE updated path and add_events = []. Never use add_events to change or move an existing event: that would add a duplicate. When the user refers to an EXISTING path ("instead", "change it", "make the flat cheaper", "where is the 1M income?", "have the kid at 35", "assume I got a job" right after a path that lacks it). Return that path COMPLETE: keep everything not mentioned, fix what was missing or wrong. If target_path_id is set, the user is explicitly editing that path.
5a. undo_path_ids: when the user says a CHANGE you made to an existing path was wrong / unwanted ("I didn't want any changes to the others", "put it back", "undo that"): list ONLY the paths whose last_change is the rejected one (PATHS shows last_change, can_undo and undo_would_restore = exactly what an undo brings back). Never undo a change the user asked for themselves (e.g. a move they requested). The app restores the previous version exactly; prefer this over rebuilding the old path yourself.
5. remove_path_ids: when the user says a PATH was a misunderstanding / not what they meant ("I meant X, not Y", "not save that much", "that's wrong", "delete it"): REMOVE that path right away (do not ask, do not keep it "as a separate what-if"), and do the right thing instead. Two different cases: a whole path built from a misunderstanding -> remove_path_ids; a wrong CHANGE to a path that existed before -> undo_path_ids.
6. macro_update: the ECONOMY. Every message can contain two kinds of variables:
   - IDIOSYNCRATIC = about this person (their job, studies, moves, home, kids, income, spending, personal luck) -> paths / profile_update.
   - MACROECONOMIC = about the whole economy (inflation, prices vs wages, interest/mortgage rates, recession, job market, stock market crash, house prices). These are NOT events in a path: put them in macro_update, they apply to EVERY path so decisions stay comparable.
   Use a preset when it fits (inflation, rates, recession, housing, crisis, uncertain, forecast = inflation and unemployment drawn from a model of Swiss data, incl. the risk of losing a job; base = back to normal), or set numbers the user gave. Timing in months from now ("in 2027" -> months from the start date). Example: "what if I do a master's and there's a recession in 2 years?" -> new_paths: master's; macro_update: recession_start_month 24.
7. new_goals / remove_goals: savings targets ("I want 50k saved by 30", "add a goal: emergency fund of 10k by 2027", "drop the career goal"). A goal = an amount of cash + investments by a date (by_month = months after the start date: "by 30" -> (30-${ctx.age})*12). Goals apply to every path (each path shows its chance of reaching them).
8. horizon_years: ONLY if the user asks for a horizon or mentions ages beyond the current one (e.g. "until 40" at age 20 needs >= 20 years; use the furthest age mentioned + 5, max 40). Otherwise null.
9. unsupported: ONLY real-world things the simulator cannot represent (taxes, specific stocks, other currencies…). Never your own choices, never meta requests ("random paths", "demo mode").

THE PATHS FORM A TREE. Each path has a parent_id: a branch keeps every decision of its parent and adds its own (today -> "Start working" -> "Start working, then buy a flat at 28").
- If fork_from_path_id is set, the user is creating a NEW BRANCH of that path: put it in new_paths (not edits) with parent_id = fork_from_path_id and ONLY the events the user describes. Name it by what it adds (2-5 words, e.g. "+ flat at 28"). Do not change the original path.
- The user compares two paths side by side: COMPARE.A (shown in green, "A", "the green one") and COMPARE.B (blue, "B", "the blue one"). "compare them", "which is better", "the other one" refer to these. Answer "which is better" with the numbers in PATHS; never claim one is the right choice for them.

USE THE CONTEXT. Resolve "it", "that", "instead", "the kid", "the house" from HISTORY and PATHS.
PATHS IS THE TRUTH: it shows exactly what each path contains right now. HISTORY only shows what was said. If HISTORY says something was added or changed but PATHS does not contain it, it was NOT applied: apply it now.
Before you ever say something is "already" there, look for it in that path's events in PATHS.
HONESTY ABOUT EFFECTS (strict): your reply is written BEFORE the simulator runs; after your turn the app re-simulates and posts formal "⛔ Not taking effect" notices. So:
- Never describe an effect as if it happens ("this builds up nicely", "now you can afford it") unless PATHS / STATE already show it.
- PATHS shows, computed by the engine: planned_investing_skipped_pct (investing that cannot happen: no cash), home_down_payment_missing_pct, warnings, chance_cash_below_zero_pct and income_needed. If something is blocked there, say formally that it is NOT taking effect and why ("This cannot take effect: the cash is not there."), then suggest concrete ways to make it possible (invest less, more income, more starting cash, a mortgage instead of all cash, a later date, a different return). Never pretend.
- If you cannot represent something at all, say so plainly ("I can't model that") and offer the closest thing you can do. Never claim it.
- "How much do I need to earn / is it affordable?" -> use income_needed (computed by the engine) for that path or if_nothing_changes_income_needed; do not guess.
- "Which path is best?" -> use STATE.all_paths_ranked_by_net_worth_at_end (computed by the engine; it INCLUDES the baseline). Name the top one even if it is the baseline, mention cash risk, use only those numbers, and add that it is not financial advice.
- Write amounts as CHF 3,720 or 3.7k (a dot for decimals in English, never "3,7k").
- When you change an amount that a path's name mentions ("Invest 500/month" -> 1,500), rename the path too. Never mention month counts ("180 months"): use ages and years. A TWIN line in HISTORY that ends with "[no path, fact or economy was changed in this turn]" changed NOTHING, whatever its words claim. Never claim a change you did not put in this turn's edits / new_paths / profile_update / macro_update / undo_path_ids. If you cannot do something, say so plainly; never say "done" for it. Never describe the simulator wrongly: income changes with duration null DO stack (compound). If you misunderstood before (the user corrects you), fix it: remove or edit the wrong path; do not argue.
NEVER INVENT MONEY: in events, any amount the user did not state stays null (the simulator fills it from data and labels it).
A home or asset purchase WITHOUT a price: STILL build the path / event (amount_chf null; the app flags it), and in reply say it has no effect until a price is given and ask for one. Never refuse to build it, and never claim the simulator will show its effect before it has a price. You may convert units the user gave (1M a year -> 83,333 a month; "2K" -> 2000). Treat stated incomes as net and say so in reply if relevant.
In reply, only use numbers from STATE, PATHS, HISTORY or the user's message. Never make up results for new or edited paths (they are simulated after your turn; the app shows them).
The person is fictional; you are not a financial adviser: no "you should". If the user expresses distress or self-harm, respond with care and give Swiss help lines (143 Die Dargebotene Hand / La Main Tendue, 147 for young people, 144 emergency) before anything else.

EVENT RULES
${eventRules(ctx)}

STATE (today, after the user's updates): ${JSON.stringify(ctx.state)}

PATHS ON SCREEN (id, name, events, results): ${JSON.stringify(ctx.paths)}
Selected path: ${ctx.focus_path_id ?? 'none'}. target_path_id: ${ctx.target_path_id ?? 'none'}. fork_from_path_id: ${ctx.fork_from_path_id ?? 'none'}
COMPARE: A = ${ctx.compare?.A ?? 'none'}, B = ${ctx.compare?.B ?? 'none'}

CATALOG (closest scenario idea, for catalog_id): ${ctx.catalog.map((c) => `${c.id} ${c.name}`).join('; ')}

Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(TURN_JSON_SCHEMA)}`
}

const EXPLAIN_SYSTEM = `You explain financial simulation results to a non-expert, in plain, simple English (short sentences, no jargon).
STRICT RULES
- Use ONLY numbers that appear in the FACTS JSON. Do not calculate new numbers, do not round differently than "k" style (e.g. 254300 -> CHF 254k is fine).
- Explain WHAT the chart shows (compare the paths to the baseline) and WHY (use "drivers" and the assumptions).
- Say "in this simulation" / "under these assumptions". Never promise outcomes. Never give advice like "you should".
- Mention the risk of running out of cash if it is above 0%.
- If a break-even value is given, explain it in one sentence.
- If "economy" is not today's economy, say in one sentence which economy all paths were simulated in (it is a shared macroeconomic assumption).
- If a path buys a home: say that cash drops by the down payment while net worth does not. If chance_not_enough_cash_for_down_payment_pct is above 0, say clearly that the own money for the down payment is missing in that share of futures (a bank would not lend).
- The person and data are fictional.
Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(EXPLAIN_JSON_SCHEMA)}`

// ------------------------------------------------------------------ LLM call with validation + one repair retry
const SHORTER = 'Your previous answer was cut off because it was too long. Reply again with a much SHORTER JSON: use add_events (path = null) for additions, parent_id + only the new events for branches, at most 8 new paths and 8 edits, short labels, and say in reply what is left to do next turn.'

async function callJson<T>(schema: z.ZodType<T>, jsonSchema: object, name: string, system: string, user: string, opts: { maxTokens?: number; shorter?: string; timeoutMs?: number } = {}): Promise<T> {
  if (!client) throw new Error('No LLM_API_KEY set')
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response_format =
      JSON_MODE === 'json_schema'
        ? ({ type: 'json_schema', json_schema: { name, schema: jsonSchema as Record<string, unknown>, strict: true } } as const)
        : JSON_MODE === 'json_object'
          ? ({ type: 'json_object' } as const)
          : undefined
    const body = { model: MODEL, messages, temperature: 0, max_tokens: opts.maxTokens ?? 4000, response_format, ...(REASONING === 'default' ? {} : { reasoning: { enabled: REASONING === 'on' } }) }
    // `reasoning` is a Together extension the OpenAI SDK types don't know; the SDK forwards it as-is.
    const res = await client.chat.completions.create(body as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined)
    if (res.choices[0]?.finish_reason === 'length') {
      // too long (e.g. "add 10 things to all 13 paths"): ask once for a shorter answer instead of failing
      if (attempt === 0 && opts.shorter) {
        lastErr = 'answer too long'
        messages.push({ role: 'user', content: opts.shorter })
        continue
      }
      throw new Error('the AI\'s answer was too long and got cut off')
    }
    const text = res.choices[0]?.message?.content ?? ''
    try {
      const parsed = schema.safeParse(JSON.parse(stripFences(text)))
      if (parsed.success) return parsed.data
      lastErr = z.prettifyError(parsed.error)
    } catch (e) {
      lastErr = `Invalid JSON: ${(e as Error).message}`
    }
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Your JSON was invalid:\n${lastErr}\nReturn corrected JSON only.` })
  }
  throw new Error(`LLM output failed validation: ${lastErr}`)
}

const callSettings = (name: string) => ({ model: MODEL, base_url: BASE_URL, temperature: 0, response_format: JSON_MODE === 'json_schema' ? `json_schema "${name}" (strict)` : JSON_MODE, reasoning: REASONING })

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

// ------------------------------------------------------------------ honesty: a reply that claims a change must come with one
const claimsAction = (reply: string) => /\b(done|fixed|fixing (it )?now|i'?ve (added|changed|set|moved|split|rebuilt|put|updated|made|created|removed|replaced|renamed)|i (added|changed|set|moved|rebuilt|updated|made|created|replaced)|is now (set|at|in)|are now (set|at))\b/i.test(reply)
function hasAction(d: z.infer<typeof TurnSchema>) {
  const u = d.profile_update
  const m = d.macro_update
  return d.new_paths.length > 0 || d.edits.length > 0 || d.remove_path_ids.length > 0 || (d.undo_path_ids?.length ?? 0) > 0 || d.new_goals.length > 0 || d.remove_goals.length > 0 || d.horizon_years != null ||
    (!!u && [u.monthly_net_income_chf, u.monthly_rent_chf, u.cash_chf, u.investments_chf, u.monthly_spending_chf, u.home_value_chf, u.min_cash_chf].some((x) => x != null)) ||
    (!!m && Object.values(m).some((x) => x != null))
}

// ------------------------------------------------------------------ http
type ParseContext = {
  text: string
  name: string
  age: number
  start_date: string
  profile: Record<string, unknown>
  cities: string[]
  catalog: { id: string; name: string }[]
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (req.method === 'OPTIONS') return send(res, 204, {})
  const t0 = Date.now()
  try {
    if (url === '/api/shutdown' && req.method === 'POST') {
      // only from this machine: lets a newer copy of the API replace this one (see start())
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
      if (!local) return send(res, 403, { ok: false })
      send(res, 200, { ok: true })
      console.log('[shutdown] replaced by a newer copy')
      server.close()
      setTimeout(() => process.exit(0), 100)
      return
    }
    if (url === '/api/health') {
      return send(res, 200, { ok: true, app: 'financial-twin', pid: process.pid, llm: client ? { base_url: BASE_URL, model: MODEL, json_mode: JSON_MODE, reasoning: REASONING } : null })
    }
    if (url === '/api/schema') return send(res, 200, { parse: PARSE_JSON_SCHEMA, edit: EDIT_JSON_SCHEMA, chat: TURN_JSON_SCHEMA, explain: EXPLAIN_JSON_SCHEMA, answer: ANSWER_JSON_SCHEMA, compare: COMPARE_JSON_SCHEMA })
    if (url === '/api/compare' && req.method === 'POST') {
      const { facts } = await readJson(req)
      const user = `FACTS:\n${JSON.stringify(facts)}`
      const data = await callJson(CompareSchema, COMPARE_JSON_SCHEMA, 'compare', COMPARE_SYSTEM, user)
      console.log(`[compare] ${Date.now() - t0}ms`)
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system: COMPARE_SYSTEM, user, settings: callSettings('compare') }, ms: Date.now() - t0 })
    }
    if (url === '/api/parse' && req.method === 'POST') {
      const ctx = (await readJson(req)) as ParseContext
      const system = parseSystemPrompt(ctx)
      const data = await callJson(ParseSchema, PARSE_JSON_SCHEMA, 'scenario', system, ctx.text)
      console.log(`[parse] ${Date.now() - t0}ms "${ctx.text.slice(0, 60)}" -> ${data.scenarios.length} scenario(s)`)
      // `prompt` lets the UI show exactly what the AI was asked ("see the prompt")
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system, user: ctx.text, settings: callSettings('scenario') }, ms: Date.now() - t0 })
    }
    if (url === '/api/explain' && req.method === 'POST') {
      const { facts } = await readJson(req)
      const user = `FACTS:\n${JSON.stringify(facts)}`
      const data = await callJson(ExplainSchema, EXPLAIN_JSON_SCHEMA, 'explanation', EXPLAIN_SYSTEM, user)
      console.log(`[explain] ${Date.now() - t0}ms`)
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system: EXPLAIN_SYSTEM, user, settings: callSettings('explanation') }, ms: Date.now() - t0 })
    }
    if (url === '/api/chat' && req.method === 'POST') {
      const ctx = (await readJson(req)) as ChatContext
      const system = chatSystemPrompt(ctx)
      const messages = [...(ctx.history ?? []).slice(-12).map((m) => `${m.role === 'user' ? 'USER' : 'TWIN'}: ${m.text}`), `USER: ${ctx.text}`].join('\n')
      const userMsg = `HISTORY (oldest first; the last line is the new message):\n${messages}`
      const opts = { maxTokens: 12000, shorter: SHORTER, timeoutMs: Math.max(TIMEOUT_MS, 60000) }
      let data = await callJson(TurnSchema, TURN_JSON_SCHEMA, 'turn', system, userMsg, opts)
      // never "Done" without doing it: if the reply claims a change but the JSON has none, ask once more
      if (claimsAction(data.reply) && !hasAction(data)) {
        console.log(`[chat] reply claimed a change without any action -> asking again`)
        data = await callJson(TurnSchema, TURN_JSON_SCHEMA, 'turn', system, `${userMsg}\n\nIMPORTANT: your previous answer said it changed something ("${data.reply.slice(0, 160)}") but its JSON contained NO action. Either put the change in the JSON fields (edits / new_paths / profile_update / macro_update / ...), or, if you cannot do it, say plainly in reply that nothing was changed and why.`, opts)
      } else if (/\balready\b/i.test(data.reply) && !hasAction(data) && (ctx.paths ?? []).length) {
        // "it's already there": check it against PATHS before believing it
        const tgt = (ctx.paths as { id: string }[]).filter((p) => !ctx.target_path_id || p.id === ctx.target_path_id)
        console.log(`[chat] reply says "already" without any action -> double-checking against PATHS`)
        data = await callJson(TurnSchema, TURN_JSON_SCHEMA, 'turn', system, `${userMsg}\n\nIMPORTANT: your previous answer said something is ALREADY there ("${data.reply.slice(0, 160)}"). Check the events in PATHS: ${JSON.stringify(tgt)}. If what the user asks for is NOT in those events, it is NOT there: apply it now (edits / new_paths). Only if it truly is in the events, keep saying so.`, opts)
      }
      // branch mode is a promise: the original path stays as it is. If the AI edited it instead, turn that edit into a new branch.
      const fork = ctx.fork_from_path_id
      if (fork && data.new_paths.length === 0 && data.edits.some((e) => e.path_id === fork)) {
        const ed = data.edits.find((e) => e.path_id === fork)!
        const parentName = ((ctx.paths ?? []) as { id: string; name: string }[]).find((p) => p.id === fork)?.name ?? ''
        const name = ed.path && ed.path.name !== parentName ? ed.path.name : `+ ${(ed.changes[0] ?? 'branch').replace(/^added:?\s*/i, '')}`.slice(0, 40)
        data.new_paths = [{ name, catalog_id: ed.path?.catalog_id ?? null, events: ed.path ? ed.path.events : ed.add_events, parent_id: fork }]
        data.edits = data.edits.filter((e) => e.path_id !== fork)
        console.log(`[chat] branch mode: turned an edit of ${fork} into a new branch`)
      }
      console.log(`[chat] ${Date.now() - t0}ms "${ctx.text.slice(0, 50)}" -> new ${data.new_paths.length}, edits ${data.edits.length}, remove ${data.remove_path_ids.length}, update ${data.profile_update ? 1 : 0}`)
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system, user: messages, settings: callSettings('turn') }, ms: Date.now() - t0 })
    }
    if (url === '/api/edit' && req.method === 'POST') {
      const ctx = await readJson(req)
      const system = editSystemPrompt(ctx)
      const data = await callJson(EditSchema, EDIT_JSON_SCHEMA, 'edit', system, ctx.text)
      console.log(`[edit] ${Date.now() - t0}ms "${String(ctx.text).slice(0, 60)}" -> ${data.changes.length} change(s)`)
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system, user: ctx.text, settings: callSettings('edit') }, ms: Date.now() - t0 })
    }
    if (url === '/api/answer' && req.method === 'POST') {
      const { facts } = await readJson(req)
      const user = `QUESTION: ${facts?.question ?? ''}\nFACTS:\n${JSON.stringify(facts)}`
      const data = await callJson(AnswerSchema, ANSWER_JSON_SCHEMA, 'answer', ANSWER_SYSTEM, user)
      console.log(`[answer] ${Date.now() - t0}ms`)
      return send(res, 200, { ok: true, model: MODEL, data, prompt: { system: ANSWER_SYSTEM, user, settings: callSettings('answer') }, ms: Date.now() - t0 })
    }
    return send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const msg = e instanceof OpenAI.APIError ? `LLM API ${e.status ?? ''}: ${e.message}` : (e as Error).message
    console.error(`[error] ${url}: ${msg}`)
    return send(res, 200, { ok: false, error: msg }) // 200 on purpose: frontend switches to fallback
  }
})

// Start listening. If the port is taken by an OLDER copy of this API (e.g. one left running in another terminal),
// ask it to shut down and take over. If something else holds the port, explain clearly instead of crashing.
let tries = 0
function start() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Financial Twin API on http://localhost:${PORT}`)
    console.log(client ? `LLM: ${MODEL} @ ${BASE_URL} (json mode: ${JSON_MODE}, reasoning: ${REASONING})` : 'LLM: none (no LLM_API_KEY) -> frontend uses offline fallback')
  })
}
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE' || tries++ > 5) {
    console.error(`[startup] ${e.message}`)
    process.exit(1)
  }
  const old = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json()).catch(() => null)
  if (old?.app === 'financial-twin') {
    console.log(`[startup] an older Financial Twin API is running on port ${PORT}: asking it to stop and taking over…`)
    await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' }).catch(() => {})
    setTimeout(start, 700)
  } else {
    console.error(`[startup] port ${PORT} is used by another program (not the Financial Twin). Close it, or set PORT=8001 in backend/.env and the proxy target in frontend/vite.config.ts.`)
    process.exit(1)
  }
})
start()
