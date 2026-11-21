export const chf = (n: number) => `CHF ${Math.round(n).toLocaleString('de-CH')}`
export const chfk = (n: number) => {
  const a = Math.abs(n)
  if (a >= 1e6) return `CHF ${(n / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `CHF ${Math.round(n / 1000)}k`
  return chf(n)
}
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
export const ageAt = (age0: number, month: number) => age0 + month / 12
export const monthLabel = (asOf: string, month: number) => {
  const [y, m] = asOf.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + month, 1))
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
/** month index (0 = as_of month) of the END of a YYYY-MM-DD date's month */
export const monthIndex = (asOf: string, date: string) => {
  const [y0, m0] = asOf.split('-').map(Number)
  const [y, m] = date.split('-').map(Number)
  return (y - y0) * 12 + (m - m0)
}
