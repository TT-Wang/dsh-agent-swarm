/**
 * The event registry: every durable kind the runtime may emit, with the one
 * description the read path shows and the one compact-panel decision the client
 * makes about it.
 *
 * Why it lives here and not in `src/trace.ts`: this module imports nothing, so
 * both `tsconfig.json` and `tsconfig.client.json` compile it and the browser
 * bundle can read the same rows the host writes. Adding a kind is one row —
 * before this file it was a vocabulary entry, a client label, a zh string and
 * two source-scanner lists, and only a test run said whether they agreed.
 *
 * The literal is frozen with `as const`, so `EventKind` is exactly its key set
 * and `SwarmStore.event` refuses an unregistered kind at compile time. Decoding
 * stays open: `SwarmEvent.type`, `store.events()` and `eventVocabularyReport`
 * keep `string`, so a row written by an older version still decodes and is
 * reported as undescribed rather than dropped.
 */

/** One registered kind. `panel` is the client's decision: a label, or why there is none. */
export interface EventSpec {
  /** What the row means, for the read path and `eventVocabularyReport`. */
  description: string
  /** The compact-panel label in both catalogue languages, or the reason the panel omits it. */
  panel: { en: string; zh: string } | { omit: string }
  /**
   * The kind is decodable but no longer written. Only a kind marked this way may
   * have no writer; everything else is checked against the emitters in
   * tests/reader-census.test.mjs.
   */
  historical?: true
}

export const EVENTS = {
  'task/verification-deferred': { description: 'Check infrastructure needs repair; exact submitted source and verification evidence preserved', panel: { en: 'Verification needs environment repair', zh: '验证需要修复执行环境' } },
  'task/amended': { description: 'Owner revised task execution policy while retaining task identity and acceptance', panel: { en: 'Task plan amended', zh: '任务计划已修订' } },
  'mission/scope-amended': { description: 'Owner revised execution scope within the human workspace authorization', panel: { en: 'Mission scope amended', zh: '任务范围已修订' } },
  'task/plan-repaired': { description: 'Unused staged task policy repaired with its previous revision preserved', panel: { en: 'Task plan amended', zh: '任务计划已修订' } },
  'member/plan-repaired': { description: 'Staged member configuration repaired after stop acknowledgement', panel: { en: 'Worker configuration repaired', zh: '成员配置已修复' } },
  'plan/admissions-repaired': { description: 'Saved plan reconciled with retained mission and resource identities', panel: { en: 'Saved plan repaired', zh: '已保存的计划已修复' } },
  'mission/created': { description: 'Mission admitted with its initial scope and budget', panel: { omit: 'the mission header and status show creation' } },
  'mission/recovered': { description: 'Host restarted and recovered the mission from durable state', panel: { en: 'Mission recovered', zh: '任务已恢复' } },
  'mission/budget-updated': { description: 'Owner changed the resource ceilings without resetting usage', panel: { omit: 'accounting; the metrics show the new ceilings' } },
  'mission/stalled': { description: 'No schedulable work remains and every live worker is idle', panel: { en: 'Mission stalled', zh: '任务已停滞' } },
  'automatic/completed': { description: 'Runtime completed an automatic mission after independent acceptance', panel: { en: 'Collaboration completed', zh: '协作已完成' } },
  'workspace/snapshot': { description: 'Member workspace baseline snapshot recorded', panel: { en: 'Project snapshot saved', zh: '已保存项目快照' } },
  'member/added': { description: 'Worker admitted with its isolated worktree', panel: { en: 'Worker added', zh: '成员已加入' } },
  'member/failed': { description: 'Worker could not be created', panel: { en: 'Worker could not start', zh: '成员未能启动' } },
  'member/resume-failed': { description: 'Worker could not resume after restart', panel: { en: 'Worker could not resume after restart', zh: '成员重启后未能恢复' } },
  'member/stopped': { description: 'Worker handle stopped', panel: { omit: 'the team disclosure shows member status' } },
  'member/activity': { description: 'Worker activity heartbeat for lease liveness', panel: { omit: 'lease-liveness heartbeat; the activity projection already shows it' } },
  'workstream/created': { description: 'Workstream admitted', panel: { omit: 'board structure, not progress' } },
  'task/proposed': { description: 'Task admitted under a workstream', panel: { omit: 'the pending task card appears on the board' } },
  'task/claimed': { description: 'Attempt dispatched: ownership, attempt id and lease recorded', panel: { en: 'Task started', zh: '子任务开始执行' } },
  'task/submitted': { description: 'Artifact captured and submitted for independent review', panel: { en: 'Work submitted for review', zh: '工作已提交审查' } },
  'task/accepted': { description: 'Independent verification accepted the source artifact', panel: { en: 'Work accepted', zh: '工作已验收' } },
  'task/rejected': { description: 'Independent verification rejected the source artifact', panel: { en: 'Review requested changes', zh: '审查要求修改' } },
  'task/blocked': { description: 'Task blocked with the reason that must be repaired', panel: { en: 'Task needs attention', zh: '子任务需要处理' } },
  'task/cancelled': { description: 'Owner withdrew admitted work; dependents named as stranded', panel: { en: 'Task cancelled', zh: '子任务已取消' } },
  'task/cancelled-at-completion': { description: 'Unschedulable leftover cancelled at mission completion', panel: { en: 'Task cancelled at completion', zh: '子任务在完成时被取消' }, historical: true },
  'task/lease-expired': { description: 'Attempt lease expired and the owner was released', panel: { en: 'Task execution expired', zh: '任务执行已到期' } },
  'attempt/fenced': { description: 'A control decision fenced a running attempt: epoch bumped, outgoing owner recorded, stop obligation installed', panel: { en: 'Task work was stopped', zh: '子任务的工作已被停止' } },
  'task/ceiling-exhausted': { description: 'Task exhausted its step allocation and preserved work for owner-directed continuation', panel: { en: 'Task ceiling reached', zh: '子任务超出执行上限' } },
  'task/checkpointed': { description: 'Workspace checkpoint captured before reassignment', panel: { en: 'Task workspace checkpointed', zh: '已保存子任务工作区检查点' } },
  'task/checkpoint-failed': { description: 'Checkpoint capture failed; workspace preserved, recovery refuses a dirty tree', panel: { en: 'Task workspace checkpoint failed', zh: '子任务工作区检查点保存失败' } },
  'task/closeout-nudged': { description: 'Idle worker nudged to finish its open attempt', panel: { en: 'Worker asked to close out', zh: '已要求成员收尾' } },
  'task/closeout-abandoned': { description: 'Idle close-out exhausted: checkpoint captured and the task re-pended', panel: { en: 'Abandoned task workspace recovered', zh: '已恢复被放弃的子任务工作区' } },
  'task/closeout-failed': { description: 'Idle close-out could not capture a checkpoint', panel: { en: 'Task close-out failed', zh: '子任务收尾失败' } },
  'task/handoff-started': { description: 'Ownership revoked; reassignment waits for the previous worker to stop', panel: { en: 'Task handoff started', zh: '开始交接任务' } },
  'task/handoff-ready': { description: 'Previous worker stopped and the handed-off task is schedulable again', panel: { en: 'Task handoff completed', zh: '任务交接已完成' } },
  'task/review-retired': { description: 'Sibling review retired because its source can never reach a verdict', panel: { en: 'A redundant review was retired', zh: '已退役多余的审查' } },
  'task/superseded': { description: 'A blocked or pending task of an accepted replacement\'s lineage was retired; names the replacement and any live replacement left alone', panel: { en: 'Replaced work retired', zh: '被替代的工作已退役' } },
  'task/duplicate-carrier': { description: 'A task of an accepted replacement\'s lineage was still live, so it was not retired; names the accepted replacement that already carries its obligation (code lineage_duplicate_carrier)', panel: { en: 'Duplicate work flagged', zh: '发现重复承担的工作' } },
  'task/invalidated': { description: 'Dependent work invalidated by a challenged prerequisite', panel: { en: 'Dependent work needs another review', zh: '依赖此结果的工作需要重新审查' } },
  'task/git-write-denied': { description: 'Sandbox refused a worker git write; the supported exit is named', panel: { en: 'Worker git write denied', zh: '成员的 Git 写入被拒绝' } },
  'task/budget-resume-skipped': { description: 'Budget-resume marker was stale and skipped', panel: { en: 'Task resume skipped', zh: '已跳过子任务恢复' } },
  // S5c: emitted by `SwarmStore.putTask` through the exported constant
  // `STALE_TASK_REFUSAL_EVENT` (src/store.ts). `EventKind` checks a constant
  // emission exactly like a literal, so this row is required, not optional.
  'task/stale-revision-refused': { description: 'A task write presented a revision another accepted write had moved past; the durable revision was named and the write refused', panel: { omit: 'store-internal lost-update record; the refused write is named to its caller synchronously and this row exists so an audit can reconstruct it' } },
  'task/quiescence-recovered': { description: 'Parked task recovered after host restart', panel: { en: 'Task recovered after quiescence', zh: '子任务在静止后已恢复' } },
  'evidence/published': { description: 'Unverified claim published with host-recorded run ids', panel: { en: 'A finding was recorded', zh: '记录了一项发现' } },
  'evidence/challenged': { description: 'Claim challenged with counterevidence', panel: { en: 'A finding was challenged', zh: '一项发现受到质疑' } },
  'evidence/verified': { description: 'Verdict verified the claim and names the retired reviews', panel: { en: 'A finding was verified', zh: '一项发现已核实' } },
  'evidence/refuted': { description: 'Verdict refuted the claim and names the retired reviews', panel: { en: 'A finding was refuted', zh: '一项发现已被推翻' } },
  'evidence/verdict': { description: 'Normalized verdict row: evidence id, verdict and retired reviews', panel: { omit: 'normalized duplicate of evidence/verified|refuted' } },
  'trace/span': { description: 'One orchestration step span with digests of its input and output', panel: { omit: 'trace payload; the trace/replay surface owns it' } },
  'message/queued': { description: 'Directed message or topic broadcast queued durably', panel: { omit: 'transport; the delivery panel owns it' } },
  'message/answered': { description: 'The addressed recipient bound an answer to a question delivery id (L1 receipt)', panel: { en: 'A question was answered', zh: '问题已获答复' } },
  'message/dismissed': { description: 'The addressed recipient closed a question delivery without an answer, recording the reason (L1 receipt)', panel: { en: 'A question was closed without an answer', zh: '问题已标记为不答复' } },
  'owner/reply-missing': { description: 'An owner turn ended with a delivered question still unanswered: the receipt was not bound by any tool call in that turn (L2)', panel: { en: 'A question to the owner is still unanswered', zh: '主对话有一条问题尚未答复' } },
  // Every remaining type the runtime emits (F-14). The read path must name them
  // so an operator can reconstruct a decision instead of seeing an unknown row.
  'automatic/requested': { description: 'Automatic planning request admitted with its goal and workspace', panel: { omit: 'planning start; automatic/completed|failed carry the outcome' } },
  'automatic/failed': { description: 'Automatic planning or launch failed with the recorded reason', panel: { en: 'Collaboration could not start', zh: '协作未能启动' } },
  'member/failure': { description: 'Worker operation failed with the recorded error', panel: { en: 'Worker reported a failure', zh: '成员报告执行失败' } },
  'member/subscribed': { description: 'Worker topic subscriptions replaced', panel: { en: 'Worker subscriptions updated', zh: '成员订阅已更新' } },
  'member/waiting': { description: 'Worker parked itself until fresh peer input arrives', panel: { omit: 'the activity projection shows the parked member' } },
  'mission/budget-exhausted': { description: 'Aggregate budget exhausted; mission paused pending quiescence and a raise', panel: { en: 'Resource limit reached', zh: '达到资源上限' } },
  'mission/budget-quiesced': { description: 'Every worker stopped after budget exhaustion; attempts preserved for resume', panel: { omit: 'follow-up to mission/budget-exhausted' } },
  'mission/budget-warning': { description: 'Approaching-limit threshold crossed for one budget dimension', panel: { en: 'Budget warning', zh: '预算警告' } },
  'plan/edited': { description: 'Saved draft plan edited with a new revision', panel: { omit: 'draft-scoped; never in a mission snapshot' } },
  'plan/launched': { description: 'Saved draft plan activated as an active mission', panel: { en: 'Collaboration started', zh: '协作已启动' } },
  'plan/staged': { description: 'Draft plan staged without creating workers or worktrees', panel: { omit: 'draft-scoped; never in a mission snapshot' } },
  'task/budget-resumed': { description: 'Preserved attempt resumed after the budget raise', panel: { en: 'Task resumed after budget pause', zh: '子任务在预算暂停后已恢复' } },
  'task/lease-expiring': { description: 'Attempt lease is approaching expiry with no live operation', panel: { en: 'Task lease expiring', zh: '子任务租约即将到期' } },
  'tool/recorded': { description: 'Host tool run recorded for evidence and audit', panel: { omit: 'per-tool counter; the transcript and evidence provenance own it' } },
  // Round 9-C: the remaining types the runtime emits, including the four added
  // by the liveness/review/check fixes. `eventVocabularyReport` must never
  // report an emitted type as unrecognized; an unregistered emitter is now a
  // compile error at its call site rather than a scanner finding.
  'admission/limit': { description: 'Owner set an admission limit rule; recorded with its level, key and limit', panel: { omit: 'owner notice; no task event' } },
  'admission/refused': { description: 'Admission refused a task or member against a limit; recorded once per refusal row', panel: { omit: 'owner notice; no task event' } },
  'member/effort-downgraded': { description: 'Provider rejected the requested reasoning effort; the member runs without it', panel: { en: 'Worker reasoning effort downgraded', zh: '成员的推理强度已降级' } },
  'member/effort-rejected': { description: 'Provider rejected the effort retry; admission failed and the member was stopped', panel: { omit: 'paired with member/failed (Worker could not start)' } },
  'task/check-changed': { description: 'A replaced or re-submitted task declared a different check than the stored record', panel: { en: 'A declared check changed', zh: '声明的检查已变更' } },
  'task/closeout-ready': { description: 'Idle close-out re-pended the task after a checkpoint instead of abandoning it', panel: { en: 'Task ready to close out', zh: '子任务可以收尾' } },
  'task/closeout-exhausted': { description: 'Idle close-out reached the recovery limit and left the task blocked', panel: { en: 'Task close-out limit reached', zh: '子任务收尾次数已达上限' } },
  'task/preparation-failed': { description: 'Task preparation failed; the reason and recovery credit were recorded', panel: { en: 'Task preparation failed', zh: '子任务准备失败' } },
  'task/reassigned': { description: 'A failed attempt was re-routed to another live member', panel: { en: 'Task re-routed to another member', zh: '子任务已改派给其他成员' } },
  'task/review-admitted': { description: 'The runtime admitted an independent verification for a submitted task with no review', panel: { en: 'Independent review admitted', zh: '已自动准入独立审查' } },
  'task/review-blocked': { description: 'A submitted task has no review and no eligible reviewer; the reason is recorded', panel: { en: 'Submitted work cannot be reviewed', zh: '已提交的工作无法审查' } },
  'task/review-missing': { description: 'A submitted task was detected without a review on the scheduler tick', panel: { en: 'Submitted work has no review', zh: '已提交的工作尚无审查' } },
  'task/start-failed': { description: 'Worker start failed; the attempt was recovered or re-routed with the reason', panel: { en: 'Task failed to start', zh: '子任务启动失败' } },
  'mission/pause': { description: 'Owner paused the mission', panel: { en: 'Mission paused', zh: '任务已暂停' } },
  'mission/stop': { description: 'Owner stopped the mission', panel: { en: 'Mission stopped', zh: '任务已停止' } },
  'mission/complete': { description: 'Owner completed the mission', panel: { en: 'Collaboration completed', zh: '协作已完成' } },
  'mission/resume': { description: 'Owner resumed the mission', panel: { en: 'Mission resumed', zh: '任务已继续' } },
  'mission/coordinator': { description: 'Owner set the mission coordinator', panel: { en: 'Mission coordinator set', zh: '已设置任务协调者' } },
  'delivery/applied': { description: 'Owner applied an accepted result to the source checkout', panel: { en: 'Result applied to project', zh: '成果已应用到项目' } },
  'delivery/conflicts': { description: 'Owner applied a result that conflicted; no source write was kept', panel: { en: 'Result needs conflict resolution', zh: '成果需要处理合并冲突' } },
  // User-authorized per-mission workspace: the human authorization surface and
  // its durable binding/revocation audit.
  'workspace/grant-loaded': { description: 'One human-configured authorizedWorkspaces root loaded at plugin start, or named as unresolvable', panel: { en: 'Authorized workspace root loaded', zh: '已加载授权工作目录根' } },
  'mission/workspace-bound': { description: 'Mission bound to its resolved workspace and the matched authorized root', panel: { en: 'Mission bound to an authorized workspace', zh: '任务已绑定到授权工作目录' } },
  'mission/workspace-revoked': { description: 'Mission fenced: its workspace is no longer inside a human-authorized root', panel: { en: 'Mission workspace authorization revoked', zh: '任务工作目录授权已撤销' } },
  // Round 11 arena protocols: the typed owner escalation and the bounded
  // per-member proposal allowance refusal (both recorded before the owner
  // notice that carries the decision).
  'escalation/raised': { description: 'A member raised a typed durable owner escalation with its mission-state fingerprint', panel: { en: 'A worker escalated to the owner', zh: '成员已向主对话发起升级' } },
  'task/proposal-refused': { description: 'A worker proposal was refused for the per-member allowance or a mission budget/ceiling reason; the owner was notified', panel: { en: 'Work proposal refused', zh: '工作提议被拒绝' } },
  // Round 11 host caps: provider-outage routing, store snapshot, per-task
  // restart and the measured check envelope (D2/D6/D8).
  'provider/outage': { description: 'Provider outage classified (quota, rate limit or unavailable); the route is quiescent and no recovery credit is spent', panel: { en: 'Provider route paused', zh: '提供方服务中断，任务已暂停' } },
  'provider/recovered': { description: 'A quiescent provider route answered successfully again; the outage marker is cleared', panel: { en: 'Provider route recovered', zh: '提供方服务已恢复' } },
  'task/restart-repended': { description: 'Host restart re-pended a running task without spending recovery credit; the task and epoch are named', panel: { en: 'Task re-pended after host restart', zh: '主机重启后子任务重新排队' } },
  'task/recovery-fallback': { description: 'Cross-owner recovery could not capture the previous owner\'s workspace; names the commit the replacement started from and whether the uncaptured work was preserved into it', panel: { en: 'Task recovered from an uncaptured workspace', zh: '子任务从未能捕获的工作区恢复' } },
  'task/verification-cleanup-failed': { description: 'A disposable verification checkout could not be removed after its declared checks ran; names the checkout and the removal failure, the verdict is unaffected', panel: { en: 'Verification checkout could not be removed', zh: '验证检出目录无法移除' } },
  'task/check-envelope': { description: 'Measured declared-check envelope after a verification: limit, active, queued, wait and run times', panel: { omit: 'measured check envelope; the verification verdict and check-failure rows carry the owner-facing outcome' } },
  'store/snapshot': { description: 'Periodic VACUUM INTO snapshot written beside the owner state file', panel: { omit: 'install-scoped VACUUM INTO row; never in a mission snapshot (the store audit owns it)' } },
  'store/restore-requested': { description: 'Owner staged one validated snapshot restore for the next host start', panel: { omit: 'install-scoped owner tool result; the restore happens at the next host start' } },
  'store/restored': { description: 'Plugin composition applied a staged snapshot restore before opening the store', panel: { omit: 'install-scoped startup row; emitted before any mission exists' } },
  // R11-15: the shared temp roots are a cross-member channel; this row records
  // two members naming the same temp path inside the rendezvous window.
  'isolation/temp-rendezvous': { description: 'Two members named the same shared temp path inside the rendezvous window; the path and both members are recorded', panel: { en: 'Members shared a temp path', zh: '成员共享了临时路径' } },
} as const satisfies Record<string, EventSpec>

/** Every kind a writer may emit. A new kind is one row above, not five registrations. */
export type EventKind = keyof typeof EVENTS

/**
 * The widened view of the registry. Reading is open where writing is closed, so
 * the derivations below take a `string` key and every consumer that decodes a
 * legacy row keeps working.
 */
const SPECS: Record<string, EventSpec> = EVENTS

/** Description by kind: the read path's vocabulary, unchanged in shape and meaning. */
export const EVENT_VOCABULARY: Record<string, string> = Object.fromEntries(Object.entries(SPECS).map(([kind, spec]) => [kind, spec.description]))

/** Compact-panel labels by kind; a kind whose `panel` names an omit reason is absent. */
export const EVENT_PANEL_LABELS: Record<string, { en: string; zh: string }> = Object.fromEntries(
  Object.entries(SPECS).flatMap(([kind, spec]) => 'omit' in spec.panel ? [] : [[kind, spec.panel]]),
)
