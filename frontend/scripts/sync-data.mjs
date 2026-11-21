// Copies the challenge CSVs into public/data so the app can fetch them at /data/*.csv.
// Runs automatically before `pnpm dev` and `pnpm build`. Cross-platform (no symlinks).
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '..', 'pre_docs', 'Data')
const dst = join(root, 'public', 'data')

mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith('.md') })
console.log(`[sync-data] ${src} -> ${dst}`)
