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
  'buy_asset', // buy something you keep that is not a home (car, motorbike, boat, equipment): an asset that loses value
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
  amount_chf: num.describe('Single amount in CHF (one_off: >0 cost, <0 money received; moving cost; invest: lump sum, NEGATIVE = sell / withdraw; loan principal; home price)'),
  annual_tuition_chf: num.describe('Tuition per year in CHF, study only'),
  city: z.string().nullable().describe('relocate only: a city from the list, or "abroad: <country>"'),
  household_type: z.enum(HOUSEHOLDS).nullable(),
  annual_rate_pct: num.describe('take_loan or buy_home (mortgage): yearly interest rate in %, ONLY if the user said it'),
  drop_pct: num.describe('market_shock only: % fall of investment value, e.g. 30'),
  down_payment_pct: num.describe('buy_home / buy_asset: % of the price paid with own money (rest = loan), ONLY if the user said it'),
  depreciation_pct: num.describe('buy_asset: % of value lost per year, ONLY if the user said it'),
  repeat_every_months: int.describe('income_change only: repeat the % change every N months, compounding (a yearly raise = 12; with duration_months = how long the raises keep coming). null = once'),
})

export const ScenarioSchema = z.object({
  name: z.string().describe('2-5 word name of this path'),
  catalog_id: z.string().nullable().describe('Closest scenario id from the catalog (S001..S120) or null'),
  events: z.array(EventSchema),
})

/** New facts about the person's situation TODAY (not future decisions): the twin updates itself with them. */
export const ProfileUpdateSchema = z.object({
  monthly_net_income_chf: num.describe('Current monthly net income, if the user says it changed'),
  monthly_rent_chf: num.describe('Current monthly rent, if the user says it changed'),
  cash_chf: num.describe('Current savings / cash, if the user says it'),
  investments_chf: num.describe('Current investments, if the user says it'),
  monthly_spending_chf: num.describe('Usual monthly spending WITHOUT rent, if the user says it'),
  home_value_chf: num.describe('Value of a home/flat they ALREADY OWN today (gifted, inherited, bought before). Not a purchase. null if not said'),
  min_cash_chf: num.describe('The least cash they want to keep at all times ("never below 20k"): a safety floor. null if not said'),
  summary: z.string().describe('One short sentence: what changed'),
})

export const ParseSchema = z.object({
  profile_update: ProfileUpdateSchema.nullable().describe('Facts about TODAY the user told you ("I now earn 1,500", "I have 15k saved"). null if none.'),
  scenarios: z.array(ScenarioSchema).describe('1-3 alternative paths the user wants to explore (can be empty if the user only updated facts about today)'),
  horizon_years: int.describe('Only if the user asks for a specific horizon'),
  unsupported: z.array(z.string()).describe('Parts of the request this model cannot represent'),
  note: z.string().nullable().describe('One short sentence to the user if something was unclear, else null'),
})

/** Follow-up on ONE existing path: the full updated path + what changed. */
export const EditSchema = z.object({
  path: ScenarioSchema.describe('The COMPLETE updated path: all events, changed and unchanged'),
  changes: z.array(z.string()).describe('Short plain-English list of what you changed, e.g. "flat price 600k -> 500k"'),
  unsupported: z.array(z.string()),
  note: z.string().nullable(),
})

/** The ECONOMY (macroeconomic variables, shared by every path). Null = keep as is. */
export const MacroUpdateSchema = z.object({
  preset: z.enum(['base', 'uncertain', 'inflation', 'rates', 'recession', 'housing', 'crisis']).nullable().describe('A ready-made economy, or null'),
  inflation_pct: num, wage_growth_pct: num, rate_shift_pct: num, market_return_pct: num, market_vol_pct: num,
  recession_start_month: int, recession_months: int, recession_income_drop_pct: num,
  crash_month: int, crash_drop_pct: num, housing_drop_month: int, housing_drop_pct: num, recession_risk_per_year_pct: num,
})

/** One turn of the conversation with the twin: it can talk AND act (update today's facts, add / edit / remove paths). */
export const TurnSchema = z.object({
  reply: z.string().describe("What the twin says back, in the user's language. Natural, short (1-4 sentences). Answers questions directly using STATE / PATHS numbers."),
  profile_update: ProfileUpdateSchema.nullable().describe('Facts about TODAY the user stated or corrected. null if none.'),
  new_paths: z
    .array(
      ScenarioSchema.extend({
        parent_id: z.string().nullable().describe('If this path CONTINUES an existing path (a branch): that path id. Then events = ONLY the new events; the app copies the parent\'s events. null = a path from today.'),
      }),
    )
    .describe('New paths to add (0-10). Empty if the user is editing, asking or chatting.'),
  edits: z
    .array(
      z.object({
        path_id: z.string().describe('id of the existing path to change (from PATHS)'),
        path: ScenarioSchema.nullable().describe('The COMPLETE updated path, ONLY when existing events change or are removed. null when you only ADD events (use add_events).'),
        add_events: z.array(EventSchema).describe('Events to append to this path, everything else unchanged (short form for "add X"). Empty when path is given.'),
        changes: z.array(z.string()).describe('Plain-English list of what changed, e.g. "child: from now -> at 35"'),
      }),
    )
    .describe('Changes to EXISTING paths, one entry per path ("instead", "that path", "add X to all paths" -> one entry for EVERY path id). Empty if not editing.'),
  remove_path_ids: z.array(z.string()).describe('ids of paths to delete (user says delete / that was wrong / I did not mean that)'),
  undo_path_ids: z.array(z.string()).describe('ids of EXISTING paths whose last change must be reverted (the user says a change you made to them was wrong / unwanted / they did not want it changed)'),
  new_goals: z
    .array(z.object({ name: z.string().describe('short goal name, e.g. "Car fund"'), target_chf: z.number(), by_month: z.number().int().describe('months after the start date') }))
    .describe('Savings goals the user wants to add ("I want 50k saved by 30", "add a goal: emergency fund of 10k by 2027"). Empty otherwise.'),
  remove_goals: z.array(z.string()).describe('names of goals to delete (exact names from STATE.goals). Empty otherwise.'),
  macro_update: MacroUpdateSchema.nullable().describe('ECONOMY-WIDE conditions (inflation, interest rates, recession, market crash, house prices). Applies to EVERY path. null if not mentioned.'),
  horizon_years: int.describe('Only if the user asks for a specific horizon, or needs one to see their ages (e.g. "until 40")'),
  unsupported: z.array(z.string()).describe('Things the user wants that this model cannot represent (not: values you filled in)'),
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

/** The A/B view: a short story per selected path ("so far" + "ahead") and a personal comparison. */
const StorySchema = z.object({
  so_far: z.string().describe('1-3 sentences: where you stand today (real history from the data) and what this path changes'),
  ahead: z.string().describe('2-4 sentences: what tends to happen on this path in the simulation'),
})
export const CompareSchema = z.object({
  first: StorySchema.describe('Story of FACTS.paths[0]'),
  second: StorySchema.nullable().describe('Story of FACTS.paths[1], or null if there is only one path'),
  comparison: z.string().describe('Only if there are two paths (else ""): 4-7 sentences comparing them for this person'),
  caveat: z.string().describe('One sentence: the biggest assumption or unknown'),
})

export type ParseResult = z.infer<typeof ParseSchema>
export type EditResult = z.infer<typeof EditSchema>
export type TurnResult = z.infer<typeof TurnSchema>
export type AnswerResult = z.infer<typeof AnswerSchema>
export type ExplainResult = z.infer<typeof ExplainSchema>
export type CompareResult = z.infer<typeof CompareSchema>
