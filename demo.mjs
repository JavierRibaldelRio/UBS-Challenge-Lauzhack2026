// One command to run the whole demo:  node demo.mjs
// Starts the LLM gateway (backend, :8000) and the web app (frontend, :5173). Ctrl+C stops both.
// No dependencies; works on Linux, macOS and Windows.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const procs = []
function run(name, cwd, cmd, args, color) {
  if (!existsSync(`${cwd}/node_modules`)) {
    console.error(`\n[${name}] missing node_modules -> run: cd ${cwd} && pnpm install\n`)
    process.exit(1)
  }
  const p = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: process.env })
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (s) => s.on('data', (d) => process.stdout.write(d.toString().replace(/^(?=.)/gm, tag)))
  pipe(p.stdout)
  pipe(p.stderr)
  p.on('exit', (code) => console.log(`${tag}exited (${code})`))
  procs.push(p)
}

run('backend ', 'backend', 'node', ['--env-file-if-exists=.env', 'server.ts'], 35)
run('frontend', 'frontend', 'pnpm', ['dev'], 36)
console.log('\n  Demo: http://localhost:5173/?demo   (Ctrl+C to stop)\n')

const stop = () => {
  for (const p of procs) p.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
