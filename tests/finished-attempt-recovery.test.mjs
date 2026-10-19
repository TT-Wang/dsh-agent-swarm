/**
 * W1: a finished attempt is recovered from the capture its submission or
 * verdict recorded, never from its worktree.
 *
 * An attempt that ended in a submission or a verdict leaves a handle that may
 * still be writing: the author of a rejected source, a reviewer whose verdict
 * deferred or rejected. Before W1 the next member's preparation recovered such
 * an attempt by capturing that worktree as it stood (`Workspaces.recoverTask`):
 * the capture committed into another member's worktree, moved its HEAD and
 * force-pushed `refs/artifacts/<task>/<epoch>` off the commit the submission or
 * verdict had recorded. The workspace engine cannot tell such an attempt from
 * its own record, so the runtime names it (`finishedAttempt`, passed to
 * `WorkerAdapter.prepareTask`). A record of that epoch recovers from the
 * recorded capture; a record of a later epoch is an attempt that did not end in
 * a capture, recovered as before. The cases a rework re-opens are here; the
 * owner's resume of a deferred review is tests/artifact-policy.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MISSION_ACCEPTANCE, WorkspaceWorkers, git, makeRepo, makeWorkspaces, setup, taskOf } from './faults/harness.mjs'

/** The real workspace engine, three member worktrees and one task, driven directly. */
async function engine(t) {
  const repo = await makeRepo('finished-attempt-engine')
  const workspaces = makeWorkspaces(repo.root)
  t.after(async () => { await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const mission = { id: 'mission-finished', workspace: repo.source }
  const member = async id => ({ id, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, id) })
  const task = { id: 'work', missionId: mission.id, epoch: 1, title: 'Work', objective: 'Change src/answer.txt', acceptance: ['works'], outputs: [], kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  const ref = epoch => git(join(repo.root, 'worktrees', mission.id, 'artifacts.git'), 'for-each-ref', '--format=%(objectname)', `refs/artifacts/${task.id}/${epoch}`)
  return { repo, workspaces, task, ref, first: await member('first'), second: await member('second'), third: await member('third') }
}

test('a named finished attempt is recovered from the capture it recorded: its worktree is not committed into and its epoch\'s artifact ref stays', async t => {
  const f = await engine(t)
  await f.workspaces.prepareTask(f.first, f.task, [])
  await writeFile(join(f.first.workspace, 'src/answer.txt'), 'submitted\n')
  const recorded = await f.workspaces.captureArtifact(f.first, f.task)
  // The handle that submitted writes on after its capture, as a finished attempt's may.
  await writeFile(join(f.first.workspace, 'src/after.txt'), 'written after the submission\n')

  await f.workspaces.prepareTask(f.second, { ...f.task, epoch: 3 }, [], undefined, { epoch: 1, capture: recorded.commit })
  assert.equal(await git(f.second.workspace, 'rev-parse', 'HEAD'), recorded.commit, 'the replacement starts from the recorded capture')
  assert.equal(await readFile(join(f.second.workspace, 'src/answer.txt'), 'utf8'), 'submitted\n')
  await assert.rejects(readFile(join(f.second.workspace, 'src/after.txt')), { code: 'ENOENT' }, 'and carries nothing written after it')
  assert.equal(await git(f.first.workspace, 'rev-parse', 'HEAD'), recorded.commit, 'the finished attempt\'s worktree is not committed into')
  assert.equal(await git(f.first.workspace, 'status', '--porcelain'), '?? src/after.txt', 'its later write stays its own, uncommitted')
  assert.equal(await f.ref(1), recorded.commit, 'the epoch\'s artifact ref keeps the commit the submission recorded')

  // The replacement captures at its own epoch, on the recorded base.
  await writeFile(join(f.second.workspace, 'src/answer.txt'), 'reworked\n')
  const reworked = await f.workspaces.captureArtifact(f.second, { ...f.task, epoch: 3 })
  assert.equal(reworked.baseCommit, recorded.baseCommit)
  await git(f.repo.source, 'merge-base', '--is-ancestor', recorded.commit, reworked.commit)
  assert.equal(await f.ref(1), recorded.commit)
})

test('a named finished attempt whose verdict captured nothing is recovered from its base, and no artifact ref is published for its epoch', async t => {
  const f = await engine(t)
  await f.workspaces.prepareTask(f.first, f.task, [])
  await writeFile(join(f.first.workspace, 'src/notes.txt'), 'never part of the verdict\n')

  await f.workspaces.prepareTask(f.second, { ...f.task, epoch: 3 }, [], undefined, { epoch: 1 })
  assert.equal(await git(f.second.workspace, 'rev-parse', 'HEAD'), f.repo.head, 'the replacement starts from the base the finished attempt was prepared on')
  await assert.rejects(readFile(join(f.second.workspace, 'src/notes.txt')), { code: 'ENOENT' })
  assert.equal(await git(f.first.workspace, 'status', '--porcelain'), '?? src/notes.txt', 'the finished attempt\'s worktree is left as it was')
  assert.equal(await f.ref(1), '', 'nothing captured that epoch')
})

test('a task record of a later epoch than the named finished attempt recovers as before: that attempt did not end in a capture, and its quiescent worktree is captured', async t => {
  const f = await engine(t)
  await f.workspaces.prepareTask(f.first, f.task, [])
  await writeFile(join(f.first.workspace, 'src/answer.txt'), 'submitted\n')
  const recorded = await f.workspaces.captureArtifact(f.first, f.task)
  const finished = { epoch: 1, capture: recorded.commit }
  await f.workspaces.prepareTask(f.second, { ...f.task, epoch: 3 }, [], undefined, finished)
  // The attempt at epoch 3 ends without a capture (a host restart): its partial work is carried.
  await writeFile(join(f.second.workspace, 'src/answer.txt'), 'partial rework\n')

  await f.workspaces.prepareTask(f.third, { ...f.task, epoch: 5 }, [], undefined, finished)
  assert.equal(await readFile(join(f.third.workspace, 'src/answer.txt'), 'utf8'), 'partial rework\n', 'the later attempt\'s work is recovered')
  assert.equal(await git(f.third.workspace, 'rev-parse', 'HEAD'), await f.ref(3), 'by the capture of its own, unrecorded epoch')
  assert.equal(await f.ref(1), recorded.commit, 'the recorded epoch\'s ref stays')
})

test('a task record older than the named finished attempt is refused as invalid recovery metadata', async t => {
  const f = await engine(t)
  await f.workspaces.prepareTask(f.first, f.task, [])
  await assert.rejects(f.workspaces.prepareTask(f.second, { ...f.task, epoch: 5 }, [], undefined, { epoch: 3, capture: f.repo.head }), /Invalid task recovery metadata/)
  assert.equal(await git(f.first.workspace, 'status', '--porcelain'), '')
})

/** The runtime on the real engine with a third member, and the artifact ref of `taskId` at `epoch`. */
async function runtime(t) {
  const repo = await makeRepo('finished-attempt-runtime')
  const workspaces = makeWorkspaces(repo.root)
  const f = await setup({ workers: new WorkspaceWorkers(workspaces), workspace: repo.source, config: { tickMs: 60_000 }, budget: { maxWorkers: 3 } })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const third = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Third', role: 'implementation', maxOutputTokens: 5_000 })
  await f.runtime.settle(f.mission.id)
  const ref = (taskId, epoch) => git(join(repo.root, 'worktrees', f.mission.id, 'artifacts.git'), 'for-each-ref', '--format=%(objectname)', `refs/artifacts/${taskId}/${epoch}`)
  const proposeReview = (source, assigneeId) => f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId })
  /** The author submits `content` for `source`; the reviewer rejects it, writing `reviews/verdict.md` as the review's record. */
  async function submitAndReject(source, content) {
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await writeFile(join(f.author.workspace, 'src/answer.txt'), content)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: content })
    const review = proposeReview(source, f.reviewer.id)
    const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await mkdir(join(f.reviewer.workspace, 'reviews'), { recursive: true })
    await writeFile(join(f.reviewer.workspace, 'reviews/verdict.md'), 'Rejected: still a draft\n')
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'Still a draft', deliverables: ['reviews/verdict.md'] })
    return { submission: taskOf(f.runtime, source.id), review: taskOf(f.runtime, review.id), epoch: claimed.attempt.epoch, reviewEpoch: reviewing.attempt.epoch }
  }
  const rework = source => f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework the draft')
  return { ...f, repo, workspaces, third, ref, submitAndReject, rework }
}

test('a reworked source handed to another member is recovered from its rejected commit: the author\'s worktree and the submission epoch\'s artifact ref are left alone', async t => {
  const f = await runtime(t)
  const source = f.propose({ title: 'Implement' })
  const { submission, epoch } = await f.submitAndReject(source, 'draft\n')
  const rejected = submission.artifact.commit
  assert.equal(await f.ref(source.id, epoch), rejected, 'the submission published its epoch\'s artifact ref')
  f.rework(source)
  assert.deepEqual([taskOf(f.runtime, source.id).rejections.at(-1).commit, taskOf(f.runtime, source.id).rejections.at(-1).epoch], [rejected, epoch])
  // The author's handle finished with its submission and was never stopped: it writes on.
  await writeFile(join(f.author.workspace, 'src/after.txt'), 'author edit after the rejection\n')

  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { assigneeId: f.third.id }, 'Hand the rework to another member')
  await f.runtime.claim(f.actor(f.third), f.mission.id, source.id)
  assert.equal(await git(f.third.workspace, 'rev-parse', 'HEAD'), rejected, 'the rework is recovered from the rejected commit')
  assert.equal(await readFile(join(f.third.workspace, 'src/answer.txt'), 'utf8'), 'draft\n')
  await assert.rejects(readFile(join(f.third.workspace, 'src/after.txt')), { code: 'ENOENT' }, 'without what the author wrote after its submission')
  assert.equal(await git(f.author.workspace, 'rev-parse', 'HEAD'), rejected, 'the author\'s worktree is not committed into')
  assert.equal(await git(f.author.workspace, 'status', '--porcelain'), '?? src/after.txt', 'and its edit stays its own')
  assert.equal(await f.ref(source.id, epoch), rejected, 'the submission epoch\'s artifact ref keeps the rejected commit')
})

test('a rework-reopened review handed to another reviewer leaves the rejecting reviewer\'s worktree and the archived review artifact\'s ref alone', async t => {
  const f = await runtime(t)
  const source = f.propose({ title: 'Implement' })
  const { review, reviewEpoch } = await f.submitAndReject(source, 'draft\n')
  const recorded = review.reviewArtifact.commit
  assert.equal(await f.ref(review.id, reviewEpoch), recorded, 'the rejecting verdict published its epoch\'s artifact ref')
  f.rework(source)
  const reopened = taskOf(f.runtime, review.id)
  assert.deepEqual([reopened.status, reopened.rejections.at(-1).reviewArtifact.commit, reopened.rejections.at(-1).epoch], ['pending', recorded, reviewEpoch], 'the rework archived the rejecting round')
  // The reviewer finished with its verdict and was never stopped: it writes on.
  await writeFile(join(f.reviewer.workspace, 'after.txt'), 'reviewer note after the verdict\n')
  const reviewerHead = await git(f.reviewer.workspace, 'rev-parse', 'HEAD')

  const resubmitted = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await writeFile(join(f.author.workspace, 'src/answer.txt'), 'final\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: resubmitted.attempt.id, output: 'final' })
  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'amend', { assigneeId: f.third.id }, 'Hand the review to another reviewer')
  await f.runtime.claim(f.actor(f.third), f.mission.id, review.id)
  assert.equal(await git(f.third.workspace, 'rev-parse', 'HEAD'), taskOf(f.runtime, source.id).artifact.commit, 'the new review starts from the resubmission it reviews')
  assert.equal(await git(f.reviewer.workspace, 'rev-parse', 'HEAD'), reviewerHead, 'the rejecting reviewer\'s worktree is not committed into')
  assert.equal(await git(f.reviewer.workspace, 'status', '--porcelain'), '?? after.txt', 'and its later writes stay its own')
  assert.equal(await f.ref(review.id, reviewEpoch), recorded, 'the archived review artifact\'s epoch ref keeps the commit its verdict recorded')
})
