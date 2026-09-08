export function uiSnapshot() {
  const now = Date.UTC(2026, 8, 8, 7, 30)
  const mission = { id: 'mission-demo', ownerSessionId: 'owner', workspace: '/workspace/demo',
    title: 'Build a reliable agent swarm', objective: 'Explore competing designs, implement the strongest approach, and verify every accepted change against evidence.',
    scope: ['src/', 'tests/'], acceptance: ['Attempts have one authoritative owner', 'Independent verification uses the exact artifact'],
    status: 'active', budget: { maxTokens: 100000, maxSteps: 120, maxWorkers: 5, maxDurationMs: 3600000, maxTasks: 20, maxExperiments: 3 },
    usedTokens: 32680, usedSteps: 38, createdAt: now - 600000, updatedAt: now, deadline: now + 3000000 }
  const members = [
    { id: 'a', name: 'Atlas', role: 'Research & architecture', status: 'idle' },
    { id: 'b', name: 'Nova', role: 'Runtime implementation', status: 'working' },
    { id: 'c', name: 'Echo', role: 'Independent verification', status: 'waiting' },
  ].map(member => ({ ...member, missionId: mission.id, sessionId: `${member.id}-session`, workspace: '/workspace/demo', subscriptions: ['runtime'], model: 'deepseek-v4' }))
  const workstreams = [{ id: 'runtime', missionId: mission.id, title: 'Execution runtime', objective: 'Reliable parallel execution' },
    { id: 'verification', missionId: mission.id, title: 'Evidence & verification', objective: 'Verify the exact artifact' }]
  const task = (id, title, status, extra = {}) => ({ id, missionId: mission.id, workstreamId: 'runtime', title, status,
    objective: title, kind: 'implementation', dependencies: [], scope: ['src/'], acceptance: ['Verification passes'],
    checks: ['node --test'], priority: 1, experiment: false, epoch: 1, evidenceIds: [], createdAt: now - 500000, ...extra })
  const artifact = { commit: 'bc918def1234567890abcdef1234567890abcdef12', baseCommit: '47f943859bef60e4160492346772ded9b24f765a', workspace: '/workspace/demo', changedPaths: ['src/scheduler.ts'] }
  const tasks = [task('t1', 'Compare durable dispatch strategies', 'accepted', { kind: 'research', assigneeId: 'a', evidenceIds: ['ev-1'] }),
    task('t2', 'Implement lease renewal and fencing', 'running', { assigneeId: 'b', dependencies: ['t1'], attempt: { id: 'attempt-b-2', epoch: 2, ownerId: 'b', leaseUntil: now + 60000 } }),
    task('t3', 'Verify stale attempts cannot commit', 'pending', { kind: 'verification', workstreamId: 'verification', assigneeId: 'c', reviewOf: 't2' }),
    task('t4', 'Investigate mailbox recovery', 'submitted', { kind: 'research', workstreamId: 'verification', assigneeId: 'c', artifact, evidenceIds: ['ev-2'] }),
    task('t5', 'Document runtime contracts', 'pending')]
  const evidence = [{ id: 'ev-1', missionId: mission.id, workstreamId: 'runtime', taskId: 't1', authorId: 'a',
    claim: 'A fenced attempt prevents stale task-state updates after reassignment.', outcome: 'supported', status: 'verified',
    toolRunIds: ['tool-run-001', 'tool-run-002'], challenges: [], supersedes: [], createdAt: now - 300000 },
  { id: 'ev-2', missionId: mission.id, workstreamId: 'verification', taskId: 't4', authorId: 'c',
    claim: 'Mailbox delivery remains idempotent across process restart.', outcome: 'inconclusive', status: 'challenged', artifact,
    toolRunIds: ['tool-run-018'], challenges: [{ authorId: 'b', reason: 'The receipt test did not simulate a crash after acceptance but before acknowledgement.', toolRunIds: ['tool-run-019'] }],
    supersedes: [], createdAt: now - 60000 }]
  const events = [{ seq: 1, missionId: mission.id, type: 'mission.created', actor: 'owner', data: { title: mission.title }, createdAt: now - 600000 },
    { seq: 2, missionId: mission.id, type: 'task.accepted', actor: 'a', data: { taskId: 't1' }, createdAt: now - 300000 },
    { seq: 3, missionId: mission.id, type: 'attempt.started', actor: 'b', data: { taskId: 't2' }, createdAt: now - 120000 },
    { seq: 4, missionId: mission.id, type: 'evidence.challenged', actor: 'b', data: { evidenceId: 'ev-2', reason: 'Crash boundary needs another test' }, createdAt: now - 10000 }]
  return { mission, members, workstreams, tasks, evidence, events, pendingDeliveries: 1 }
}
