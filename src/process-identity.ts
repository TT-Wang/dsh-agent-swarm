/**
 * One owner identity for the plugin's file locks (CORE-04). The store's runtime
 * lock (`src/store.ts`) and the delivery apply lock (`src/delivery.ts`) each
 * record their owner as `{ pid, birth }` and both take a lock over only when
 * `ownerAbandoned` says its owner is gone.
 *
 * A PID alone is not an identity: once its process exits the kernel may give
 * the PID to an unrelated process, and `kill(pid, 0)` then reports that
 * stranger as the owner for as long as it lives. The birth tells them apart
 * (Linux: the boot id and the process start time in clock ticks; macOS:
 * `ps -o lstart`). Where no identity can be read (another platform, a failed
 * read, an owner record without a birth, a birth this build does not
 * recognise) the rule stays conservative: a live PID keeps its lock, so a lock
 * is only ever taken from an owner that is demonstrably gone.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** The owner identity a lock records. */
export interface LockOwner { pid: number; birth?: string }

/** The largest PID `process.kill` accepts (a signed 32-bit integer). */
const MAX_PID = 2 ** 31 - 1

/**
 * The owner a parsed lock record names, or `undefined` when it names no process
 * this host could signal. Fields other than `pid` and `birth` (the store lock's
 * nonce) belong to the lock that wrote them.
 */
export function recordedOwner(value: unknown): LockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { pid, birth } = value as { pid?: unknown; birth?: unknown }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > MAX_PID) return undefined
  return typeof birth === 'string' ? { pid, birth } : { pid }
}

function validBirth(birth: string): boolean {
  return /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/.test(birth)
    || /^darwin:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(birth)
}

const platformOf = (birth: string): string | undefined => birth.split(':')[0]

/** The birth of the process holding `pid` now, or `undefined` where this platform or process gives no trustworthy identity. */
function processBirth(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (start === undefined || !/^\d+$/.test(start)) return undefined
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${start}`
    }
    if (process.platform === 'darwin') {
      const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim()
      return start ? `darwin:${start}` : undefined
    }
  } catch { /* No trustworthy identity: the lock is retained while the PID lives. */ }
  return undefined
}

let own: string | undefined
/**
 * This process's birth, read once. A process's birth never changes, and a lock
 * that writes its owner after creating the lock must not widen that crash
 * window by a `ps` exec. Only a birth that was read is kept, so a failed read is
 * tried again at the next lock instead of leaving every later lock this process
 * takes without an identity.
 */
export function ownBirth(): string | undefined {
  return own ??= processBirth(process.pid)
}

/**
 * Whether a lock's recorded owner is demonstrably gone, so the lock may be
 * taken over: no process holds its PID (ESRCH), or the process holding it now
 * was born at another time on the same platform (the PID was recycled). A live
 * PID (EPERM counts as live) keeps its lock when the recorded birth is missing
 * or unrecognised, when the current birth cannot be read, or when the two come
 * from different platforms. Any other failure of the liveness probe is not a
 * judgement and is thrown.
 */
export function ownerAbandoned(owner: LockOwner): boolean {
  try { process.kill(owner.pid, 0) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return true
    if (code !== 'EPERM') throw error
  }
  if (owner.birth === undefined || !validBirth(owner.birth)) return false
  const current = processBirth(owner.pid)
  return current !== undefined && validBirth(current) && platformOf(current) === platformOf(owner.birth) && current !== owner.birth
}
