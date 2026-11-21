// One command to run the whole demo:
//   node demo.mjs          development (auto-reload)        http://localhost:5173/?demo
//   node demo.mjs --prod   built once, served statically     http://localhost:4173/?demo  (~120 MB RAM instead of ~700 MB)
// Starts the AI gateway (backend, :8000) and the web app. Ctrl+C stops both.
// Before starting, it frees the ports if an OLD copy of the demo (a Node process) still holds them,
// so you never get "EADDRINUSE: address already in use". It never touches non-Node programs.
// No dependencies; works on Linux, macOS and Windows.
import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const prod = process.argv.includes('--prod')
const WEB_PORT = prod ? 4173 : 5173
const API_PORT = 8000
const win = process.platform === 'win32'
const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch {
    return ''
  }
}

/** PIDs listening on a TCP port. */
function pidsOn(port) {
  if (win) {
    return [...new Set(sh('netstat -ano -p tcp').split('\n').filter((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l)).map((l) => l.trim().split(/\s+/).pop()))].filter(Boolean)
  }
  const viaLsof = sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split(/\s+/).filter(Boolean)
  if (viaLsof.length) return viaLsof
  return [...sh(`ss -ltnpH sport = :${port}`).matchAll(/pid=(\d+)/g)].map((m) => m[1])
}
const isNode = (pid) => /node/i.test(win ? sh(`tasklist /FI "PID eq ${pid}" /NH`) : sh(`ps -o comm= -p ${pid}`))

function freePort(port, name) {
  for (const pid of pidsOn(port)) {
    if (String(pid) === String(process.pid)) continue
    if (!isNode(pid)) {
      console.error(`\n  Port ${port} (${name}) is used by another program (PID ${pid}), not by an old demo. Close it and try again.\n`)
      process.exit(1)
    }
    console.log(`  freeing port ${port}: stopping an old ${name} (PID ${pid})`)
    try {
      win ? sh(`taskkill /F /PID ${pid}`) : process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
}

freePort(API_PORT, 'backend')
freePort(WEB_PORT, 'frontend')
await new Promise((r) => setTimeout(r, 600)) // let the OS release the ports

const procs = []
function run(name, cwd, cmd, args, color) {
  if (!existsSync(`${cwd}/node_modules`)) {
    console.error(`\n[${name}] missing node_modules -> run: cd ${cwd} && pnpm install\n`)
    process.exit(1)
  }
  const p = spawn(cmd, args, { cwd, shell: win, env: process.env })
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (s) => s.on('data', (d) => process.stdout.write(d.toString().replace(/^(?=.)/gm, tag)))
  pipe(p.stdout)
  pipe(p.stderr)
  p.on('exit', (code) => console.log(`${tag}exited (${code})`))
  procs.push(p)
}

run('backend ', 'backend', 'node', ['--env-file-if-exists=.env', 'server.ts'], 35)
if (prod) {
  execSync('pnpm build', { cwd: 'frontend', stdio: 'inherit', shell: true })
  run('frontend', 'frontend', 'pnpm', ['preview'], 36)
} else run('frontend', 'frontend', 'pnpm', ['dev'], 36)
console.log(`\n  Demo: http://localhost:${WEB_PORT}/?demo   (Ctrl+C to stop)\n`)

const stop = () => {
  for (const p of procs) p.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
