// Tiny LLM gateway for the Financial Twin. Two jobs, nothing else:
//   POST /api/parse    free text  -> scenario JSON (validated against schema.ts)
//   POST /api/explain  computed facts -> plain-English paragraph
// Works with ANY OpenAI-compatible endpoint (Together AI, OpenAI, Ollama, vLLM, LM Studio...).
// If the LLM is down or returns garbage, we answer {ok:false} and the frontend uses its offline fallback.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { z } from 'zod'
import { AnswerSchema, ExplainSchema, ParseSchema } from './schema.ts'

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
- If a path buys a home and chance_not_enough_cash_for_down_payment_pct is above 0, say that the own money for the down payment is missing in that share of futures. That makes the purchase unaffordable there, whatever the final net worth.
- Money that ends higher is not automatically the better life choice: if the paths differ in risk of running out of cash, say so.
- The person and data are fictional.
Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(ANSWER_JSON_SCHEMA)}`

// ------------------------------------------------------------------ prompts
function parseSystemPrompt(ctx: ParseContext) {
  return `You translate a person's "what if" question into scenario JSON for a financial simulator.
You DESCRIBE decisions. You NEVER invent money amounts.

RULES
- Use only these event types: start_job, study, relocate, income_change, household_change, recurring_expense, one_off, invest, market_shock, take_loan, buy_home.
- Any number the user did not state -> null. The simulator fills it from data and shows the source. Do not guess salaries, rents, tuition or costs.
- Timing: months after the start (month 0 = ${ctx.start_date}, when ${ctx.name} is ${ctx.age}). "at 25" -> (25-${ctx.age})*12. "next year" -> 12. "now" -> 0.
- If the user compares options ("A or B"), return one scenario per option (max 3). Do not add a "do nothing" scenario; the app already has one.
- Combine events in one scenario when they happen together (e.g. study abroad = relocate + study).
- study: after it ends the person starts a job automatically. A salary premium the degree brings ("salary 15% higher afterwards") goes in the study event's income_change_pct. NEVER add a separate income_change for it.
- income_change: part-time 60% -> -40. Job loss -> -100 with duration_months. Job loss WITH benefits or partial pay ("70% unemployment benefits", "keep 80% of my salary") -> the remaining share: 70% -> -30, 80% -> -20.
- one_off: positive amount_chf = a cost, negative = money received.
- buy_home: amount_chf = the home price; down_payment_pct and annual_rate_pct (mortgage) only if stated. Do NOT also add a one_off or take_loan for the same purchase.
- Several things in ONE life (e.g. "do a master's now, lose my job at 27 and buy a flat at 30") = ONE scenario with several events, in any order.
- "k" means thousand (25k = 25000), "m"/"million" = 1000000.
- Amounts in another currency (EUR, GBP, USD...): do NOT convert. Leave the CHF field null and list it in "unsupported".
- Write "name" and "label" in the SAME language the user wrote the question in. An English question gets English labels (default: English).
- relocate.city must be one of: ${ctx.cities.join(', ')}; otherwise "abroad: <country>".
- Put anything you cannot represent (taxes, specific stocks, career probabilities...) in "unsupported".
- catalog_id: closest id from the catalog below, or null.

PERSON (fictional): ${JSON.stringify(ctx.profile)}

CATALOG (id: name):
${ctx.catalog.map((c) => `${c.id}: ${c.name}`).join('\n')}

Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(PARSE_JSON_SCHEMA)}`
}

const EXPLAIN_SYSTEM = `You explain financial simulation results to a non-expert, in plain, simple English (short sentences, no jargon).
STRICT RULES
- Use ONLY numbers that appear in the FACTS JSON. Do not calculate new numbers, do not round differently than "k" style (e.g. 254300 -> CHF 254k is fine).
- Explain WHAT the chart shows (compare the paths to the baseline) and WHY (use "drivers" and the assumptions).
- Say "in this simulation" / "under these assumptions". Never promise outcomes. Never give advice like "you should".
- Mention the risk of running out of cash if it is above 0%.
- If a break-even value is given, explain it in one sentence.
- If a path buys a home: say that cash drops by the down payment while net worth does not. If chance_not_enough_cash_for_down_payment_pct is above 0, say clearly that the own money for the down payment is missing in that share of futures (a bank would not lend).
- The person and data are fictional.
Reply with JSON only (no prose, no code fences), matching this JSON Schema:
${JSON.stringify(EXPLAIN_JSON_SCHEMA)}`

// ------------------------------------------------------------------ LLM call with validation + one repair retry
async function callJson<T>(schema: z.ZodType<T>, jsonSchema: object, name: string, system: string, user: string): Promise<T> {
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
    const body = { model: MODEL, messages, temperature: 0, max_tokens: 4000, response_format, ...(REASONING === 'default' ? {} : { reasoning: { enabled: REASONING === 'on' } }) }
    // `reasoning` is a Together extension the OpenAI SDK types don't know; the SDK forwards it as-is.
    const res = await client.chat.completions.create(body as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming)
    if (res.choices[0]?.finish_reason === 'length') throw new Error('LLM output truncated (max_tokens)')
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
    if (url === '/api/health') {
      return send(res, 200, { ok: true, llm: client ? { base_url: BASE_URL, model: MODEL, json_mode: JSON_MODE, reasoning: REASONING } : null })
    }
    if (url === '/api/schema') return send(res, 200, { parse: PARSE_JSON_SCHEMA, explain: EXPLAIN_JSON_SCHEMA, answer: ANSWER_JSON_SCHEMA })
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Financial Twin API on http://localhost:${PORT}`)
  console.log(client ? `LLM: ${MODEL} @ ${BASE_URL} (json mode: ${JSON_MODE}, reasoning: ${REASONING})` : 'LLM: none (no LLM_API_KEY) -> frontend uses offline fallback')
})
