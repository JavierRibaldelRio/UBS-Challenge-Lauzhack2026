// The JSON contract between the LLM and the Financial Twin.
// The LLM only DESCRIBES the decision. It never computes money. Any number the user did not say
// stays null and the frontend fills it from the data (and labels where it came from).
import { z } from 'zod'

export const EVENT_TYPES = [
  'start_job', // start working (full time)
  'study', // go (back) to school: tuition, reduced income, then a job afterwards
  'relocate', // move to another city / abroad
  'income_change', // raise, part-time, job loss (-100), for a while or for good
  'household_change', // move in with partner, have a child, flat share...
  'recurring_expense', // new monthly cost (car, childcare, hobby)
  'one_off', // single cost (>0) or single money-in (<0), e.g. wedding, inheritance
  'invest', // monthly investing and/or a lump sum moved from cash into investments
  'market_shock', // investments drop by X%
  'take_loan', // borrow money (cash in now, repayments later)
  'buy_home', // buy a home: own money + mortgage, rent stops
] as const

export const HOUSEHOLDS = ['single', 'couple', 'family', 'shared_housing'] as const

const num = z.number().nullable()
const int = z.number().int().nullable()

export const EventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  label: z.string().describe('Short human label, e.g. "Master in Zurich"'),
  start_month: int.describe('Months after the simulation start (0 = now). null = 0'),
  duration_months: int.describe('How long it lasts. null = until the end (or the data default for study)'),
  monthly_net_income_chf: num.describe('New monthly NET income in CHF, ONLY if the user said it'),
  income_change_pct: num.describe('Income change in %, e.g. -40 for 60% part-time, -100 for job loss, +15 salary premium'),
  monthly_amount_chf: num.describe('Monthly amount in CHF (new rent for relocate, cost for recurring_expense, contribution for invest)'),
  amount_chf: num.describe('Single amount in CHF (one_off: >0 cost, <0 money received; moving cost; lump sum; loan principal; home price)'),
  annual_tuition_chf: num.describe('Tuition per year in CHF, study only'),
  city: z.string().nullable().describe('relocate only: a city from the list, or "abroad: <country>"'),
  household_type: z.enum(HOUSEHOLDS).nullable(),
  annual_rate_pct: num.describe('take_loan or buy_home (mortgage): yearly interest rate in %, ONLY if the user said it'),
  drop_pct: num.describe('market_shock only: % fall of investment value, e.g. 30'),
  down_payment_pct: num.describe('buy_home only: % of the price paid with own money, ONLY if the user said it'),
})

export const ScenarioSchema = z.object({
  name: z.string().describe('2-5 word name of this path'),
  catalog_id: z.string().nullable().describe('Closest scenario id from the catalog (S001..S120) or null'),
  events: z.array(EventSchema),
})

export const ParseSchema = z.object({
  scenarios: z.array(ScenarioSchema).describe('1-3 alternative paths the user wants to explore'),
  horizon_years: int.describe('Only if the user asks for a specific horizon'),
  unsupported: z.array(z.string()).describe('Parts of the request this model cannot represent'),
  note: z.string().nullable().describe('One short sentence to the user if something was unclear, else null'),
})

export const ExplainSchema = z.object({
  headline: z.string().describe('One sentence, max 15 words'),
  explanation: z.string().describe('Plain-English paragraph, 80-140 words'),
  caveat: z.string().describe('One sentence: the biggest assumption or limitation'),
})

export const AnswerSchema = z.object({
  short_answer: z.string().describe('1-2 sentences that directly answer the question, in this simulation'),
  reasoning: z.string().describe('2-4 short sentences: why, using only the facts'),
  confidence_level: z.enum(['high', 'medium', 'low']).describe('Exactly the confidence value given in the facts'),
  confidence_sentence: z.string().describe('One sentence that states the given confidence level and its main reason'),
})

export type ParseResult = z.infer<typeof ParseSchema>
export type AnswerResult = z.infer<typeof AnswerSchema>
export type ExplainResult = z.infer<typeof ExplainSchema>
