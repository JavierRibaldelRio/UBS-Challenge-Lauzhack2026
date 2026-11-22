// Seeded, reproducible randomness. Same seed -> same paths, on every machine.

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normal(rand: () => number) {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Inverse-CDF sample from an empirical quantile table (linear interpolation). */
export function fromQuantiles(q: number[], u: number) {
  const x = u * (q.length - 1)
  const i = Math.floor(x)
  const f = x - i
  return q[i] * (1 - f) + q[Math.min(i + 1, q.length - 1)] * f
}

/** Standard normal quantile Φ⁻¹(u) (Acklam's rational approximation, |error| < 1.2e-9): one uniform -> one normal. */
export function invNorm(u: number) {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, u))
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const tail = (q: number) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** One of n equally likely values (R's bonus sizes: "sample uniformly from these to draw a bonus size"). */
export const pickUniform = (values: number[], u: number) => values[Math.min(values.length - 1, Math.floor(u * values.length))]

export function quantile(sorted: Float64Array | number[], p: number) {
  const x = p * (sorted.length - 1)
  const i = Math.floor(x)
  const f = x - i
  return sorted[i] * (1 - f) + sorted[Math.min(i + 1, sorted.length - 1)] * f
}
