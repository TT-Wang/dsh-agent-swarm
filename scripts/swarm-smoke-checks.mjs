import assert from 'node:assert/strict'

/** Expand a native disclosure through its visible summary, as a user would. */
export async function openSwarmDetails(panel, name) {
  const disclosure = panel.locator(`[data-swarm-details="${name}"]`)
  await disclosure.waitFor({ state: 'attached' })
  if (!await disclosure.evaluate(element => element.open)) await disclosure.locator(':scope > summary').click()
  return disclosure
}

export async function assertSimplifiedSwarm(panel) {
  assert.equal(await panel.locator('[role="tab"]:visible').count(), 0, 'default sidebar must not display the four technical tabs')
  assert.equal(await panel.locator('.sw-metrics:visible').count(), 0, 'resource metrics belong in the collapsed technical disclosure')
  assert.equal(await panel.locator('[data-testid="draft-title"]:visible').count(), 0, 'default sidebar must not open a manual planning form')
  assert.equal(await panel.locator('input[type="number"]:visible').count(), 0, 'default sidebar must not ask the user for numeric budgets')
}

/** Observe the public wire contract independently of the product monitor. */
export function observedSwarmState(current, endpoint, value) {
  if (endpoint === '/api/agent-swarm/state') return value
  if (endpoint !== '/api/agent-swarm/watch') return undefined
  if (value.kind === 'heartbeat') {
    if (current?.ownerSessionId !== value.ownerSessionId) return undefined
    const state = { ...current, revision: value.revision }
    for (const key of ['ownerLive', 'writable', 'defaultBudget', 'workspace']) if (value[key] !== undefined) state[key] = value[key]
    return state
  }
  if (value.kind === 'snapshot') return value.state
  if (value.kind !== 'delta' || current?.ownerSessionId !== value.ownerSessionId) return undefined
  const changed = new Map(value.state.snapshots.map(snapshot => [snapshot.mission.id, snapshot]))
  const previous = new Map(current.snapshots.map(snapshot => [snapshot.mission.id, snapshot]))
  return { ...value.state, snapshots: value.missionIds.map(id => changed.get(id) ?? previous.get(id)).filter(Boolean) }
}
