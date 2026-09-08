/** Owned Git worktrees and immutable artifacts. The source checkout is read-only. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withinScope } from './scope.js'
import { captureGitSnapshot } from './git-snapshot.js'
import type { Artifact, Member, Mission, Task, WorkspaceBaseline } from './types.js'

export interface CheckResult { command: string; exitCode: number; output: string }
export interface WorkspaceOptions {
  workspacesRoot: string
  checkTimeoutMs: number
  maxCheckOutputBytes: number
  checkEnv?: Record<string, string>
  /** Required in production: wrap checks in the host's execution confinement. */
  confineCheck(argv: string[], cwd: string): Promise<string[]> | string[]
}
interface MissionWorkspace { version: 1; missionId: string; source: string; baseCommit: string; baseline?: WorkspaceBaseline }
interface TaskBase { taskId: string; epoch: number; baseCommit: string; capturedCommit?: string }
interface MemberWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task?: TaskBase }
interface TaskWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task: TaskBase }
interface ProcessOptions { cwd: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: Record<string, string> }

/** Execute an argv with bounded output and a cancellation-owned process group. */
export async function runProcess(argv: readonly string[], options: ProcessOptions): Promise<{ exitCode: number; output: string; truncated: boolean }> {
  if (argv.length === 0 || !argv[0]) throw new Error('An executable is required')
  options.signal?.throwIfAborted()
  if (process.platform === 'win32') throw new Error('Swarm worktree execution currently requires POSIX process groups')
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    })
    let bytes = 0
    let truncated = false
    const chunks: Buffer[] = []
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    const cancel = (error: Error): void => {
      failure ??= error
      killGroup('SIGTERM')
      killTimer ??= setTimeout(() => { killGroup('SIGKILL') }, 300)
    }
    const onAbort = (): void => { cancel(new Error('Execution cancelled', { cause: options.signal?.reason })) }
    const timer = setTimeout(() => { cancel(new Error(`Execution timed out after ${options.timeoutMs}ms`)) }, options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const append = (chunk: Buffer): void => {
      const available = Math.max(0, options.maxBytes - bytes)
      if (chunk.length > available) truncated = true
      if (available > 0) { const kept = chunk.subarray(0, available); chunks.push(kept); bytes += kept.length }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', error => { failure ??= error })
    child.on('close', code => {
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      // A check may leave background descendants. Its owned process group ends here.
      killGroup('SIGKILL')
      if (failure !== undefined) { reject(failure); return }
      let output = Buffer.concat(chunks).toString('utf8')
      if (truncated) {
        const marker = '\n[output truncated]'
        output = Buffer.from(output).subarray(0, Math.max(0, options.maxBytes - Buffer.byteLength(marker))).toString('utf8')
        while (Buffer.byteLength(output + marker) > options.maxBytes) output = output.slice(0, -1)
        output += marker
      }
      resolve({ exitCode: code ?? 1, output, truncated })
    })
    if (options.signal?.aborted) onAbort()
  })
}

function segment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(value)) throw new Error('Invalid workspace identity')
  return value
}
async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
/** Atomic private metadata replacement; never places metadata inside an editable worktree. */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }) }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function commitId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) }

/** Owns worktrees beneath one configured directory and never resets the source checkout. */
export class Workspaces {
  readonly root: string
  private readonly controllers = new Map<string, Set<AbortController>>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly baselines = new Map<string, Promise<WorkspaceBaseline>>()
  private closing = false

  constructor(private readonly options: WorkspaceOptions) {
    this.root = path.resolve(options.workspacesRoot)
    if (!Number.isSafeInteger(options.checkTimeoutMs) || options.checkTimeoutMs < 1) throw new Error('checkTimeoutMs must be positive')
    if (!Number.isSafeInteger(options.maxCheckOutputBytes) || options.maxCheckOutputBytes < 64) throw new Error('maxCheckOutputBytes must be at least 64')
  }

  private missionDir(missionId: string): string { return path.join(this.root, segment(missionId)) }
  metadataPath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), `${segment(memberId)}.worker.json`) }
  private memberPath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), `${segment(memberId)}.workspace.json`) }
  private taskPath(missionId: string, taskId: string): string { return path.join(this.missionDir(missionId), 'tasks', `${segment(taskId)}.json`) }
  private async git(cwd: string, args: string[], signal?: AbortSignal, overrides?: Record<string, string>, maxBytes = this.options.maxCheckOutputBytes): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
    const result = await runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Agent Swarm', '-c', 'user.email=swarm@localhost', ...args], { cwd, timeoutMs: this.options.checkTimeoutMs, maxBytes, env: { ...env, ...overrides, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, ...(signal === undefined ? {} : { signal }) })
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.output.trim()}`)
    if (result.truncated) throw new Error(`git ${args[0]} output exceeded the configured limit; refusing incomplete artifact inspection`)
    return args.includes('-z') ? result.output : result.output.trim()
  }

  private operation<T>(memberId: string, callback: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Workspace manager is disposed'))
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal?.reason) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const active = this.controllers.get(memberId) ?? new Set<AbortController>()
    this.controllers.set(memberId, active)
    active.add(controller)
    const work = callback(controller.signal)
    this.inFlight.add(work)
    void work.finally(() => { signal?.removeEventListener('abort', abort); active.delete(controller); if (active.size === 0) this.controllers.delete(memberId); this.inFlight.delete(work) }).catch(() => undefined)
    return work
  }

  private async missionRecord(missionId: string): Promise<MissionWorkspace> {
    const value = await readJson(path.join(this.missionDir(missionId), 'mission.json'))
    if (!isRecord(value) || value.version !== 1 || value.missionId !== missionId || typeof value.source !== 'string' || !commitId(value.baseCommit)) throw new Error('Invalid or missing mission workspace metadata')
    let baseline: WorkspaceBaseline | undefined
    if (value.baseline !== undefined) {
      const saved = value.baseline
      if (!isRecord(saved) || !commitId(saved.sourceHead) || saved.snapshotCommit !== value.baseCommit || typeof saved.planningWorkspace !== 'string' || !Array.isArray(saved.changedPaths) || saved.changedPaths.some(item => typeof item !== 'string') || !Number.isSafeInteger(saved.createdAt)) throw new Error('Invalid mission snapshot metadata')
      baseline = { sourceHead: saved.sourceHead, snapshotCommit: value.baseCommit, planningWorkspace: saved.planningWorkspace, changedPaths: saved.changedPaths as string[], createdAt: saved.createdAt as number }
    }
    return { version: 1, missionId, source: value.source, baseCommit: value.baseCommit, ...(baseline === undefined ? {} : { baseline }) }
  }

  /** Freeze one source baseline before planning; all members and restarts reuse it. */
  async prepareBaseline(mission: Pick<Mission, 'id' | 'workspace'>, signal?: AbortSignal): Promise<WorkspaceBaseline> {
    signal?.throwIfAborted()
    const existing = this.baselines.get(mission.id)
    if (existing !== undefined) {
      const baseline = await existing
      signal?.throwIfAborted()
      if ((await this.missionRecord(mission.id)).source !== await realpath(mission.workspace)) throw new Error('Mission source workspace changed')
      return baseline
    }
    const pending = this.operation(`baseline-${mission.id}`, async ownedSignal => {
      const source = await realpath(mission.workspace)
      const relativeRoot = path.relative(source, this.root)
      if (relativeRoot === '' || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot))) throw new Error('Swarm snapshot storage must be outside the source repository')
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if (await realpath(this.root) !== this.root) throw new Error('workspacesRoot must be canonical, without symlinks')
      if (await this.git(source, ['rev-parse', '--show-toplevel'], ownedSignal) !== source) throw new Error('Mission workspace must be the Git repository root')
      const manifest = path.join(this.missionDir(mission.id), 'mission.json')
      const planningWorkspace = path.join(this.missionDir(mission.id), 'planning')
      let record: MissionWorkspace
      if (await readJson(manifest) === undefined) {
        // Full repository path inventories need a metadata bound independent
        // of the much smaller user-visible check-output retention limit.
        const snapshot = await captureGitSnapshot(source, this.missionDir(mission.id), (args, env) => this.git(source, args, ownedSignal, env, 16 * 1024 * 1024), ownedSignal)
        record = { version: 1, missionId: mission.id, source, baseCommit: snapshot.snapshotCommit, baseline: { ...snapshot, planningWorkspace } }
        await writePrivateJson(manifest, record)
      } else record = await this.missionRecord(mission.id)
      if (record.source !== source) throw new Error('Mission source workspace changed')
      // Older manifests must retain their original baseline even if the source
      // now has unrelated edits. Add only the planning-view metadata.
      const baseline = record.baseline ?? { sourceHead: record.baseCommit, snapshotCommit: record.baseCommit, planningWorkspace, changedPaths: [], createdAt: Date.now() }
      if (baseline.planningWorkspace !== planningWorkspace) throw new Error('Planning workspace is outside its owned mission directory')
      // Persist the baseline identity before its ref/checkout. Interrupted
      // publication resumes that exact commit, never another source snapshot.
      await this.git(source, ['update-ref', `refs/swarm/${segment(mission.id)}/baseline`, baseline.snapshotCommit], ownedSignal)
      const exists = await realpath(planningWorkspace).then(value => value, error => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (exists === undefined) {
        await mkdir(path.dirname(planningWorkspace), { recursive: true, mode: 0o700 })
        await this.git(source, ['worktree', 'add', '--detach', planningWorkspace, baseline.snapshotCommit], ownedSignal)
      } else if (exists !== planningWorkspace || await this.git(planningWorkspace, ['rev-parse', 'HEAD^{commit}'], ownedSignal) !== baseline.snapshotCommit || await this.git(planningWorkspace, ['status', '--porcelain=v1', '--untracked-files=all'], ownedSignal)) throw new Error('Planning snapshot checkout was changed; restore the saved snapshot before continuing')
      if (record.baseline === undefined) await writePrivateJson(manifest, { ...record, baseline })
      return baseline
    }, signal)
    this.baselines.set(mission.id, pending)
    try { return await pending }
    finally { if (this.baselines.get(mission.id) === pending) this.baselines.delete(mission.id) }
  }

  private async memberRecord(member: Pick<Member, 'missionId' | 'id' | 'workspace'>): Promise<MemberWorkspace> {
    const value = await readJson(this.memberPath(member.missionId, member.id))
    const expected = path.join(this.missionDir(member.missionId), 'members', segment(member.id))
    if (!isRecord(value) || value.version !== 1 || value.memberId !== member.id || value.missionId !== member.missionId || value.workspace !== expected || path.resolve(member.workspace) !== expected) throw new Error('Workspace is not owned by this swarm member')
    const actual = await realpath(expected)
    if (actual !== expected) throw new Error('Swarm worktrees must not be replaced with symlinks')
    if (await this.git(expected, ['rev-parse', '--show-toplevel']) !== expected) throw new Error('Member workspace is no longer its owned Git worktree')
    const record: MemberWorkspace = { version: 1, memberId: member.id, missionId: member.missionId, workspace: expected }
    if (value.task !== undefined) {
      const task = value.task
      if (!isRecord(task) || typeof task.taskId !== 'string' || !Number.isSafeInteger(task.epoch) || !commitId(task.baseCommit)) throw new Error('Invalid persisted task baseline')
      if (task.capturedCommit !== undefined && !commitId(task.capturedCommit)) throw new Error('Invalid persisted captured commit')
      record.task = { taskId: task.taskId, epoch: task.epoch as number, baseCommit: task.baseCommit, ...(typeof task.capturedCommit === 'string' ? { capturedCommit: task.capturedCommit } : {}) }
    }
    const mission = await this.missionRecord(member.missionId)
    const common = async (cwd: string): Promise<string> => await realpath(path.resolve(cwd, await this.git(cwd, ['rev-parse', '--git-common-dir'])))
    if (await common(expected) !== await common(mission.source)) throw new Error('Member Git repository identity changed')
    return record
  }

  async prepareWorkspace(mission: Mission, memberId: string): Promise<string> {
    await this.prepareBaseline(mission)
    return await this.operation(memberId, async signal => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if (await realpath(this.root) !== this.root) throw new Error('workspacesRoot must be canonical, without symlinks')
      const source = await realpath(mission.workspace)
      if (await this.git(source, ['rev-parse', '--show-toplevel'], signal) !== source) throw new Error('Mission workspace must be the Git repository root')
      const saved = await this.missionRecord(mission.id)
      if (saved.source !== source) throw new Error('Mission source workspace changed')
      const workspace = path.join(this.missionDir(mission.id), 'members', segment(memberId))
      if (await readJson(this.memberPath(mission.id, memberId)) !== undefined) {
        await this.memberRecord({ missionId: mission.id, id: memberId, workspace })
        return workspace
      }
      await mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 })
      await this.git(source, ['worktree', 'add', '--detach', workspace, saved.baseCommit], signal)
      await writePrivateJson(this.memberPath(mission.id, memberId), { version: 1, missionId: mission.id, memberId, workspace } satisfies MemberWorkspace)
      return workspace
    })
  }

  async prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task): Promise<void> {
    await this.operation(member.id, async signal => {
      const record = await this.memberRecord(member)
      if (task.reviewOf !== undefined) {
        if (reviewSource?.id !== task.reviewOf || reviewSource.missionId !== task.missionId || reviewSource.status !== 'submitted' || reviewSource.artifact === undefined) throw new Error('Verification requires its exact submitted review source artifact')
        await this.validateArtifact(member, reviewSource.artifact)
      } else if (reviewSource !== undefined) throw new Error('Only a verification task can name a review source')
      const taskOwner = await readJson(this.taskPath(member.missionId, task.id))
      const ownsRecovery = taskOwner === undefined || (isRecord(taskOwner) && taskOwner.memberId === member.id)
      const sameReview = reviewSource === undefined || record.task?.baseCommit === reviewSource.artifact?.commit
      if (sameReview && ownsRecovery && record.task?.taskId === task.id && record.task.epoch === task.epoch) return
      if (sameReview && ownsRecovery && record.task?.taskId === task.id) {
        if (record.task.epoch > task.epoch) throw new Error('Task attempt is older than the prepared workspace')
        // Same-task recovery keeps both committed and uncommitted progress. The
        // runtime must stop the previous attempt before preparing its replacement.
        record.task.epoch = task.epoch
        await this.saveTaskWorkspace(record)
        return
      }
      if ((await this.git(member.workspace, ['status', '--porcelain=v1', '--untracked-files=all'], signal)).length > 0) throw new Error('Member workspace has uncommitted work; submit or resolve it before starting another task')
      const previousHead = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
      if (record.task !== undefined && previousHead !== (record.task.capturedCommit ?? record.task.baseCommit)) throw new Error('Member has unsubmitted commits; capture them before preparing another task')
      // Each task starts only with the mission base and explicitly accepted dependencies.
      // Captured task commits have durable Git refs; a rejected experiment cannot leak in.
      const mission = await this.missionRecord(member.missionId)
      const recovery = reviewSource === undefined ? await this.recoverTask(member, task) : undefined
      const reviewCommit = reviewSource?.artifact?.commit
      try {
        await this.git(member.workspace, ['checkout', '--detach', reviewCommit ?? recovery?.commit ?? mission.baseCommit], signal)
        if (recovery === undefined && reviewCommit === undefined) for (const dependency of dependencies) {
          if (dependency.status !== 'accepted') throw new Error(`Dependency ${dependency.id} is not accepted`)
          if (dependency.artifact === undefined) {
            if (dependency.kind === 'implementation' || dependency.kind === 'integration') throw new Error(`Dependency ${dependency.id} has no immutable artifact`)
            continue
          }
          await this.validateArtifact(member, dependency.artifact)
          try { await this.git(member.workspace, ['merge', '--no-edit', '--no-ff', dependency.artifact.commit], signal) }
          catch (error) { throw new Error(`Dependency integration conflict for ${dependency.id}: ${String(error)}`) }
        }
        record.task = { taskId: task.id, epoch: task.epoch, baseCommit: recovery?.baseCommit ?? await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal) }
        await this.saveTaskWorkspace(record)
      } catch (error) {
        // Entry required a clean owned checkout; rollback restores exactly that
        // state and leaves all captured commits reachable through swarm refs.
        await this.git(member.workspace, ['merge', '--abort']).catch(() => undefined)
        await this.git(member.workspace, ['reset', '--hard', previousHead])
        throw error
      }
    })
  }

  private async saveTaskWorkspace(record: MemberWorkspace): Promise<void> {
    await writePrivateJson(this.memberPath(record.missionId, record.memberId), record)
    if (record.task !== undefined) await writePrivateJson(this.taskPath(record.missionId, record.task.taskId), { ...record, task: record.task } satisfies TaskWorkspace)
  }

  /** Carry a previous owner's quiescent partial work into a replacement attempt. */
  private async recoverTask(member: Member, task: Task): Promise<Pick<Artifact, 'commit' | 'baseCommit'> | undefined> {
    const value = await readJson(this.taskPath(member.missionId, task.id))
    if (value === undefined) return undefined
    if (!isRecord(value) || value.version !== 1 || value.missionId !== member.missionId || typeof value.memberId !== 'string' || typeof value.workspace !== 'string' || !isRecord(value.task) || value.task.taskId !== task.id || !Number.isSafeInteger(value.task.epoch) || !commitId(value.task.baseCommit)) throw new Error('Invalid task recovery metadata')
    if (Number(value.task.epoch) >= task.epoch) throw new Error('Task workspace is already owned by this or a newer attempt')
    const prior = await this.memberRecord({ id: value.memberId, missionId: member.missionId, workspace: value.workspace })
    if (prior.task?.taskId === task.id) {
      // Task scoping is checked before committing partial work. The old worktree
      // is preserved if that check fails; no partial change is silently dropped.
      return await this.captureArtifact({ ...member, id: value.memberId, workspace: value.workspace }, { ...task, epoch: prior.task.epoch })
    }
    if (!commitId(value.task.capturedCommit)) throw new Error('Previous task workspace has moved on without an immutable checkpoint')
    return { commit: value.task.capturedCommit, baseCommit: value.task.baseCommit }
  }

  private async validateArtifact(member: Member, artifact: Artifact): Promise<void> {
    if (!commitId(artifact.commit) || !commitId(artifact.baseCommit)) throw new Error('Artifact requires exact commit hashes')
    const mission = await this.missionRecord(member.missionId)
    await this.git(mission.source, ['cat-file', '-e', `${artifact.commit}^{commit}`])
    await this.git(mission.source, ['merge-base', '--is-ancestor', artifact.baseCommit, artifact.commit])
    await this.git(mission.source, ['merge-base', '--is-ancestor', mission.baseCommit, artifact.commit])
  }

  async captureArtifact(member: Member, task: Task): Promise<Artifact> {
    return await this.operation(member.id, async signal => {
      const record = await this.memberRecord(member)
      if (record.task?.taskId !== task.id || record.task.epoch !== task.epoch) throw new Error('Task has no matching prepared workspace baseline')
      const baseCommit = record.task.baseCommit
      // Include tracked changes, staged changes, and new files before any commit.
      const changed = new Set((await this.git(member.workspace, ['diff', '--name-only', '-z', baseCommit, '--'], signal)).split('\0').filter(Boolean))
      for (const name of (await this.git(member.workspace, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean)) changed.add(name)
      for (const name of changed) if (!withinScope(name, task.scope)) throw new Error(`Artifact changes path outside task scope: ${name}`)
      await this.git(member.workspace, ['add', '--all', '--', '.'], signal)
      const staged = await this.git(member.workspace, ['diff', '--cached', '--name-only', '-z'], signal)
      if (staged.length > 0) await this.git(member.workspace, ['commit', '--no-verify', '-m', `swarm: ${task.title.slice(0, 160)}`], signal)
      const commit = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
      await this.git(member.workspace, ['merge-base', '--is-ancestor', baseCommit, commit], signal)
      const changedPaths = (await this.git(member.workspace, ['diff', '--name-only', '-z', baseCommit, commit, '--'], signal)).split('\0').filter(Boolean)
      for (const name of changedPaths) if (!withinScope(name, task.scope)) throw new Error(`Committed artifact changes path outside task scope: ${name}`)
      await this.git(member.workspace, ['update-ref', `refs/swarm/${segment(member.missionId)}/${segment(task.id)}/${task.epoch}`, commit], signal)
      record.task.capturedCommit = commit
      await this.saveTaskWorkspace(record)
      return { commit, baseCommit, workspace: member.workspace, changedPaths }
    })
  }

  async verifyArtifact(member: Member, task: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    return await this.operation(member.id, async signal => {
      await this.memberRecord(member)
      await this.validateArtifact(member, artifact)
      const mission = await this.missionRecord(member.missionId)
      const checkout = path.join(this.missionDir(member.missionId), 'verification', randomUUID())
      await mkdir(path.dirname(checkout), { recursive: true, mode: 0o700 })
      await this.git(mission.source, ['worktree', 'add', '--detach', checkout, artifact.commit], signal)
      try {
        const results: CheckResult[] = []
        for (const command of task.checks) {
          signal.throwIfAborted()
          const argv = await this.options.confineCheck(['/bin/sh', '-c', command], checkout)
          const result = await runProcess(argv, { cwd: checkout, signal, timeoutMs: task.checkTimeoutMs ?? this.options.checkTimeoutMs, maxBytes: this.options.maxCheckOutputBytes, env: this.options.checkEnv })
          results.push({ command, ...result })
          if (result.exitCode !== 0) break
        }
        return results
      } finally { await this.git(mission.source, ['worktree', 'remove', '--force', checkout]) }
    }, signal)
  }

  /** Cancel member-owned artifact/check subprocesses; worker cancellation belongs to the adapter. */
  cancel(memberId: string): void { for (const controller of this.controllers.get(memberId) ?? []) controller.abort('member stopped') }

  /** Preserve mission worktrees as deliverables, while draining all owned execution. */
  async dispose(): Promise<void> {
    this.closing = true
    for (const active of this.controllers.values()) for (const controller of active) controller.abort('adapter disposed')
    await Promise.allSettled([...this.inFlight])
  }
}
