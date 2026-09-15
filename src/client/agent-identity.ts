/** Identity belongs to the durable member, not its current role, name or task. */
export interface AgentIdentity {
  palette: number
  head: number
  eyes: number
  antenna: number
  mark: number
}

export function agentIdentity(id: string | undefined, name: string): AgentIdentity {
  const key = id?.trim() || name.trim() || 'agent'
  let seed = 2166136261
  for (const character of key) {
    seed = Math.imul(seed ^ character.codePointAt(0)!, 16777619)
  }
  // Mix before each choice; neighbouring IDs should not produce neighbouring faces.
  const pick = (count: number): number => {
    seed ^= seed >>> 16
    seed = Math.imul(seed, 0x7feb352d)
    seed ^= seed >>> 15
    seed = Math.imul(seed, 0x846ca68b)
    seed ^= seed >>> 16
    return (seed >>> 0) % count
  }
  return { palette: pick(6), head: pick(4), eyes: pick(4), antenna: pick(4), mark: pick(3) }
}
