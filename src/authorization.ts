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
 * or the tool registry: it holds the one authorization rule every admission
 * and re-validation site shares, so no call site can quietly weaken it.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Mission, WorkspaceGrant, WorkspaceGrantSnapshot } from './types.ts'

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

/** What an entry point hands the runtime beside a plan, and the runtime records; never a plan field. */
export type WorkspaceClaim = Pick<WorkspaceAuthorized, 'source' | 'grantRoot'>

export interface WorkspaceRefused {
  ok: false
  /** Field-level diagnostic naming the authorization requirement and its repair. */
  diagnostic: string
}

export type WorkspaceAuthorization = WorkspaceAuthorized | WorkspaceRefused

/**
 * A recorded workspace is no longer inside a human-authorized root. Distinct
 * from an ordinary preparation failure because it is terminal for this host
 * process: the runtime fences the mission instead of spending recovery or start
 * credit, and the owner is woken with the durable reason.
 */
export class WorkspaceRevokedError extends Error {
  readonly code = 'workspace_revoked'
  constructor(readonly diagnostic: string) { super(diagnostic); this.name = 'WorkspaceRevokedError' }
}

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

/**
 * The one matching rule: the most specific (longest) configured root that is
 * still active at `now` and contains `path`. Admission, the synchronous create
 * path and re-validation all select through it, so nested roots can never make
 * them disagree.
 */
export function grantFor(path: string, loaded: WorkspaceGrantSnapshot, now: number): WorkspaceGrant | undefined {
  return loaded.grants
    .filter(grant => (grant.expiresAt === undefined || grant.expiresAt > now) && isContained(grant.path, path))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

/**
 * Admission: the requested path is realpath-resolved before `grantFor`, so a
 * symlinked root or workspace is judged by where it actually points; prefix
 * confusion and traversal cannot pass because containment is decided on
 * resolved path components, not string prefixes.
 */
export async function authorizeWorkspace(requested: string, sessionCwd: string | undefined, loaded: WorkspaceGrantSnapshot, now = Date.now()): Promise<WorkspaceAuthorization> {
  const workspace = await realpath(requested).catch(() => undefined)
  if (workspace === undefined) return { ok: false, diagnostic: workspaceAuthorizationDiagnostic(requested, loaded, 'the path does not exist or cannot be resolved') }
  const session = typeof sessionCwd === 'string' && sessionCwd.trim() !== '' ? await realpath(sessionCwd).catch(() => undefined) : undefined
  if (session !== undefined && workspace === session) return { ok: true, workspace, source: 'session', grantRoot: session }
  const grant = grantFor(workspace, loaded, now)
  if (grant !== undefined) return { ok: true, workspace, source: 'grant', grantRoot: grant.path, grant }
  return { ok: false, diagnostic: workspaceAuthorizationDiagnostic(requested, loaded) }
}

/**
 * The claim a mission, draft or automatic request recorded. X3: a row without
 * an anchor predates the feature, so its workspace is its own anchor; a row
 * without a source never reads as a session authorization, so it is judged by
 * the configured roots and fails closed.
 */
export function recordedClaim(workspace: string, row: Pick<Mission, 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>): WorkspaceClaim {
  return { grantRoot: row.workspaceGrantRoot ?? workspace, source: row.workspaceAuthorizationSource ?? 'grant' }
}

/**
 * Re-validate a workspace already recorded on a mission or planning request.
 * The resolved workspace must still sit inside its recorded claim's root; it
 * then stays authorized as the session workspace it was recorded as, or while
 * `grantFor` still finds an active configured root containing it: the
 * admission rule, so a root added or removed around it never fences a
 * workspace admission would accept, and removing the last root that contains
 * it fences the mission at its next preparation.
 *
 * Residual TOCTOU: the check and the subsequent git operation are separate
 * syscalls, so a root replaced in that window is not caught here. This is
 * documented in docs/known-limitations.md rather than claimed closed.
 */
export async function reauthorizeWorkspace(record: Pick<Mission, 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>, loaded: WorkspaceGrantSnapshot, now = Date.now()): Promise<WorkspaceAuthorization> {
  const { grantRoot: recorded, source } = recordedClaim(record.workspace, record)
  const workspace = await realpath(record.workspace).catch(() => undefined)
  if (workspace === undefined) return { ok: false, diagnostic: `Authorized workspace ${record.workspace} no longer exists or cannot be resolved [${WORKSPACE_AUTHORIZATION_CODE}]` }
  const anchor = await realpath(recorded).catch(() => undefined)
  if (anchor === undefined || !isContained(anchor, workspace)) return { ok: false, diagnostic: `Workspace ${record.workspace} escaped its recorded authorized root ${recorded} [${WORKSPACE_AUTHORIZATION_CODE}]` }
  if (source === 'session' && workspace === anchor) return { ok: true, workspace, source: 'session', grantRoot: anchor }
  const grant = grantFor(workspace, loaded, now)
  if (grant !== undefined) return { ok: true, workspace, source: 'grant', grantRoot: grant.path, grant }
  return { ok: false, diagnostic: `Authorized root ${recorded} was removed from authorizedWorkspaces or has expired; restart with the root restored to continue [${WORKSPACE_AUTHORIZATION_CODE}]` }
}
