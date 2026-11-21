// Calls to the backend (/api is proxied by Vite to :8000). Never throws: on any failure it returns
// {ok:false} and the caller uses the offline fallback. Successful answers are cached in localStorage
// so a demo question that worked once keeps working even if the network dies.
import type { ExplainResult, ParseResult } from './types'

type Ok<T> = { ok: true; data: T; model: string; cached?: boolean }
type Fail = { ok: false; error: string }

const CACHE_PREFIX = 'twin-cache-v1:'
const cacheGet = <T,>(key: string): T | null => {
  try {
    const v = localStorage.getItem(CACHE_PREFIX + key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}
const cacheSet = (key: string, v: unknown) => {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(v))
  } catch {
    /* storage full / blocked: ignore */
  }
}
const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<Ok<T> | Fail> {
  const key = hash(path + JSON.stringify(body))
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
    clearTimeout(timer)
    const json = (await res.json()) as Ok<T> | Fail
    if (json.ok) cacheSet(key, json)
    else {
      const c = cacheGet<Ok<T>>(key)
      if (c) return { ...c, cached: true }
    }
    return json
  } catch (e) {
    const c = cacheGet<Ok<T>>(key)
    if (c) return { ...c, cached: true }
    return { ok: false, error: (e as Error).name === 'AbortError' ? 'LLM timed out' : 'Backend not reachable' }
  }
}

export const apiParse = (ctx: unknown) => post<ParseResult>('/api/parse', ctx, 30000)
export const apiExplain = (facts: unknown) => post<ExplainResult>('/api/explain', { facts }, 30000)

export async function apiHealth(): Promise<{ ok: boolean; llm: { model: string; base_url: string } | null }> {
  try {
    const res = await fetch('/api/health')
    return await res.json()
  } catch {
    return { ok: false, llm: null }
  }
}
