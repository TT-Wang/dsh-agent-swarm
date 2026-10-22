/** Cold native inspection projected by worker-history RPC; data stays inert text. */
interface HistoryEntry { event: { seq: number; type: string; data: unknown; timestamp?: number; createdAt?: number } }
export interface HistoryPage { events: HistoryEntry[]; hasMore: boolean }
interface TranscriptState { sessionId?: string; title?: string; entries: HistoryEntry[]; loading: boolean; hasMore: boolean; error?: string }
type ReadHistory = (sessionId: string, beforeSeq?: number) => Promise<HistoryPage>

/** On-demand, paginated cold transcript; no session activation or list writes. */
export class WorkerHistory {
  private state: TranscriptState = { entries: [], loading: false, hasMore: false }
  private generation = 0
  private listeners = new Set<() => void>()
  constructor(private readonly read: ReadHistory) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: TranscriptState) { this.state = state; for (const listener of this.listeners) listener() }
  open(sessionId: string, title: string) {
    this.generation++
    this.publish({ sessionId, title, entries: [], loading: false, hasMore: true })
    void this.load()
  }
  close = () => { this.generation++; this.publish({ entries: [], loading: false, hasMore: false }) }
  load = async (): Promise<void> => {
    const { sessionId, entries } = this.state, generation = this.generation
    if (!sessionId || this.state.loading || !this.state.hasMore) return
    const before = entries.length ? Math.min(...entries.map(entry => entry.event.seq)) : undefined
    this.publish({ ...this.state, loading: true, error: undefined })
    try {
      const page = await this.read(sessionId, before)
      if (generation !== this.generation) return
      if (!Array.isArray(page.events) || page.events.some(entry => !entry?.event || !Number.isFinite(entry.event.seq) || typeof entry.event.type !== 'string')) throw new Error('Invalid native history response')
      const merged = new Map([...page.events, ...entries].map(entry => [entry.event.seq, entry]))
      const ordered = [...merged.values()].sort((a, b) => a.event.seq - b.event.seq)
      this.publish({ ...this.state, entries: ordered, loading: false, hasMore: page.hasMore && page.events.length > 0 && (before === undefined || ordered[0]!.event.seq < before) })
    } catch (failure) {
      if (generation === this.generation) this.publish({ ...this.state, loading: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }
  dispose() { this.generation++; this.listeners.clear() }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** A message's content is a flat list of host blocks; no block nests another. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.map(blockText).filter(Boolean).join('\n') : ''
}
function blockText(block: unknown): string {
  if (!object(block)) return ''
  if (typeof block.text === 'string') return block.text
  if (block.type === 'image' || block.type === 'audio' || block.type === 'video') return `[${block.type}]`
  return ''
}
export function transcriptEntry(entry: HistoryEntry): { role: string; text: string } | undefined {
  const { type, data } = entry.event
  if (!object(data)) return undefined
  if (type === 'user/message') return { role: 'Input', text: contentText(data.content) }
  if (type === 'assistant/message') return { role: 'Assistant', text: object(data.message) ? contentText(data.message.content) : '' }
  if (type === 'tool/call') return { role: `Tool · ${String(data.name ?? '')}`, text: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}, null, 2) }
  // A failed call's tool-role message carries `isError` itself.
  if (type === 'tool/result') return { role: data.error || (object(data.message) && data.message.isError === true) ? 'Tool error' : 'Tool result', text: object(data.message) ? contentText(data.message.content) : JSON.stringify(data.error ?? data, null, 2) }
  if (type === 'compaction/summary') return { role: 'Context summary', text: contentText(data.content) || JSON.stringify(data, null, 2) }
  return undefined
}
