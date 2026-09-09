#!/usr/bin/env node
/**
 * Fault-injection suite F1-F17.
 *
 * Each scenario is a standalone module under tests/faults/ that injects one
 * fault, proves the injection fired, and then asserts the durable recovery
 * contract. A scenario only counts as a pass when its `FAULT_OK` record is
 * present and valid for the selected id (F-36). Scenarios run in separate child
 * processes so a crash scenario cannot poison the run. The suite never binds a
 * port, never uses the network and never touches the controller host.
 *
 * Host limitation (recorded for the integrator): this host refuses
 * `sandbox-exec`, so the provider-fault tier (F3a/F3b/F3c) runs the real
 * Harness Loader composition with an identity sandbox provider and an
 * unsandboxed shell. No assertion is weakened by the substitution.
 *
 * Usage: node scripts/faults/run.mjs [--only F5,F13] [--json] [--timeout ms]
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFaultOk } from './record.mjs'

const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
const FAULTS_DIR = join(PROJECT, 'tests/faults')
const args = process.argv.slice(2)
const value = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const asJson = args.includes('--json')
const only = (value('--only') ?? '').split(',').map(item => item.trim().toUpperCase()).filter(Boolean)
const timeoutMs = Number(value('--timeout') ?? 300_000)
const EXPECTED = ['F1', 'F2', 'F3', 'F3A', 'F3B', 'F3C', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14']

const scenarioId = file => file.replace(/\.mjs$/, '').replace(/^f(\d+)([a-z]?)-.*$/, (_match, number, suffix) => `F${Number(number)}${suffix.toUpperCase()}`)

const files = (await readdir(FAULTS_DIR)).filter(name => /^f\d+[a-z]?-.*\.mjs$/.test(name)).sort()
// F-36: a selective run must not hide a missing or misspelled module. Every
// requested id has to exist in the expected set and in the discovered inventory.
const inventory = new Set(files.map(scenarioId))
const unknown = only.filter(id => !EXPECTED.includes(id) || !inventory.has(id))
if (unknown.length) {
  process.stderr.write(`faults: unknown scenario id(s): ${unknown.join(', ')}\n`)
  process.exit(1)
}
const selected = files.filter(file => !only.length || only.includes(scenarioId(file)))
if (!selected.length) {
  process.stderr.write(`faults: no scenario matched ${JSON.stringify(only)}\n`)
  process.exit(1)
}

function runOne(file) {
  return new Promise(resolve => {
    const started = Date.now()
    execFile(process.execPath, [join(FAULTS_DIR, file)], { cwd: PROJECT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      // F-36: a scenario passes only when its record is present and valid for
      // this exact id; a plausible record for another fault is a failure.
      const parsed = parseFaultOk(stdout, scenarioId(file))
      const record = parsed.record
      resolve({
        file, id: scenarioId(file), ok: !error && record !== undefined, ms: Date.now() - started, record,
        reason: error ? (error.killed ? `timed out after ${timeoutMs}ms` : String(stderr || error).trim().slice(-1500)) : parsed.error,
      })
    })
  })
}

const results = []
for (const file of selected) {
  const result = await runOne(file)
  results.push(result)
  if (!asJson) process.stdout.write(`${result.ok ? 'pass' : 'FAIL'}  ${result.id.padEnd(5)} ${String(result.ms).padStart(7)}ms  ${result.record?.title ?? result.reason?.split('\n')[0] ?? ''}\n`)
  if (!result.ok && !asJson && result.reason) process.stderr.write(`--- ${result.id} (${result.file})\n${result.reason}\n`)
}

const passed = results.filter(result => result.ok).length
const failed = results.filter(result => !result.ok)
const ran = new Set(results.map(result => result.id))
const missing = only.length ? [] : EXPECTED.filter(id => !ran.has(id))
if (missing.length) {
  for (const id of missing) process.stderr.write(`faults: scenario ${id} did not run\n`)
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ expected: EXPECTED, passed, failed: failed.map(item => item.id), missing, results }, null, 2)}\n`)
} else {
  process.stdout.write(`${passed}/${results.length} fault scenarios passed${missing.length ? `; missing ${missing.join(', ')}` : ''}\n`)
}
process.exit(failed.length || missing.length ? 1 : 0)
