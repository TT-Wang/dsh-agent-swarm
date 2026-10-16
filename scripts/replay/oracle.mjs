#!/usr/bin/env node
/**
 * The full-log oracle (`node scripts/replay/oracle.mjs`): the proof that a
 * refactor of the runtime changes no behaviour.
 *
 * Each scenario runs in a child process in oracle mode (`SWARM_ORACLE`,
 * tests/faults/harness.mjs): a FakeClock at a fixed epoch with `manualTick`,
 * counter ids, and a recording adapter. Every runtime the scenario builds
 * leaves its normalized full log (tests/faults/oracle.mjs): every event, every
 * row of every table (the deliveries ledger included) and the adapter call
 * trace with each `isIdle`/`currentActivity` answer in order. The logs must
 * equal the committed ones under scripts/replay/oracle/, line for line; a
 * difference means the change is wrong, not that the log needs re-recording.
 * A slice meant to change behaviour states its log difference exactly and
 * re-records with `--write`.
 *
 * Scenarios: the replay scenario (scripts/replay/scenario.mjs) and the clocked
 * variants of the fault scenarios the runtime slices cite: F2, F5, F12, F13,
 * F18 and F19 run unchanged on the oracle clock; F21 has its own clocked
 * variant (scripts/replay/f21-clocked.mjs), because its wedge ends at a real
 * timer; `paths` (scripts/replay/paths-clocked.mjs) reaches what none of them
 * does: stop fences, an isolation violation, the silence bounds, completion,
 * and preferred work whose readings show the interpretation's ask order.
 *
 * Usage: node scripts/replay/oracle.mjs [--only replay,F19] [--runs n] [--stress] [--write] [--out dir]
 *   --runs n   run the whole set n times; every run must produce the same logs
 *   --stress   run the copies two at a time beside a busy loop (CPU contention)
 *   --write    record the logs (only when every run agreed)
 *   --out dir  where a differing run's logs are written for inspection
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
const GOLDEN = join(PROJECT, 'scripts/replay/oracle')
const SCENARIOS = [
  { id: 'replay', script: 'scripts/replay/oracle.mjs', args: ['--child-replay'] },
  { id: 'F2', script: 'tests/faults/f02-lease-expiry.mjs' },
  { id: 'F5', script: 'tests/faults/f05-duplicate-replacement.mjs' },
  { id: 'F12', script: 'tests/faults/f12-terminal-immutability.mjs' },
  { id: 'F13', script: 'tests/faults/f13-worker-closeout.mjs' },
  { id: 'F18', script: 'tests/faults/f18-start-failure.mjs' },
  { id: 'F19', script: 'tests/faults/f19-no-silent-state.mjs' },
  { id: 'F21', script: 'scripts/replay/f21-clocked.mjs' },
  { id: 'paths', script: 'scripts/replay/paths-clocked.mjs' },
]

const args = process.argv.slice(2)
const value = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }

/** One log as lines, one event, row or adapter call per line, so a difference names its entry. */
function render(logs) {
  const lines = []
  logs.forEach((log, index) => {
    lines.push(`# runtime ${index + 1}`)
    log.events.forEach((event, at) => lines.push(`event ${at} ${JSON.stringify(event)}`))
    for (const [table, rows] of Object.entries(log.tables)) rows.forEach((row, at) => lines.push(`${table} ${at} ${JSON.stringify(row)}`))
    log.trace.forEach((call, at) => lines.push(`trace ${at} ${JSON.stringify(call)}`))
  })
  return `${lines.join('\n')}\n`
}

/** Run one scenario in oracle mode; resolves to its rendered logs. */
async function runOne(scenario, scratch) {
  const file = join(scratch, `${scenario.id}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.ndjson`)
  const { error, stdout, stderr } = await new Promise(resolve => execFile(process.execPath, [join(PROJECT, scenario.script), ...(scenario.args ?? [])],
    { cwd: PROJECT, env: { ...process.env, SWARM_ORACLE: file }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) })))
  if (error || !stdout.includes('FAULT_OK ')) throw new Error(`oracle scenario ${scenario.id} failed: ${(stderr || stdout || String(error)).trim().slice(-2000)}`)
  const logs = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  await rm(file, { force: true })
  return render(logs)
}

/** Run the selected set once; resolves to { id: text }. */
async function runSet(selected, scratch) {
  const result = {}
  for (const scenario of selected) result[scenario.id] = await runOne(scenario, scratch)
  return result
}

/** The first differing lines of two renderings. */
function difference(expected, actual, limit = 6) {
  const left = expected.split('\n'), right = actual.split('\n'), out = []
  for (let index = 0; index < Math.max(left.length, right.length) && out.length < limit * 2; index++) {
    if (left[index] === right[index]) continue
    out.push(`  line ${index + 1} expected: ${(left[index] ?? '<end>').slice(0, 400)}`, `  line ${index + 1} actual:   ${(right[index] ?? '<end>').slice(0, 400)}`)
  }
  return out.join('\n')
}

async function childReplay() {
  // The harness import (through scenario.mjs) installs the oracle's counter ids.
  const { appendFileSync } = await import('node:fs')
  const { runScenario } = await import('./scenario.mjs')
  const scenario = await runScenario()
  appendFileSync(process.env.SWARM_ORACLE, `${JSON.stringify(scenario.log)}\n`)
  if (scenario.ownsRoot) await rm(scenario.root, { recursive: true, force: true })
  process.stdout.write(`FAULT_OK {"id":"replay"}\n`)
}

async function main() {
  const only = (value('--only') ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const unknown = only.filter(id => !SCENARIOS.some(scenario => scenario.id === id))
  if (unknown.length) throw new Error(`unknown oracle scenario(s): ${unknown.join(', ')}`)
  const selected = SCENARIOS.filter(scenario => !only.length || only.includes(scenario.id))
  const runs = Math.max(1, Number(value('--runs') ?? 1))
  const stress = args.includes('--stress')
  const write = args.includes('--write')
  const scratch = await mkdtemp(join(tmpdir(), 'swarm-oracle-'))
  const busy = stress ? spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }) : undefined
  try {
    const results = []
    for (let started = 0; started < runs; started += stress ? 2 : 1) {
      const batch = stress && started + 1 < runs ? [runSet(selected, scratch), runSet(selected, scratch)] : [runSet(selected, scratch)]
      results.push(...await Promise.all(batch))
    }
    const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`
    let failed = false
    for (const scenario of selected) {
      const texts = results.map(result => result[scenario.id])
      const distinct = [...new Set(texts)]
      if (distinct.length > 1) {
        failed = true
        process.stdout.write(`NONDETERMINISTIC ${scenario.id}: ${distinct.length} distinct logs over ${runs} runs\n${difference(distinct[0], distinct[1])}\n`)
        continue
      }
      const [text] = distinct
      const path = join(GOLDEN, `${scenario.id}.log`)
      if (write) {
        await mkdir(GOLDEN, { recursive: true })
        await writeFile(path, text)
        process.stdout.write(`wrote ${scenario.id} ${digest(text)} (${text.split('\n').length - 1} lines, ${runs} identical run(s))\n`)
        continue
      }
      const golden = await readFile(path, 'utf8').catch(() => undefined)
      if (golden === text) { process.stdout.write(`same ${scenario.id} ${digest(text)} (${runs} run(s))\n`); continue }
      failed = true
      const out = value('--out')
      if (out !== undefined) { await mkdir(out, { recursive: true }); await writeFile(join(out, `${scenario.id}.log`), text) }
      process.stdout.write(`DIFFERS ${scenario.id}: ${golden === undefined ? 'no recorded log' : `${digest(golden)} recorded, ${digest(text)} now`}\n${golden === undefined ? '' : difference(golden, text)}\n`)
    }
    process.stdout.write(failed ? 'ORACLE FAILED\n' : `ORACLE OK (${selected.length} scenarios, ${runs} run(s)${stress ? ', under CPU stress' : ''})\n`)
    process.exitCode = failed ? 1 : 0
  } finally {
    busy?.kill()
    await rm(scratch, { recursive: true, force: true })
  }
}

if (args.includes('--child-replay')) await childReplay()
else await main()
