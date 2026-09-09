/**
 * Human-authorized workspace roots.
 *
 * The round-1 H4 guarantee is preserved by moving the authorization surface
 * *outside* the model's tool surface: a mission workspace is accepted only when
 * it equals the calling session's cwd, or when it is inside a root loaded once
 * from plugin configuration at plugin start. No model-callable tool creates,
 * widens or revokes a root — the only way to change the set is a human editing
 * the profile/`cordis.patch.yml` and restarting the host.
 *
 * This module is deliberately free of any dependency on the runtime, the store
 * or the tool registry: it is the pure authorization predicate every admission
 * and re-validation site shares, so no call site can quietly weaken it.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

/** One human-configured root. `note` and `expiresAt` are audit metadata only. */
export interface WorkspaceGrant {
  /** Absolute configured root, exactly as the human wrote it. */
  path: string
  /** Human-readable reason shown in the audit event; never consulted by the check. */
  note?: string
  /** Absolute epoch milliseconds after which the root is no longer consulted. */
  expiresAt?: number
}

/**
 * The roots as loaded once at start. `loadedAt` makes the "loaded once"
 * property auditable; `unresolved` names configured roots that do not resolve
 * or were already expired at start (a root must exist to authorize anything).
 */
export interface WorkspaceGrantSnapshot {
  grants: readonly WorkspaceGrant[]
  loadedAt: number
  unresolved: readonly string[]
}

/** Why a workspace was accepted; `session` means the calling session's own cwd. */
export type WorkspaceAuthorizationSource = 'session' | 'grant'

export interface WorkspaceAuthorized {
  ok: true
  /** Canonical (symlink-resolved) workspace recorded on the mission. */
  workspace: string
  source: WorkspaceAuthorizationSource
  /**
   * The matched root recorded durably as `mission.workspaceGrantRoot`: the
   * session cwd for a session workspace, the configured root otherwise.
   */
  grantRoot: string
  /** The configured grant that matched, when the source is a grant. */
  grant?: WorkspaceGrant
}

export interface WorkspaceRefused {
  ok: false
  /** Field-level diagnostic naming the authorization requirement and its repair. */
  diagnostic: string
}

export type WorkspaceAuthorization = WorkspaceAuthorized | WorkspaceRefused

/**
 * The refusal diagnostic is a stable, machine-checkable field-level message:
 * it names the authorization requirement and how a human grants it, and it is
 * never a bare cwd-equality error. The leading sentence is retained verbatim
 * from the round-1 H4 message so existing refusal assertions stay exact.
 */
export const WORKSPACE_AUTHORIZATION_CODE = 'workspace_not_authorized'
export const WORKSPACE_AUTHORIZATION_REQUIREMENT = 'Plan workspace must match the selected session workspace or be inside an authorizedWorkspaces root configured by the human in this plugin\u2019s configuration (authorizedWorkspaces: [{ path, note?, expiresAt? }]); no model tool can grant a root, and a grant change requires editing the configuration and restarting the host.'

/** True when `candidate` is `root` itself or a descendant of it (no prefix confusion). */
export function isContained(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}

/** The configured roots as one audit string; never claims whether they exist. */
function configuredRoots(loaded: WorkspaceGrantSnapshot): string {
  return loaded.grants.length === 0 ? 'none configured' : loaded.grants.map(grant => grant.path).join(', ')
}

/** The refused-path diagnostic for one requested workspace. */
export function workspaceAuthorizationDiagnostic(requested: string, loaded: WorkspaceGrantSnapshot, detail?: string): string {
  return `${WORKSPACE_AUTHORIZATION_REQUIREMENT} [${WORKSPACE_AUTHORIZATION_CODE}] requested=${requested} configuredRoots=${configuredRoots(loaded)}${detail === undefined ? '' : ` (${detail})`}`
}

/**
 * Validate and load the configured roots once. A configured path must be
 * absolute and must resolve at start; an expired grant is dropped (and named in
 * `unresolved` so the audit shows why) rather than silently kept.
 */
export async function loadWorkspaceGrants(configured: readonly WorkspaceGrant[] | undefined, now = Date.now()): Promise<WorkspaceGrantSnapshot> {
  const grants: WorkspaceGrant[] = []
  const unresolved: string[] = []
  for (const grant of configured ?? []) {
    if (typeof grant?.path !== 'string' || grant.path.trim() === '' || !isAbsolute(grant.path)) throw new Error('authorizedWorkspaces paths must be absolute')
    if (grant.note !== undefined && (typeof grant.note !== 'string' || grant.note.trim() === '')) throw new Error('authorizedWorkspaces note must be a non-empty string')
    if (grant.expiresAt !== undefined && (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0)) throw new Error('authorizedWorkspaces expiresAt must be a positive epoch-millisecond integer')
    const canonical = await realpath(grant.path).catch(() => undefined)
    if (canonical === undefined) { unresolved.push(grant.path); continue }
    if (grant.expiresAt !== undefined && grant.expiresAt <= now) { unresolved.push(`${grant.path} (expired)`); continue }
    grants.push({ path: canonical, ...(grant.note === undefined ? {} : { note: grant.note }), ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) })
  }
  return { grants, loadedAt: now, unresolved }
}

/** Roots in effect for one admission: loaded grants minus any that expired since start. */
function activeGrants(loaded: WorkspaceGrantSnapshot, now: number): WorkspaceGrant[] {
  return loaded.grants.filter(grant => grant.expiresAt === undefined || grant.expiresAt > now)
}

/**
 * The single containment check every admission and re-validation site uses.
 * Both sides are realpath-resolved before comparison, so a symlinked root or
 * workspace is judged by where it actually points; prefix confusion and
 * traversal cannot pass because containment is decided on resolved path
 * components, not string prefixes.
 */
export async function authorizeWorkspace(requested: string, sessionCwd: string | undefined, loaded: WorkspaceGrantSnapshot, now = Date.now()): Promise<WorkspaceAuthorization> {
  const workspace = await realpath(requested).catch(() => undefined)
  if (workspace === undefined) return { ok: false, diagnostic: workspaceAuthorizationDiagnostic(requested, loaded, 'the path does not exist or cannot be resolved') }
  const session = typeof sessionCwd === 'string' && sessionCwd.trim() !== '' ? await realpath(sessionCwd).catch(() => undefined) : undefined
  if (session !== undefined && workspace === session) return { ok: true, workspace, source: 'session', grantRoot: session }
  // The most specific (longest) matching root wins, so admission, re-derivation
  // and revocation fencing all agree when configured roots are nested.
  const grant = activeGrants(loaded, now)
    .filter(candidate => isContained(candidate.path, workspace))
    .sort((left, right) => right.path.length - left.path.length)[0]
  if (grant !== undefined) return { ok: true, workspace, source: 'grant', grantRoot: grant.path, grant }
  return { ok: false, diagnostic: workspaceAuthorizationDiagnostic(requested, loaded) }
}

/** Narrow an authorization to the resolved workspace or fail with its diagnostic. */
export function boundWorkspace(authorization: WorkspaceAuthorization): string {
  if (!authorization.ok) throw new Error(authorization.diagnostic)
  return authorization.workspace
}

/**
 * Re-validate a workspace already recorded on a mission, using the mission's
 * own durable `workspaceGrantRoot` as the recorded anchor:
 *
 * - a session workspace keeps its recorded root equal to itself, so it stays
 *   authorized exactly while the directory still resolves to that path;
 * - a mission bound to a grant root stays authorized only while the workspace
 *   resolves inside that root *and* the root is still one the human configured
 *   and has not expired — so removing the root fences the mission at its next
 *   prepare or verification checkout instead of continuing silently.
 *
 * Residual TOCTOU: the check and the subsequent git operation are separate
 * syscalls, so a root replaced in that window is not caught here. This is
 * documented in docs/known-limitations.md rather than claimed closed.
 */
export async function reauthorizeWorkspace(workspace: string, recordedRoot: string | undefined, loaded: WorkspaceGrantSnapshot, source?: 'session' | 'grant', now = Date.now()): Promise<WorkspaceAuthorization> {
  const resolved = await realpath(workspace).catch(() => undefined)
  if (resolved === undefined) return { ok: false, diagnostic: `Authorized workspace ${workspace} no longer exists or cannot be resolved [${WORKSPACE_AUTHORIZATION_CODE}]` }
  const root = recordedRoot === undefined ? undefined : await realpath(recordedRoot).catch(() => undefined)
  if (root === undefined) return { ok: false, diagnostic: `Workspace ${workspace} has no recorded authorized root [${WORKSPACE_AUTHORIZATION_CODE}]` }
  // X3: the configured set decides first. A recorded root that currently
  // matches a configured grant is a grant even when the record omitted its
  // source, so it stays authorized while the human keeps the root. A session
  // workspace is admitted only when the record explicitly says 'session': a
  // missing source on a root that is not configured could be a revoked grant
  // whose root happens to equal the workspace, and that must fail closed.
  if (resolved === root) {
    const configured = activeGrants(loaded, now).find(candidate => candidate.path === root)
    if (configured !== undefined) return { ok: true, workspace: resolved, source: 'grant', grantRoot: root, grant: configured }
    if (source === 'session') return { ok: true, workspace: resolved, source: 'session', grantRoot: root }
    return { ok: false, diagnostic: `Authorized root ${recordedRoot} was removed from authorizedWorkspaces or has expired; restart with the root restored to continue [${WORKSPACE_AUTHORIZATION_CODE}]` }
  }
  if (!isContained(root, resolved)) return { ok: false, diagnostic: `Workspace ${workspace} escaped its recorded authorized root ${recordedRoot} [${WORKSPACE_AUTHORIZATION_CODE}]` }
  const grant = activeGrants(loaded, now).find(candidate => candidate.path === root)
  if (grant === undefined) return { ok: false, diagnostic: `Authorized root ${recordedRoot} was removed from authorizedWorkspaces or has expired; restart with the root restored to continue [${WORKSPACE_AUTHORIZATION_CODE}]` }
  return { ok: true, workspace: resolved, source: 'grant', grantRoot: root, grant }
}
