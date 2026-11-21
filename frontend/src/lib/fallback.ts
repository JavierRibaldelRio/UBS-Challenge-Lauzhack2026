// Offline parser: keyword rules that turn a question into scenario JSON when the LLM is unavailable.
// Deliberately simple and predictable. Same output contract as the LLM.
import { makeEvent } from './resolve'
import type { ParseResult, Profile, ScenarioSpec, TwinEvent } from './types'

export function offlineParse(text: string, profile: Profile, cities: string[]): ParseResult {
  const t = text.toLowerCase()
  const ageM = t.match(/\bat (?:age )?(\d{2})\b/)
  const start = ageM ? Math.max(0, (Number(ageM[1]) - profile.age) * 12) : t.includes('next year') ? 12 : 0
  const money = (re: RegExp) => {
    const m = t.match(re)
    if (!m) return null
    return Number(m[1].replace(/[’',]/g, '')) * (m[2] === 'k' ? 1000 : 1)
  }

  const parts = t.split(/\bor\b|\bvs\.?\b|\bversus\b|,/).map((s) => s.trim()).filter(Boolean)
  const scenarios: ScenarioSpec[] = []
  for (const part of parts.length > 1 ? parts : [t]) {
    const ev: TwinEvent[] = []
    const city = cities.find((c) => part.includes(c.toLowerCase()))
    if (/master|degree|study|studies|university|phd|school/.test(part)) {
      const tuition = money(/tuition (?:of )?(?:chf )?(\d[\d',]*)(k?)/)
      ev.push(makeEvent({ type: 'study', label: "Master's", start_month: start, annual_tuition_chf: tuition }))
    }
    if (/abroad|london|paris|berlin|usa|germany|france|uk\b|spain|italy/.test(part)) {
      ev.push(makeEvent({ type: 'relocate', label: 'Move abroad', start_month: start, city: 'abroad' }))
    } else if (city && /move|relocat|live/.test(part)) {
      ev.push(makeEvent({ type: 'relocate', label: `Move to ${city}`, start_month: start, city }))
    }
    if (/\b(work|job|employ)/.test(part) && !/lose|lost|without/.test(part) && !ev.some((e) => e.type === 'study')) {
      const sal = money(/(?:salary|earn|earning|income) (?:of )?(?:chf )?(\d[\d',]*)(k?)/)
      ev.push(makeEvent({ type: 'start_job', label: 'Start working', start_month: start, monthly_net_income_chf: sal }))
    }
    if (/lose|lost|laid off|unemploy|job loss/.test(part)) {
      const dur = part.match(/(\d+)\s*month/)
      ev.push(makeEvent({ type: 'income_change', label: 'Job loss', start_month: start, income_change_pct: -100, duration_months: dur ? Number(dur[1]) : 6 }))
    }
    const pt = part.match(/part[- ]time(?: at)? (\d{2})\s*%|(\d{2})\s*%\s*part[- ]time/)
    if (pt) ev.push(makeEvent({ type: 'income_change', label: 'Part-time', start_month: start, income_change_pct: Number(pt[1] ?? pt[2]) - 100 }))
    if (/child|baby|kid/.test(part)) ev.push(makeEvent({ type: 'household_change', label: 'Have a child', start_month: start, household_type: 'family' }))
    if (/partner|move in together|married|wedding/.test(part)) ev.push(makeEvent({ type: 'household_change', label: 'Move in with partner', start_month: start, household_type: 'couple' }))
    if (/\bbuy\b.*\b(house|flat|apartment|home|property)\b/.test(part)) {
      const price = money(/(?:for|price|costing|worth) (?:chf )?(\d[\d',]*)(k?)/)
      ev.push(makeEvent({ type: 'buy_home', label: 'Buy a home', start_month: start, amount_chf: price }))
    }
    if (/crash|recession|market drop/.test(part)) ev.push(makeEvent({ type: 'market_shock', label: 'Market crash', start_month: start, drop_pct: 30 }))
    const inv = money(/invest (?:chf )?(\d[\d',]*)(k?)/)
    if (inv != null) ev.push(makeEvent({ type: 'invest', label: 'Invest', start_month: start, monthly_amount_chf: inv }))
    if (ev.length) scenarios.push({ name: ev.map((e) => e.label).join(' + ').slice(0, 40), catalog_id: null, events: ev })
  }
  return {
    scenarios: scenarios.slice(0, 3),
    horizon_years: null,
    unsupported: [],
    note: scenarios.length ? 'Offline mode: understood with simple keyword rules.' : 'Offline mode could not understand this. Try the quick buttons or words like "master", "work", "move to Zurich", "abroad", "child", "lose my job".',
  }
}
