import Papa from 'papaparse'

// CSVs are copied from pre_docs/Data into public/data by scripts/sync-data.mjs
export async function loadCsv<T = Record<string, string | number>>(name: string): Promise<T[]> {
  const res = await fetch(`/data/${name}`)
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`)
  const text = await res.text()
  const parsed = Papa.parse<T>(text, { header: true, dynamicTyping: true, skipEmptyLines: true })
  return parsed.data
}

export type Profile = {
  profile_id: string
  display_name: string
  age_at_start: number
  city: string
  canton: string
  employment_status: string
  household_type: string
  opening_cash_chf: number
  reference_monthly_net_income_chf: number
  reference_monthly_rent_chf: number
}
