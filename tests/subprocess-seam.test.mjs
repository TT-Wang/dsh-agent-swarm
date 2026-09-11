/**
 * The subprocess-seam adapter's own contract (2026-09-11 adoption).
 *
 * `runProcess` no longer creates processes: it hands one fully specified spawn
 * spec to the provider behind `ctx.subprocess` and reads the result back. These
 * cases drive a scripted seam so every field of that handover, and every
 * classified failure, is asserted without a real process: the spec's dispositions
 * and grace, the exact-environment tombstones, the head-keeping output window
 * with attribution read past the bound, the exit-code mapping, the deadline and
 * caller-abort classification, the range release, and the two refusal paths (no
 * provider, provider without the requested pipes).
 *
 * The real provider is exercised by the rest of the suite through
 * `tests/subprocess-seam.mjs`; this file is the adapter's half.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { runProcess } from '../lib/workspaces.js'

/** One scripted handle: the pipes the adapter reads and the outcome it awaits. */
function fakeProcess() {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  let settle
  let fail
  const done = new Promise((resolve, reject) => { settle = resolve; fail = reject })
  const handle = {
    stdout, stderr, done, terminateCalls: 0,
    resolve: outcome => settle(outcome),
    reject: error => fail(error),
    terminate() { handle.terminateCalls += 1 },
    waitForExit: async () => true,
  }
  return handle
}

/** A seam that records every spec and returns one scripted handle per spawn. */
function scriptedSeam(behaviour = () => fakeProcess()) {
  const specs = []
  const handles = []
  return {
    specs, handles,
    seam: { spawn(spec) { specs.push(spec); const handle = behaviour(spec); handles.push(handle); return handle } },
  }
}

/** Let the adapter attach its stream listeners before the script pushes bytes. */
const settlePipes = async () => { await new Promise(resolve => setImmediate(resolve)) }

async function run(argv, options, source) {
  return await runProcess(argv, { cwd: process.cwd(), timeoutMs: 5_000, maxBytes: 1_024, subprocess: () => source.seam, ...options })
}

test('SEAM: the spawn spec carries argv, cwd, pipes, grace, signal and environment', async () => {
  const source = scriptedSeam()
  const pending = run(['git', 'status'], { env: { HOME: '/tmp/seam-home' } }, source)
  await settlePipes()
  assert.equal(source.specs.length, 1, 'one spawn per run')
  const spec = source.specs[0]
  assert.deepEqual([...spec.argv], ['git', 'status'])
  assert.equal(spec.cwd, process.cwd())
  assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, 'the adapter reads the pipes itself, so the provider never collects')
  assert(Number.isSafeInteger(spec.graceMs) && spec.graceMs > 0 && spec.graceMs <= 2_147_483_647, `a positive bounded grace: ${spec.graceMs}`)
  assert(spec.signal instanceof AbortSignal, 'the caller deadline is the spec signal')
  assert.equal(spec.signal.aborted, false)
  assert.equal(spec.env.HOME, '/tmp/seam-home')
  assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0', 'every spawned command is non-interactive')
  source.handles[0].resolve({ exitCode: 0, signal: null })
  const result = await pending
  assert.equal(result.exitCode, 0)
})

test('SEAM: an explicit environment is the whole environment, and the ambient scrub is the base without one', async () => {
  const ambient = Object.keys(scrubbedParentEnv())
  assert(ambient.length > 0, 'the host process has a scrubbed ambient environment to reason about')
  const omitted = ambient[0]
  const explicit = scriptedSeam()
  const first = run(['sh', '-c', 'true'], { env: { HOME: '/tmp/seam-home' } }, explicit)
  await settlePipes()
  assert(Object.hasOwn(explicit.specs[0].env, omitted), `${omitted} is tombstoned, not inherited`)
  assert.equal(explicit.specs[0].env[omitted], undefined)
  explicit.handles[0].resolve({ exitCode: 0, signal: null })
  await first
  const inherited = scriptedSeam()
  const second = run(['sh', '-c', 'true'], {}, inherited)
  await settlePipes()
  assert(!Object.hasOwn(inherited.specs[0].env, omitted), 'without an explicit map the provider supplies its own base')
  assert.equal(inherited.specs[0].env.GIT_TERMINAL_PROMPT, '0')
  inherited.handles[0].resolve({ exitCode: 0, signal: null })
  await second
})

test('SEAM: output keeps the head, reports truncation, and attribution still reads the dropped tail', async () => {
  const source = scriptedSeam()
  const pending = run(['sh', '-c', 'check'], { maxBytes: 64, captureAttribution: true }, source)
  await settlePipes()
  const handle = source.handles[0]
  handle.stdout.push(Buffer.from(`not ok 1 - first failure\n${'x'.repeat(200)}\n`))
  handle.stdout.push(Buffer.from('1..3\n'))
  handle.stdout.push(null)
  handle.stderr.push(null)
  handle.resolve({ exitCode: 1, signal: null })
  const result = await pending
  assert.equal(result.exitCode, 1)
  assert.equal(result.truncated, true, 'the bound really dropped bytes')
  assert(Buffer.byteLength(result.output) <= 64, `the stored output stays inside the bound: ${Buffer.byteLength(result.output)}`)
  assert.match(result.output, /^not ok 1 - first failure/, 'the head of the stream is what is kept')
  assert(!result.output.includes('1..3'), 'the dropped tail is absent from the stored output and only visible through attribution')
  assert.match(result.output, /\[output truncated\]$/)
  assert.deepEqual(result.attribution.failingTests, ['first failure'], 'the failing test is attributed even from bytes the bound dropped')
  assert.deepEqual(result.attribution.tapSummary, ['1..3'])
  assert.equal(result.attribution.outputTruncated, true)
  assert.equal(handle.terminateCalls, 1, 'the range is released once the run has settled')
})

test('SEAM: attribution is absent unless it was requested, and a null exit code reports as one', async () => {
  const source = scriptedSeam()
  const pending = run(['sh', '-c', 'check'], {}, source)
  await settlePipes()
  source.handles[0].stdout.push(null)
  source.handles[0].stderr.push(null)
  source.handles[0].resolve({ exitCode: null, signal: 'SIGKILL' })
  const result = await pending
  assert.equal(result.attribution, undefined)
  assert.equal(result.exitCode, 1, 'a signalled command reports a non-zero code, as the direct launcher did')
})

test('SEAM: the deadline aborts the spec signal and reports its own timeout', async () => {
  const source = scriptedSeam(spec => {
    const handle = fakeProcess()
    spec.signal.addEventListener('abort', () => { handle.resolve({ exitCode: null, signal: 'SIGKILL' }) }, { once: true })
    return handle
  })
  await assert.rejects(
    run(['sh', '-c', 'sleep forever'], { timeoutMs: 25 }, source),
    error => /Execution timed out after 25ms/.test(error.message),
  )
  assert.equal(source.specs[0].signal.aborted, true, 'the provider was told to terminate the range')
  assert.match(String(source.specs[0].signal.reason?.message), /timed out after 25ms/)
  assert.equal(source.handles[0].terminateCalls, 1)
})

test('SEAM: a caller abort reports cancellation with the caller cause, not the provider error', async () => {
  const source = scriptedSeam(spec => {
    const handle = fakeProcess()
    spec.signal.addEventListener('abort', () => { handle.reject(new Error('provider: terminated before target start')) }, { once: true })
    return handle
  })
  const controller = new AbortController()
  const pending = run(['sh', '-c', 'sleep forever'], { signal: controller.signal }, source)
  setTimeout(() => controller.abort(new Error('user cancelled')), 25)
  await assert.rejects(pending, error => /Execution cancelled/.test(error.message) && error.cause?.message === 'user cancelled')
})

test('SEAM: a provider failure reaches the caller, and the deadline still classifies its own case', async () => {
  const failing = scriptedSeam(() => { const handle = fakeProcess(); setImmediate(() => handle.reject(new Error('spawn ENOENT'))); return handle })
  await assert.rejects(run(['missing-binary'], {}, failing), /spawn ENOENT/)
  const both = scriptedSeam(spec => {
    const handle = fakeProcess()
    spec.signal.addEventListener('abort', () => { handle.reject(new Error('provider: terminated before target start')) }, { once: true })
    return handle
  })
  await assert.rejects(run(['sh', '-c', 'sleep forever'], { timeoutMs: 25 }, both), /Execution timed out after 25ms/)
})

test('SEAM: a provider that drops the requested pipes refuses and releases the range', async () => {
  const source = scriptedSeam(() => { const handle = fakeProcess(); handle.stdout = undefined; return handle })
  await assert.rejects(run(['sh', '-c', 'true'], {}, source), /\[subprocess_pipes_missing\] The Harness subprocess provider did not expose the requested stdout and stderr pipes/)
  assert.equal(source.handles[0].terminateCalls, 1)
})

test('SEAM: no provider, no process — the refusal names the missing host service', async () => {
  await assert.rejects(run(['git', 'status'], {}, { seam: undefined }), /\[subprocess_service_required\] Command execution requires the Harness subprocess service/)
  await assert.rejects(run(['git', 'status'], { subprocess: () => undefined }, { seam: undefined }), /\[subprocess_service_required\]/)
})

test('SEAM: an empty argv is refused before any provider is consulted', async () => {
  const source = scriptedSeam()
  await assert.rejects(run([], {}, source), /An executable is required/)
  assert.equal(source.specs.length, 0)
})
