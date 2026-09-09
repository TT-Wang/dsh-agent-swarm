/**
 * D8 load harness: run N >= 16 concurrent synthetic workers against a temporary
 * store and print the measured admission envelope — admission p50/p95, maximum
 * concurrent leases, queue high-water mark, the exact limit that was hit and the
 * per-worker observation cost. It then runs a larger N and asserts the per-worker
 * observation cost stays bounded, so "bounded reads" is a measurement instead of
 * a claim.
 *
 * Boundary (single-host, single-writer): the store is one SQLite file with WAL and
 * exactly one writer process. Every claim below is serialized by the runtime's
 * mission queue, which is the same boundary the production runtime has; a second
 * writer process is classified as `writer_busy` and retried with bounded backoff
 * (see `tests/scalability-concurrent-writer.test.mjs`). This harness measures a
 * single node; it does not imply horizontal scale-out. See `scripts/load/README.md`.
 *
 * Usage: node scripts/load/run.mjs [--workers 16] [--scaling]
 * Requires a prior `npm run build` (it imports the built `lib/`).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SwarmRuntime } from '../../lib/runtime.js'

class InertWorkers {
  callbacks; prepared = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `/inert/${memberId}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(task.id) }
  async dispose() {}
}

export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

export function median(values) { return percentile(values, 50) }

export async function runEnvelope({ workerCount }) {
  if (!Number.isSafeInteger(workerCount) || workerCount < 2) throw new Error('workerCount must be an integer >= 2')
  const root = await mkdtemp(join(tmpdir(), 'swarm-d8-load-'))
  const runtime = new SwarmRuntime({
    statePath: join(root, 'load.sqlite'), leaseMs: 600000, tickMs: 3600000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100,
  }, new InertWorkers())
  try {
    await runtime.start()
    const owner = { sessionId: 'load-owner' }
    const mission = runtime.create(owner, {
      title: 'D8 load envelope', objective: 'measure admission control under concurrent claims', workspace: join(root, 'workspace'), scope: ['**'], acceptance: ['envelope printed'],
      budget: { maxTokens: 10000000, maxSteps: 100000, maxWorkers: workerCount, maxDurationMs: 3600000, maxTasks: workerCount * 2 + 8, maxExperiments: 0 },
    })
    const stream = runtime.workstream(owner, mission.id, { title: 'load', objective: 'load' })
    const members = []
    for (let index = 0; index < workerCount; index++) members.push(await runtime.addMember(owner, mission.id, { name: `load-${index}`, role: 'worker', maxOutputTokens: 1000 }))
    const tasks = members.map((member, index) => runtime.propose(owner, mission.id, {
      workstreamId: stream.id, title: `load task ${index}`, objective: `run synthetic work ${index}`, kind: 'implementation',
      scope: [`src/w${index}/`], acceptance: ['measured'], checks: ['node -e "process.exit(0)"'], assigneeId: member.id,
    }))
    // Hierarchical per-scope limits: a free scope, a task-class cap that must bind
    // first, and one lease per agent. The strictest matching rule wins.
    const concurrency = Math.max(1, Math.floor(workerCount / 2))
    runtime.setAdmissionLimit(owner, mission.id, { level: 'scope', limit: workerCount }, 'load: every scope may use the whole envelope')
    runtime.setAdmissionLimit(owner, mission.id, { level: 'taskClass', key: 'implementation', limit: concurrency }, 'load: task-class cap')
    runtime.setAdmissionLimit(owner, mission.id, { level: 'agent', limit: 1 }, 'load: one lease per worker')

    let maxConcurrentLeases = 0, queueHighWater = 0
    const sample = () => {
      const all = runtime.store.list('tasks', mission.id)
      maxConcurrentLeases = Math.max(maxConcurrentLeases, all.filter(task => task.status === 'running').length)
      queueHighWater = Math.max(queueHighWater, all.filter(task => task.status === 'pending').length)
    }
    const sampler = setInterval(sample, 1)
    sampler.unref()
    sample()
    const startedAt = members.map(() => performance.now())
    const outcomes = await Promise.allSettled(members.map((member, index) => runtime.claim({ sessionId: member.sessionId }, mission.id, tasks[index].id)))
    const claimLatencies = members.map((_, index) => performance.now() - startedAt[index])
    clearInterval(sampler); sample()

    const ledger = runtime.admissionLedger(owner, mission.id)
    const admitted = ledger.filter(row => row.reason === 'admitted')
    const refused = ledger.filter(row => !row.admitted)
    const limitHits = {}
    for (const row of refused) {
      const key = `${row.reason}@${row.level ?? '-'}(${row.key ?? '-'})=${row.limit ?? '-'}`
      limitHits[key] = (limitHits[key] ?? 0) + 1
    }
    const observationBytes = members.map((member, index) =>
      JSON.stringify(runtime.observe({ sessionId: member.sessionId }, mission.id, { taskId: tasks[index].id })).length)
    return {
      workerCount, admitted: admitted.length, refused: refused.length,
      maxConcurrentLeases, finalLeases: runtime.store.list('tasks', mission.id).filter(task => task.status === 'running').length,
      queueHighWater,
      admissionP50Ms: percentile(admitted.map(row => row.latencyMs), 50),
      admissionP95Ms: percentile(admitted.map(row => row.latencyMs), 95),
      refusalP50Ms: percentile(refused.map(row => row.latencyMs), 50),
      refusalP95Ms: percentile(refused.map(row => row.latencyMs), 95),
      claimP50Ms: percentile(claimLatencies, 50),
      claimP95Ms: percentile(claimLatencies, 95),
      limitHits,
      observationMaxBytes: Math.max(...observationBytes),
      observationMedianBytes: median(observationBytes),
      fulfillment: outcomes.filter(outcome => outcome.status === 'fulfilled').length,
    }
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/** The focused per-worker view must not grow with the mission; the full board is the owner/UI projection. */
export function observationBound(small, large) {
  const cap = Math.max(small.observationMaxBytes * 1.25, small.observationMaxBytes + 2048, 16384)
  return { ratio: large.observationMaxBytes / Math.max(1, small.observationMaxBytes), cap, bounded: large.observationMaxBytes <= cap }
}

export function formatEnvelope(envelope) {
  const hits = Object.entries(envelope.limitHits).map(([key, count]) => `${key} x${count}`).join(', ') || 'none'
  return `N=${envelope.workerCount} admitted=${envelope.admitted} refused=${envelope.refused} maxConcurrentLeases=${envelope.maxConcurrentLeases} queueHighWater=${envelope.queueHighWater} ` +
    `admission p50=${envelope.admissionP50Ms}ms p95=${envelope.admissionP95Ms}ms refusal p50=${envelope.refusalP50Ms}ms p95=${envelope.refusalP95Ms}ms ` +
    `claim p50=${envelope.claimP50Ms.toFixed(1)}ms p95=${envelope.claimP95Ms.toFixed(1)}ms ` +
    `limitHit=${hits} observation max=${envelope.observationMaxBytes}B median=${envelope.observationMedianBytes}B`
}

export async function main(argv = process.argv.slice(2)) {
  const workersFlag = argv.indexOf('--workers')
  const requested = workersFlag === -1 ? undefined : Number(argv[workersFlag + 1])
  const sizes = requested === undefined ? [16, 32] : [requested]
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 16)) throw new Error('the D8 envelope requires N >= 16')
  const envelopes = []
  for (const size of sizes) {
    const envelope = await runEnvelope({ workerCount: size })
    envelopes.push(envelope)
    console.log(formatEnvelope(envelope))
    const cap = Math.max(1, Math.floor(size / 2))
    if (envelope.admitted + envelope.refused !== size) throw new Error(`N=${size}: every worker needs an admission decision`)
    if (envelope.fulfillment !== envelope.admitted) throw new Error(`N=${size}: every admitted lease must come from an explicit worker claim (fulfilled=${envelope.fulfillment}, admitted=${envelope.admitted})`)
    if (envelope.maxConcurrentLeases !== cap) throw new Error(`N=${size}: expected the task-class cap ${cap} to bind, saw ${envelope.maxConcurrentLeases} leases`)
    if (envelope.refused === 0) throw new Error(`N=${size}: the load shape must hit a limit`)
    if (envelope.queueHighWater < size - cap) throw new Error(`N=${size}: queue high-water ${envelope.queueHighWater} did not observe the waiting workers`)
    if (Object.keys(envelope.limitHits).length === 0) throw new Error(`N=${size}: the exact limit hit was not recorded`)
    if (envelope.observationMaxBytes > 65536) throw new Error(`N=${size}: per-worker observation exceeded 64 KiB`)
  }
  if (envelopes.length > 1) {
    const bound = observationBound(envelopes[0], envelopes.at(-1))
    console.log(`per-worker observation: N=${envelopes[0].workerCount} max=${envelopes[0].observationMaxBytes}B -> N=${envelopes.at(-1).workerCount} max=${envelopes.at(-1).observationMaxBytes}B ` +
      `(ratio ${bound.ratio.toFixed(2)}x, cap ${Math.round(bound.cap)}B) ${bound.bounded ? 'BOUNDED' : 'UNBOUNDED'}`)
    if (!bound.bounded) throw new Error('per-worker observation cost grew with N')
  }
  console.log('D8 load envelope OK (single host, single writer; see scripts/load/README.md)')
  return envelopes
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`load harness failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
}
