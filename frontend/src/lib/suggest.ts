// Example questions that make sense for THIS person (age, job, household, money, goals).
// Rule-based on purpose: instant, always the same, never suggests "start working at 22" to a 70-year-old.
import { cities, incomeAnchor } from './resolve'
import type { Params, Profile } from './types'

const round = (x: number, step: number) => Math.max(step, Math.round(x / step) * step)
const fmtK = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1000)}k`)

export function suggestQuestions(p: Profile, params: Params): string[] {
  const a = p.age
  const out: string[] = []
  const other = cities(params).find((c) => c !== p.city && c !== 'Zurich') ?? 'Geneva'
  const big = p.city === 'Zurich' ? 'Geneva' : 'Zurich'
  const yearlyNet = p.income * 12
  const flat = round(Math.max(300000, yearlyNet * 6), 50000)
  const goal = p.goals[0]
  const goalYear = goal ? Number(goal.date.slice(0, 4)) : null

  if (p.status === 'student' && a < 35) {
    const salary = round(incomeAnchor(params, 'employed', a + 2).value * 0.75, 500)
    out.push(`Master's in ${big}, or start working at ${a + 2} for ${salary.toLocaleString('en')} a month?`)
    out.push(`Work now, lose my job for 6 months at ${a + 5}, then buy a flat for ${fmtK(flat)} at ${a + 8}`)
  } else if (p.status === 'retired' || a >= 65) {
    if (p.investments > 0) out.push(`What if markets fall 30% next year?`)
    out.push(`What if I move to ${other} and pay a ${round(p.cash * 0.1, 1000).toLocaleString('en')} moving cost?`)
    out.push(`What if I pay a 25,000 medical bill at ${a + 2}?`)
  } else if (p.status === 'unemployed') {
    out.push(`What if I find a job in 6 months, or only in 2 years?`)
    out.push(`What if I move to ${other} to find work?`)
  } else {
    // employed, self-employed, part-time
    if (a < 55) out.push(`What if I work 80% from next year, or buy a flat for ${fmtK(flat)} at ${a + 3}?`)
    if (a < 42 && p.household !== 'family') out.push(`What if I have a child at ${a + 2}?`)
    if (p.status === 'self_employed') out.push(`What if my income falls 30% for 2 years?`)
    else out.push(`What if I lose my job for 6 months next year?`)
    if (a >= 55) out.push(`What if I retire at ${Math.max(a + 1, 63)}?`.replace('retire', 'stop working'))
  }
  if (goal && goalYear && goalYear > Number(p.as_of.slice(0, 4))) {
    const months = Math.max(12, (goalYear - Number(p.as_of.slice(0, 4))) * 12)
    const missing = goal.target - p.cash - p.investments // what is not yet covered by today's savings
    if (missing > 0) {
      const monthly = round(missing / months, 50)
      out.push(`Can I reach my ${goal.name.toLowerCase()} goal by ${goalYear} if I invest ${monthly.toLocaleString('en')} a month?`)
    } else {
      out.push(`Do I still reach my ${goal.name.toLowerCase()} goal by ${goalYear} if ${p.investments > 0 ? 'markets fall 30% next year' : 'I pay a 20,000 surprise bill next year'}?`)
    }
  }
  return out.slice(0, 3)
}
