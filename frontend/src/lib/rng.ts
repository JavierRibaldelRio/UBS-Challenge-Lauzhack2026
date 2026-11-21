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

export function quantile(sorted: Float64Array | number[], p: number) {
  const x = p * (sorted.length - 1)
  const i = Math.floor(x)
  const f = x - i
  return sorted[i] * (1 - f) + sorted[Math.min(i + 1, sorted.length - 1)] * f
}
