/** F4: kill -9 of the host during integration. Restart recovers; no half-applied artifact; promote refuses without a green gate. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepo, runNode, runScenario } from './harness.mjs'

await runScenario({
  id: 'F4', title: 'A SIGKILL during integration recovers without a half-applied artifact and promote still needs a green gate', invariants: ['I7'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f4')
    try {
    const workspacesRoot = join(root, 'worktrees')
    const stateDir = join(root, 'state')
    await mkdir(stateDir, { recursive: true })
    const marker = join(root, 'crash-marker.json')
    // The crashed process owns the running integration attempt and dies without
    // disposing the runtime, so the durable state is exactly a host crash.
    const crashed = await runNode(['tests/faults/driver.mjs', 'f4-crash', '--state', stateDir, '--workspace', source, '--worktrees', workspacesRoot, '--marker', marker])
    assert.equal(crashed.signal, 'SIGKILL', `the host was killed mid-integration: ${crashed.stderr.slice(0, 400)}`)
    const before = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(before.phase, 'f4-crash')
    assert.match(before.attemptId, /^attempt_/, 'the crashed host owned a live attempt')
    assert.equal(before.partial, 'partial integration work\n', 'the crashed host had half-done integration work')
    const recovered = await runNode(['tests/faults/driver.mjs', 'f4-recover', '--state', stateDir, '--workspace', source, '--worktrees', workspacesRoot, '--mission', before.missionId, '--task', before.taskId])
    assert.equal(recovered.code, 0, `the restarted host exits cleanly: ${recovered.stderr.slice(0, 400)}`)
    const state = JSON.parse(recovered.stdout.trim().split('\n').at(-1))
    assert(state.recoveredEvents >= 1, 'I7: the restarted host recovers the mission')
    assert.notEqual(state.status, 'accepted', 'I7: no half-applied integration is accepted')
    assert.equal(state.artifact, null, 'I7: no artifact is trusted after the crash')
    assert.equal(state.appliedDelivery, null, 'I7: no delivery is recorded as applied')
    assert.equal(state.partial, before.partial, 'I7: the partial integration workspace is preserved')
    // Promotion still requires a recorded green gate for the exact commit.
    const lab = await mkdtemp(join(tmpdir(), 'swarm-faults-lab-'))
    const promoted = await runNode(['scripts/round.mjs', 'promote', '--commit', 'HEAD', '--lab', lab])
    assert.equal(promoted.code, 2, 'I7: promote refuses without a recorded gate')
    assert.match(promoted.stderr, /no recorded green gate/, 'I7: the refusal names the missing gate')
    return { crashed: before.attemptId, recoveredStatus: state.status, recoveredEvents: state.recoveredEvents, promoteExit: promoted.code }
    } finally { await rm(root, { recursive: true, force: true }) }
  },
})
