/**
 * Workspace and admission surface: the worker git-write refusal, the shared-temp
 * rendezvous detector, the human-authorized workspace roots and the isolation
 * invariant. M1a seam 6/7.
 *
 * Everything here is behaviour-identical to the code it was moved from
 * src/runtime.ts. The runtime keeps thin forwarding methods for the method group,
 * so no call site changed; the pure helpers are imported by name.
 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isContained, WORKSPACE_AUTHORIZATION_CODE, type WorkspaceGrantSnapshot } from './authorization.ts'
import type { SwarmRuntime } from './runtime.ts'
import { absoluteCheckPaths, shellSegments } from './admission.ts'
import type { Member, Mission, Task } from './types.ts'

/**
 * R11-15: the shared temp roots every workspace-write execution may write
 * (DSH `roots.ts`: the workspace root, `/tmp` and `os.tmpdir()`). They are
 * shared across members and missions, so they are a cross-tenant channel.
 */
const SHARED_TEMP_ROOTS: readonly string[] = [...new Set(['/tmp', '/var/tmp', tmpdir()].flatMap(root => {
  const clean = root.replace(/\/+$/, '')
  return [clean, `/private${clean}`]
}))]

/** R11-15: how long two members naming the same shared temp path still count as a rendezvous. */
export const TEMP_RENDEZVOUS_WINDOW_MS = 10 * 60_000

/** R11-15: bounded per-path mention history and reported-pair bookkeeping. */
const TEMP_RENDEZVOUS_MAX_PATHS = 2048

const TEMP_RENDEZVOUS_MAX_MENTIONS = 8

/** R11-15: one member's host-recorded mention of a shared temp path. */
export interface TempMention { memberId: string; taskId: string; at: number }

/**
 * R11-15: the shared-temp absolute paths one host-recorded tool call names.
 * Shell commands are tokenized by the same POSIX-ish scanner admission uses and
 * file tools contribute their path argument. This is a bounded heuristic over
 * host-recorded input, not proof that the path was written: it surfaces a
 * rendezvous attempt between members, never file contents.
 */
export function sharedTempPaths(input: { tool: string; arguments: unknown }): string[] {
  const candidates: string[] = []
  const args = input.arguments
  if (args !== null && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.command === 'string') candidates.push(...absoluteCheckPaths(record.command))
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path'] as const) if (typeof record[key] === 'string') candidates.push(record[key] as string)
  }
  const found: string[] = []
  for (const candidate of candidates) {
    const normalized = candidate.replace(/^\/+/, '/')
    if (!SHARED_TEMP_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))) continue
    if (!found.includes(normalized)) found.push(normalized)
  }
  return found
}

/** R11-15: the first mention by a different member still inside the window, or undefined. */
export function tempRendezvousDecision(mentions: readonly TempMention[], memberId: string, now: number, windowMs = TEMP_RENDEZVOUS_WINDOW_MS): TempMention | undefined {
  return mentions.find(mention => mention.memberId !== memberId && now - mention.at <= windowMs)
}

/** A worker-side git write that the sandbox refused; the action names the supported exit. */
export const gitWriteDeniedMessage = (command: string): string => `Worker git writes are denied by the workspace sandbox: ${command} could not write git metadata (index.lock EPERM). Workers cannot commit; do not retry git add/commit. Publish the workspace with swarm_submit, which captures it host-side, or release the attempt with swarm_handoff/swarm_wait.`

/**
 * F14: only a shell-executing tool runs a command line that can attempt a git
 * write. `bash`/`pwsh` carry it in `command`, a persistent terminal carries the
 * typed shell input in `text`. Every other tool (edit, grep, read, write) may
 * quote a git-write phrase in its arguments and may even return file text that
 * contains index.lock/EPERM; that text was never executed, so it must neither
 * claim the typed denial nor latch the attempt.
 */
const SHELL_COMMAND_KEYS = new Map<string, readonly string[]>([
  ['bash', ['command']], ['pwsh', ['command']], ['shell', ['command']],
  ['terminal', ['text']], ['terminal_send', ['text']],
])

/** The executed command line of a shell tool, or undefined for any other tool. */
export function executedShellCommand(tool: string, args: unknown): string | undefined {
  const keys = SHELL_COMMAND_KEYS.get(tool)
  if (keys === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * The command with shell comments, quoted spans, arithmetic expressions,
 * `$[...]`/`${...}` literal spans and heredoc bodies removed, so a phrase that
 * merely appears as data (a search pattern, an edit body, a message, a heredoc
 * body) is not mistaken for an executed command. Direct commands and compound
 * command words keep their text; a command hidden inside a nested shell string
 * is not seen. R7-01: a `<<`/`<<-` heredoc body is data, so a line-start
 * `git add`/`git commit` inside a runbook written by `cat` is never classified
 * as an executed write, even when another command in the same call fails.
 * R7-01b/c: only an operator that really starts a heredoc is recognized —
 * `<<<` here-strings, `<<` inside arithmetic (`$((...))`, `((...))`), inside
 * `$[...]`, inside unquoted `${...}` and inside quotes/comments stay command
 * text, and an operator whose body has no terminator line stays command text
 * too, so a phantom operator can never swallow a later real write.
 */
function unquotedShellText(command: string): string {
  let text = ''
  let quote: '"' | "'" | undefined
  let arithmetic = 0
  let literal: '[' | '{' | undefined
  let literalQuote: '"' | "'" | undefined
  let literalDepth = 0
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') index++
      else if (char === quote) quote = undefined
      continue
    }
    if (literal !== undefined) {
      // R7-01c: `$[...]` and unquoted `${...}` are literal spans. Their text is
      // kept, but a `<<` inside them is never a heredoc operator. Quotes inside
      // the span are tracked locally so `${x:-"a}b"}` does not end early.
      if (literalQuote !== undefined) {
        if (char === '\\' && literalQuote === '"' && index + 1 < command.length) {
          text += char + command[index + 1]!
          index++
          continue
        }
        if (char === literalQuote) literalQuote = undefined
        text += char
        continue
      }
      if (char === '"' || char === "'") { literalQuote = char; text += char; continue }
      if (char === literal) literalDepth++
      else if (char === (literal === '[' ? ']' : '}')) {
        literalDepth--
        if (literalDepth === 0) { literal = undefined; literalQuote = undefined }
      }
      text += char
      continue
    }
    if (arithmetic > 0) {
      // Inside arithmetic a `<<` is a shift and parens are balanced; the text
      // stays so a malformed expansion can never hide a later command.
      if (char === '(') arithmetic++
      else if (char === ')') arithmetic--
      text += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#') {
      // Leave the newline for the heredoc flush below: a trailing comment on a
      // heredoc operator's line must not skip the body that follows it.
      const newline = command.indexOf('\n', index)
      if (newline === -1) break
      index = newline - 1
      continue
    }
    if (char === '$' && command[index + 1] === '(' && command[index + 2] === '(') {
      arithmetic = 2
      index += 2
      continue
    }
    if (char === '$' && command[index + 1] === '[') {
      literal = '['; literalDepth = 0; text += char
      continue
    }
    if (char === '$' && command[index + 1] === '{') {
      literal = '{'; literalDepth = 0; text += char
      continue
    }
    if (char === '(' && command[index + 1] === '(') {
      arithmetic = 2
      index += 1
      continue
    }
    if (char === '<') {
      let run = 0
      while (command[index + run] === '<') run++
      if (run === 2) {
        const operator = heredocOperator(command, index)
        if (operator !== undefined) {
          heredocs.push({ delimiter: operator.delimiter, stripTabs: operator.stripTabs })
          index = operator.next - 1
          continue
        }
      } else if (run >= 3) {
        // A here-string `<<<` (or a longer run) is not a heredoc operator.
        text += '<'.repeat(run)
        index += run - 1
        continue
      }
    }
    if (char === '\n' && heredocs.length > 0) {
      const bodyEnd = heredocBodyEnd(command, index + 1, heredocs)
      heredocs.length = 0
      if (bodyEnd !== undefined) {
        text += '\n'
        index = bodyEnd - 1
        continue
      }
      // No complete terminator sequence: the queued operators were not real
      // heredocs, so the text stays commands and a later write is still seen.
    }
    text += char
  }
  return text
}

/**
 * R7-01b: the index just past every queued heredoc body, or undefined when any
 * queued operator has no terminator line. A body starts after the operator's
 * command line and ends at the first line equal to its delimiter; `<<-` strips
 * leading tabs from body and terminator lines. Requiring the terminator keeps a
 * phantom operator (a shift or here-string the scanner misread) from swallowing
 * the rest of the call.
 */
function heredocBodyEnd(command: string, start: number, heredocs: readonly { delimiter: string; stripTabs: boolean }[]): number | undefined {
  let cursor = start
  for (const { delimiter, stripTabs } of heredocs) {
    let found = false
    for (;;) {
      const lineEnd = command.indexOf('\n', cursor)
      const line = command.slice(cursor, lineEnd === -1 ? command.length : lineEnd)
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        cursor = lineEnd === -1 ? command.length : lineEnd + 1
        found = true
        break
      }
      if (lineEnd === -1) break
      cursor = lineEnd + 1
    }
    if (!found) return undefined
  }
  return cursor
}

/**
 * R7-01b: a `<<`/`<<-` operator and its delimiter word, or undefined when the
 * `<<` does not start a heredoc. `<<<` here-strings, arithmetic shifts and the
 * `$[...]`/`${...}` literal spans never reach this function. The delimiter may
 * be a bare shell word (letters, digits, `_`, `-`), single/double quoted or
 * backslash-quoted, and must end at whitespace, a shell operator or `)` (the
 * inline `x=$(cat <<EOF)` form). The body is skipped only when `heredocBodyEnd`
 * finds its terminator line.
 */
function heredocOperator(command: string, start: number): { delimiter: string; stripTabs: boolean; next: number } | undefined {
  let cursor = start + 2
  const stripTabs = command[cursor] === '-'
  if (stripTabs) cursor++
  while (command[cursor] === ' ' || command[cursor] === '\t') cursor++
  let delimiter: string
  const opener = command[cursor]
  if (opener === "'" || opener === '"') {
    const close = command.indexOf(opener, cursor + 1)
    if (close === -1) return undefined
    delimiter = command.slice(cursor + 1, close)
    cursor = close + 1
  } else {
    if (opener === '\\') cursor++
    const word = /^[A-Za-z0-9_][A-Za-z0-9_-]*/.exec(command.slice(cursor))?.[0]
    if (word === undefined) return undefined
    delimiter = word
    cursor += word.length
  }
  if (!delimiter) return undefined
  const after = command[cursor]
  if (after !== undefined && !/[\s;&|<>)]/.test(after)) return undefined
  return { delimiter, stripTabs, next: cursor }
}

/** Global git options that take a separate value token, so the subcommand is one token later. */
const GIT_OPTION_ARGUMENTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env'])

/** Commands that may precede `git` without being the executed program themselves. */
const COMMAND_WRAPPERS = new Set(['env', 'command', 'sudo', 'nohup', 'time', 'exec', 'nice', 'doas', 'builtin'])

/** Wrapper options that consume a separate value token. */
const WRAPPER_OPTION_ARGUMENTS = new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D', '-n', '-f', '-o', '-a', '--user', '--group', '--prompt', '--host', '--other-user', '--role', '--type', '--close-from', '--chdir', '--unset', '--format', '--output', '--adjustment'])

/**
 * R6-I2c: true when tokens[0..index) are only environment assignments and/or
 * known wrappers with their option tokens, so the token at `index` is the
 * executed program. A bare `git` token in another program's arguments
 * (`grep -rn git add .`) is data, never the command.
 */
function atCommandPosition(tokens: string[], index: number): boolean {
  let position = 0
  while (position < index) {
    const token = tokens[position]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { position++; continue }
    if (COMMAND_WRAPPERS.has(token)) { position++; continue }
    if (token.startsWith('-')) {
      const name = token.split('=')[0]!
      position += WRAPPER_OPTION_ARGUMENTS.has(name) && !token.includes('=') && position + 1 < index ? 2 : 1
      continue
    }
    return false
  }
  return true
}

/**
 * R6-02: the git subcommand actually executed at command position, or undefined
 * when the command runs no git write. Only a token at subcommand position
 * counts, so a read-only command that merely mentions a write word in a pattern,
 * path or argument (`git log --grep=commit`, `git grep add`,
 * `git diff --stat | grep reset`) is data and never a denial. R6-I2c: the `git`
 * token itself must sit at command position (assignments and wrappers only
 * before it), so `grep -rn git add .` is data too. Global options and their
 * values are skipped; the R6-01 property (result text never decides) is
 * preserved.
 */
export function gitWriteSubcommand(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    const tokens = segment.map(token => token.text)
    for (let git = 0; git < tokens.length; git++) {
      if (tokens[git] !== 'git' || !atCommandPosition(tokens, git)) continue
      let index = git + 1
      while (index < tokens.length) {
        const token = tokens[index]!
        if (!token.startsWith('-')) break
        index += GIT_OPTION_ARGUMENTS.has(token.split('=')[0]!) && !token.includes('=') ? 2 : 1
      }
      const subcommand = tokens[index]
      if (subcommand !== undefined && GIT_WRITE.test(`git ${subcommand}`)) return subcommand
    }
  }
  return undefined
}

/**
 * A git metadata-write subcommand named on one executed command line. R6-01:
 * read-only and worktree-only subcommands (`apply`, `worktree`, `branch`,
 * `config`, `fetch`, `pull`, `tag`, `stash`) are excluded, because their
 * read-only forms (`git worktree list`, `git apply --reject`) are not sandbox
 * denials and must never latch an attempt.
 */
const GIT_WRITE = /\bgit\b[^\n]{0,200}?\b(commit|add|merge|rebase|cherry-pick|revert|reset|switch|checkout|update-ref|rm|mv|am|push|init|gc|repack)\b/

/**
 * The sandbox's own refusal text. R6-01: retained as the documented refusal
 * vocabulary of the accepted guard artifact, but the denial no longer scans the
 * result, so incidental output text can never claim it or latch an attempt.
 */
const GIT_WRITE_REFUSAL = /index\.lock|Operation not permitted|EPERM/i

/**
 * A mission's recorded workspace is no longer inside a human-authorized root.
 * Distinct from an ordinary preparation failure because it is terminal for this
 * host process: the mission is fenced immediately instead of spending recovery
 * credit, and the owner is woken with the durable reason.
 */
export class WorkspaceRevokedError extends Error {
  readonly code = 'workspace_revoked'
  constructor(readonly diagnostic: string) { super(diagnostic); this.name = 'WorkspaceRevokedError' }
}

export class WorkspaceAdmission {
  /** R11-15: bounded per-path mention history and reported-pair bookkeeping. */
  private readonly tempMentions = new Map<string, TempMention[]>()
  private readonly tempRendezvousReported = new Map<string, number>()

  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * The runtime-side half of the workspace authorization boundary. `create` is
   * synchronous, so the full realpath check happened at admission; here the
   * runtime proves the recorded workspace really resolves inside the root the
   * admission site reported, so a caller that fabricates a wider
   * `workspaceGrantRoot` cannot widen its own authorization. When the plugin
   * installed `config.authorizeWorkspace`/`config.grants`, the workspace must
   * also still sit inside a root that is currently loaded and unexpired.
   */
  assertAuthorizedRoot(workspace: string, grantRoot: string | undefined, source?: 'session' | 'grant'): { grantRoot: string; source: 'session' | 'grant' } {
    const claimed = grantRoot ?? workspace
    if (!isContained(claimed, workspace)) throw new Error(`Mission workspace ${workspace} is not inside its reported authorized root ${claimed} [${WORKSPACE_AUTHORIZATION_CODE}]`)
    const grants = this.rt.config.grants
    if (this.rt.config.authorizeWorkspace === undefined || grants === undefined) return { grantRoot: claimed, source: source ?? (claimed === workspace ? 'session' : 'grant') }
    const now = Date.now()
    // A session authorization wins over a root that happens to contain the
    // session cwd: the human authorized that directory directly, so removing a
    // root must not fence it. The admission site computed this source.
    if (source === 'session' && claimed === workspace) return { grantRoot: workspace, source: 'session' }
    // The recorded root is the configured root that actually contains the
    // workspace — never the caller's claim. A caller that fabricates a wider
    // root therefore cannot record it, and a fabricated narrower root is
    // refused by the containment check above.
    const matched = grants.grants
      .filter(grant => isContained(grant.path, workspace) && (grant.expiresAt === undefined || grant.expiresAt > now))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (matched !== undefined) return { grantRoot: matched.path, source: 'grant' }
    if (claimed === workspace) return { grantRoot: claimed, source: source ?? 'session' }
    throw new Error(`Mission workspace ${workspace} is not inside a currently authorizedWorkspaces root [${WORKSPACE_AUTHORIZATION_CODE}]`)
  }

  /**
   * Re-validate a recorded mission against the human authorization loaded at
   * start. Returns without error when this runtime has no authorization
   * predicate (unit runtimes and adapters without Git). Otherwise the mission's
   * own durable `workspaceGrantRoot` anchors the check: a session workspace
   * stays authorized exactly while it still resolves to itself, and a
   * grant-bound mission stays authorized only while that same root is still
   * configured and unexpired. Removing a root therefore fences the mission at
   * its next prepare or verification checkout.
   */
  async assertWorkspaceAuthorized(mission: Pick<Mission, 'id' | 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>): Promise<void> {
    const authorize = this.rt.config.authorizeWorkspace
    if (authorize === undefined) return
    const anchor = mission.workspaceGrantRoot
    // A mission recorded before this feature has no anchor; its workspace is its
    // own anchor, which is exactly the pre-feature session-cwd authorization.
    if (anchor === undefined) return
    const resolved = await realpath(mission.workspace).catch(() => undefined)
    const root = await realpath(anchor).catch(() => undefined)
    let diagnostic: string | undefined
    if (resolved === undefined) diagnostic = `Authorized workspace ${mission.workspace} no longer exists or cannot be resolved [${WORKSPACE_AUTHORIZATION_CODE}]`
    else if (root === undefined || !isContained(root, resolved)) diagnostic = `Workspace ${mission.workspace} escaped its recorded authorized root ${anchor} [${WORKSPACE_AUTHORIZATION_CODE}]`
    else {
      // X3: the configured predicate decides first. A recorded root that is
      // still a live configured grant authorizes the mission even when the
      // record omitted its source; an explicit 'session' record authorizes a
      // workspace that is its own root; anything else — including a missing
      // source on a root that is no longer configured — fails closed, because
      // it could be a revoked grant whose root happens to equal the workspace.
      const live = await authorize(mission.workspace, undefined)
      const liveGrant = live.ok && live.grantRoot === root
      const sessionWorkspace = resolved === root && mission.workspaceAuthorizationSource === 'session'
      if (!liveGrant && !sessionWorkspace) diagnostic = `Authorized root ${anchor} was removed from authorizedWorkspaces or has expired; restart with the root restored to continue [${WORKSPACE_AUTHORIZATION_CODE}]`
    }
    if (diagnostic !== undefined) { this.fenceWorkspace(mission.id, diagnostic); throw new WorkspaceRevokedError(diagnostic) }
  }

  /**
   * Fence a mission whose human authorization was withdrawn: block every
   * schedulable task with the durable reason, record the revocation event, and
   * wake the owner once. Revocation is terminal for this host process
   * (restoring the root requires a human config edit and restart), so it does
   * not spend recovery credit the way a transient preparation failure does.
   */
  fenceWorkspace(missionId: string, reason: string): void {
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined || this.rt.isMissionTerminal(mission)) return
    if (this.rt.store.events(missionId, 1000).some(event => event.type === 'mission/workspace-revoked')) return
    const blocked = this.rt.store.list('tasks', missionId).filter(task => task.status === 'pending' || task.status === 'running')
    this.rt.commit(missionId, () => {
      for (const task of blocked) {
        task.status = 'blocked'; task.output = reason; task.epoch++; this.rt.store.put('tasks', task)
        this.rt.store.event(missionId, 'task/blocked', 'runtime', { taskId: task.id, reason })
      }
      this.rt.store.event(missionId, 'mission/workspace-revoked', 'runtime', { workspace: mission.workspace, grantRoot: mission.workspaceGrantRoot, reason, blockedTasks: blocked.map(task => task.id) })
    })
    this.rt.notify(missionId, reason)
  }

  /**
   * A worker-side git write that the sandbox refused (index.lock EPERM). Only a
   * shell-executing tool runs a command line, so only its executed command is
   * inspected; a quoted span that merely names a git-write phrase (a search
   * pattern, an edit body, a message) is data, never a denial and never a latch,
   * and a successful command is never a denial. R6-01: the result text is not
   * inspected either, because a failed command that merely prints the refusal
   * phrase is not a sandbox refusal; a denial is a failed run of an executed
   * metadata-write command. R6-02: the subcommand must sit at command position
   * in one shell segment, so a write word mentioned in a pattern or path is data
   * even when the command fails. A command hidden inside a nested shell string
   * is not seen: the sandbox still blocks it and the worker sees the raw refusal.
   */
  deniedGitWrite(input: { tool: string; arguments: unknown; result: unknown; isError: boolean }): string | undefined {
    const command = executedShellCommand(input.tool, input.arguments)
    if (command === undefined || !input.isError || gitWriteSubcommand(unquotedShellText(command)) === undefined) return undefined
    return command.length > 200 ? `${command.slice(0, 200)}…` : command
  }

  /**
   * R11-15: detect one member naming a shared temp path another member already
   * named inside the window. Bookkeeping is bounded and in-memory; the durable
   * `isolation/temp-rendezvous` event (and the owner notice) is the audit row,
   * and it appears in the bounded observe event window.
   */
  tempRendezvous(memberId: string, taskId: string, input: { tool: string; arguments: unknown }): { path: string; first: TempMention; second: TempMention } | undefined {
    const paths = sharedTempPaths(input)
    if (!paths.length) return undefined
    const now = Date.now()
    let report: { path: string; first: TempMention; second: TempMention } | undefined
    for (const path of paths) {
      const fresh = (this.tempMentions.get(path) ?? []).filter(mention => now - mention.at <= TEMP_RENDEZVOUS_WINDOW_MS)
      const other = tempRendezvousDecision(fresh, memberId, now)
      if (other !== undefined) {
        const key = [path, ...[other.memberId, memberId].sort()].join('|')
        const reportedAt = this.tempRendezvousReported.get(key)
        if (reportedAt === undefined || now - reportedAt > TEMP_RENDEZVOUS_WINDOW_MS) {
          this.tempRendezvousReported.set(key, now)
          report ??= { path, first: other, second: { memberId, taskId, at: now } }
        }
      }
      fresh.push({ memberId, taskId, at: now })
      this.tempMentions.set(path, fresh.slice(-TEMP_RENDEZVOUS_MAX_MENTIONS))
    }
    while (this.tempMentions.size > TEMP_RENDEZVOUS_MAX_PATHS) {
      const oldest = this.tempMentions.keys().next().value
      if (oldest === undefined) break
      this.tempMentions.delete(oldest)
    }
    for (const [key, at] of this.tempRendezvousReported) if (now - at > TEMP_RENDEZVOUS_WINDOW_MS) this.tempRendezvousReported.delete(key)
    return report
  }

  /** The isolation precondition for one dispatch: refuse the member and record why when it fails. */
  isolationAllows(missionId: string, member: Member): boolean {
    const violation = this.isolationViolations(missionId).find(entry => entry.includes(member.id))
    if (violation !== undefined) { this.rt.refuseIsolation(missionId, member, violation); return false }
    // Change-and-return: a repaired board forgets the refusal key, so the same
    // violation recurring later wakes the owner again instead of staying silent.
    const mission = this.rt.store.get('missions', missionId)
    if (mission?.isolationRefusal !== undefined) {
      delete mission.isolationRefusal
      this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
    }
    return true
  }

  /**
   * S7: the isolation invariant, decided from durable state only.
   *  - live workers ≤ provisioned isolated worktrees: every non-stopped member
   *    owns a provisioned workspace and no two live members share one, so the
   *    number of worker handles the runtime may hold can never exceed the number
   *    of distinct isolated worktrees;
   *  - two concurrently running tasks that share one isolated worktree must
   *    declare disjoint scope: the dispatch path admits at most one running task
   *    per worktree and refuses a second whose scope overlaps.
   * This asserts the isolation the runtime already has; it never weakens
   * per-member worktrees, it refuses a dispatch that would lose them.
   */
  isolationViolations(missionId: string): string[] {
    const violations: string[] = []
    const members = this.rt.store.list('members', missionId).filter(member => member.status !== 'stopped')
    const byWorkspace = new Map<string, Member[]>()
    for (const member of members) {
      if (!member.workspace) { violations.push(`member ${member.id} (${member.name}) has no provisioned isolated worktree`); continue }
      byWorkspace.set(member.workspace, [...(byWorkspace.get(member.workspace) ?? []), member])
    }
    for (const [workspace, group] of byWorkspace) {
      if (group.length > 1) violations.push(`live workers ${group.map(member => member.id).join(', ')} share one provisioned worktree (${workspace}); live workers must never exceed provisioned worktrees`)
    }
    const running = this.rt.store.list('tasks', missionId).filter(task => task.status === 'running' && task.attempt !== undefined)
    const byTaskWorkspace = new Map<string, Task[]>()
    for (const task of running) {
      const owner = this.rt.store.get('members', task.attempt!.ownerId)
      if (owner === undefined || owner.status === 'stopped') { violations.push(`running task ${task.id} has no live owner (${task.attempt!.ownerId})`); continue }
      byTaskWorkspace.set(owner.workspace, [...(byTaskWorkspace.get(owner.workspace) ?? []), task])
    }
    for (const [workspace, group] of byTaskWorkspace) {
      if (group.length > 1) violations.push(`concurrently running tasks ${group.map(task => task.id).join(', ')} share worktree ${workspace}`)
      for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) {
          if (this.rt.scopesOverlap(group[left]!.scope, group[right]!.scope)) {
            violations.push(`concurrently running tasks ${group[left]!.id} and ${group[right]!.id} declare overlapping scope in worktree ${workspace}`)
          }
        }
      }
    }
    return violations
  }
}
