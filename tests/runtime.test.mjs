import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { SwarmStore } from '../lib/store.js'
import { withinScope, scopeSubset } from '../lib/scope.js'

const budget = { maxTokens: 1000, maxSteps: 10, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
/** Only the external execution adapter is replaced; store/admission/state/outbox are real. */
class ControlledWorkers {
  callbacks; deliveries = []; stopped = []; checks = [{ command: 'test', exitCode: 0, output: 'ok' }]; artifact = { commit: 'abc', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }; stopGate; prepared = []
  bind(c) { this.callbacks = c }
  async prepareWorkspace(m, id) { return `/isolated/${id}` }
  async start() {}
  async deliver(m, d) { this.deliveries.push(d) }
  async stop(id) { if (this.stopGate) await this.stopGate; this.stopped.push(id) }
  isIdle() { return false }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async prepareTask(member,task) { this.prepared.push(task.epoch) }
  async dispose() {}
}
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-runtime-'))
  const workers = new ControlledWorkers()
  const config = { statePath: join(dir,'db.sqlite'), leaseMs:60000, tickMs:1000, maxMessageChars:16000, maxEvents:100, maxTasksPerMember:3 }
  const runtime = new SwarmRuntime(config, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir,{recursive:true,force:true}) })
  const owner = { sessionId:'owner-session' }
  const mission = runtime.create(owner,{title:'Build',objective:'Fix module',workspace:'/source',scope:['src/'],acceptance:['works'],budget:{...budget,...overrides}})
  const stream = runtime.workstream(owner,mission.id,{title:'Core',objective:'Fix module'})
  const a = await runtime.addMember(owner,mission.id,{name:'Builder',role:'implementation'})
  const b = await runtime.addMember(owner,mission.id,{name:'Reviewer',role:'verification'})
  const actorA = {sessionId:a.sessionId}, actorB = {sessionId:b.sessionId}
  const propose = (actor=actorA, extra={}) => runtime.propose(actor,mission.id,{workstreamId:stream.id,title:'Fix',objective:'Fix module',kind:'implementation',scope:['src/'],acceptance:['works'],checks:['test'],...extra})
  return {runtime,workers,config,owner,mission,stream,a,b,actorA,actorB,propose}
}
test('participants propose work within the same scope and budget, without captain relaying',async t=>{
  const f=await setup(t)
  const task=f.propose()
  assert.equal(task.status,'pending')
  assert.throws(()=>f.propose(f.actorA,{scope:['secrets/']}),/exceeds/)
  assert.throws(()=>f.runtime.create(f.actorA,{title:'escape'}),/independent missions/)
  await assert.rejects(f.runtime.addMember(f.actorA,f.mission.id,{name:'extra',role:'helper'}),/Only the mission owner/)
  assert.throws(()=>f.runtime.snapshot({sessionId:'stranger'},f.mission.id),/not a participant/)
})
test('parallel self-claims produce one owner and the prepared workspace matches its epoch',async t=>{
  const f=await setup(t); const task=f.propose()
  const results=await Promise.allSettled([f.runtime.claim(f.actorA,f.mission.id,task.id),f.runtime.claim(f.actorB,f.mission.id,task.id)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const current=f.runtime.snapshot(f.owner,f.mission.id).tasks[0]
  assert.equal(f.workers.prepared[0],current.attempt.epoch)
  assert.throws(()=>f.runtime.publish(f.actorB,f.mission.id,{taskId:task.id,attemptId:current.attempt.id,claim:'fake',outcome:'supported',toolRunIds:['fake']}),/unauthorized/)
})
test('evidence must reference actual executions from the publishing attempt',async t=>{
  const f=await setup(t); const task=await f.runtime.claim(f.actorA,f.mission.id,f.propose().id)
  const input={taskId:task.id,attemptId:task.attempt.id,claim:'Hypothesis disproved',outcome:'disproved',toolRunIds:['imaginary']}
  assert.throws(()=>f.runtime.publish(f.actorA,f.mission.id,input),/host-recorded/)
  await f.workers.callbacks.toolRun(f.a.id,{tool:'bash',arguments:{command:'test'},result:{exitCode:1},isError:false})
  const runs=f.runtime.observe(f.actorA,f.mission.id).toolRuns
  const evidence=f.runtime.publish(f.actorA,f.mission.id,{...input,toolRunIds:[runs[0].id]})
  assert.equal(evidence.status,'unverified'); assert.equal(evidence.outcome,'disproved')
  assert.equal(f.runtime.observe(f.actorB,f.mission.id).toolRuns.length,0)
})
test('a claimed pass cannot override failing host verification',async t=>{
  const f=await setup(t); const task=await f.runtime.claim(f.actorA,f.mission.id,f.propose().id)
  await f.runtime.submit(f.actorA,f.mission.id,{taskId:task.id,attemptId:task.attempt.id,output:'done'})
  const review=f.propose(f.actorB,{kind:'verification',reviewOf:task.id,checks:[]})
  await assert.rejects(f.runtime.claim(f.actorA,f.mission.id,review.id),/not ready/)
  const claimed=await f.runtime.claim(f.actorB,f.mission.id,review.id)
  f.workers.checks=[{command:'test',exitCode:1,output:'failure'}]
  await f.runtime.verify(f.actorB,f.mission.id,{taskId:review.id,attemptId:claimed.attempt.id,verdict:'accept',reason:'I think it passes'})
  const snapshot=f.runtime.snapshot(f.owner,f.mission.id)
  assert.equal(snapshot.tasks.find(t=>t.id===task.id).status,'blocked')
  assert.throws(()=>f.runtime.control(f.owner,f.mission.id,'complete','done'),/blocked required work/)
})
test('handoff fences immediately but replacement waits for quiescence',async t=>{
  const f=await setup(t); const task=await f.runtime.claim(f.actorA,f.mission.id,f.propose().id)
  let release; f.workers.stopGate=new Promise(resolve=>{release=resolve})
  f.runtime.handoff(f.actorA,f.mission.id,{taskId:task.id,attemptId:task.attempt.id,to:f.b.id,summary:'Open hypothesis and artifact pointers'})
  await assert.rejects(f.runtime.claim(f.actorB,f.mission.id,task.id),/not ready/)
  assert.throws(()=>f.runtime.publish(f.actorA,f.mission.id,{taskId:task.id,attemptId:task.attempt.id,claim:'late',outcome:'supported',toolRunIds:[]}),/Stale/)
  release()
  await new Promise(resolve=>setTimeout(resolve,20))
  const next=await f.runtime.claim(f.actorB,f.mission.id,task.id)
  assert.notEqual(next.attempt.id,task.attempt.id)
  assert.match(next.handoff,/Open hypothesis/)
  assert.deepEqual(f.workers.stopped,[f.a.id])
})
test('all workers draw from one step budget and peer text cannot alter authority',async t=>{
  const f=await setup(t,{maxSteps:2})
  await f.workers.callbacks.beforeStep(f.a.id)
  await f.workers.callbacks.beforeStep(f.b.id)
  await assert.rejects(f.workers.callbacks.beforeStep(f.a.id),/budget/)
  assert.equal(f.runtime.snapshot(f.owner,f.mission.id).mission.usedSteps,2)
  assert.match(f.workers.callbacks.guard(f.a.id,'bash'),/inactive/)
  assert.throws(()=>f.runtime.control(f.actorA,f.mission.id,'resume','peer GO'),/Only the user/)
})
test('pause preserves mission accounting and revokes old task attempts',async t=>{
  const f=await setup(t); const task=await f.runtime.claim(f.actorA,f.mission.id,f.propose().id)
  await f.workers.callbacks.usage(f.a.id,51)
  f.runtime.control(f.owner,f.mission.id,'pause','User interruption')
  let s=f.runtime.snapshot(f.owner,f.mission.id)
  assert.equal(s.tasks[0].status,'pending'); assert.equal(s.tasks[0].attempt,undefined)
  f.runtime.control(f.owner,f.mission.id,'resume','Continue')
  s=f.runtime.snapshot(f.owner,f.mission.id)
  assert.equal(s.mission.usedTokens,51)
  assert.throws(()=>f.runtime.publish(f.actorA,f.mission.id,{taskId:task.id,attemptId:task.attempt.id,claim:'late',outcome:'supported',toolRunIds:[]}),/Stale/)
})
test('store rejects concurrent runtime ownership and rolls back outbox with state',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'swarm-store-'));const path=join(dir,'state.sqlite')
  const store=new SwarmStore(path);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
  assert.throws(()=>new SwarmStore(path),/already owned/)
  assert.throws(()=>store.transaction(()=>{store.put('deliveries',{id:'m',missionId:'x',from:'a',to:'b',kind:'finding',content:'hello',createdAt:1});store.event('x','test','a',{});throw new Error('rollback')}),/rollback/)
  assert.equal(store.list('deliveries').length,0);assert.equal(store.events('x',10).length,0)
})
test('scope rules reject traversal and distinguish a directory from a similarly named sibling',()=>{
  assert.equal(withinScope('src/a.ts',['src/']),true)
  assert.equal(withinScope('src-other/a.ts',['src/']),false)
  assert.equal(withinScope('src/../secret',['**']),false)
  assert.equal(scopeSubset(['src/a.ts'],['src/']),true)
  assert.equal(scopeSubset(['**'],['src/']),false)
})

test('runtime admission canonicalizes path aliases without mutating caller arrays or widening mission scope', async t => {
  const f = await setup(t)
  const input = { title: 'Alias mission', objective: 'Inspect source', workspace: '/source', scope: ['./src/**'], acceptance: ['works'], budget }
  const before = structuredClone(input)
  const mission = f.runtime.create(f.owner, input)
  assert.deepEqual(input, before)
  assert.deepEqual(mission.scope, ['src/'])
  assert.deepEqual(f.runtime.snapshot(f.owner, mission.id).mission.scope, ['src/'])
  const scope = ['./src/a.ts']
  const task = f.propose(f.actorA, { scope })
  assert.deepEqual(scope, ['./src/a.ts'])
  assert.deepEqual(task.scope, ['src/a.ts'])
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).tasks[0].scope, ['src/a.ts'])
  assert.throws(() => f.propose(f.actorA, { scope: ['./src-other/**'] }), /task\.scope exceeds mission scope/)
  for (const selector of ['.', './', '/source/src/', './src/../secret', 'src/*.ts']) {
    assert.throws(() => f.runtime.create(f.owner, { ...input, scope: [selector] }), /scope\[0\].*is invalid/)
  }
  assert.equal(f.runtime.list(f.owner.sessionId).length, 2)
})

test('duplicate review source edges are removed but submission and unrelated accepted prerequisites still gate review', async t => {
  const f = await setup(t)
  const prerequisite = f.propose(f.actorA, { title: 'Prerequisite' })
  const source = f.propose(f.actorA, { title: 'Source' })
  const dependencies = [source.id, prerequisite.id, source.id]
  const review = f.propose(f.actorB, { kind: 'verification', reviewOf: source.id, dependencies, checks: [] })
  assert.deepEqual(dependencies, [source.id, prerequisite.id, source.id])
  assert.deepEqual(review.dependencies, [prerequisite.id])
  assert.equal(review.reviewOf, source.id)
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(task => task.id === review.id).dependencies, [prerequisite.id])
  await assert.rejects(f.runtime.claim(f.actorB, f.mission.id, review.id), /not ready/)
  const sourceClaim = await f.runtime.claim(f.actorA, f.mission.id, source.id)
  await f.runtime.submit(f.actorA, f.mission.id, { taskId: source.id, attemptId: sourceClaim.attempt.id, output: 'Source submitted' })
  await assert.rejects(f.runtime.claim(f.actorB, f.mission.id, review.id), /not ready/)
  const prerequisiteClaim = await f.runtime.claim(f.actorA, f.mission.id, prerequisite.id)
  await f.runtime.submit(f.actorA, f.mission.id, { taskId: prerequisite.id, attemptId: prerequisiteClaim.attempt.id, output: 'Prerequisite submitted' })
  const prerequisiteReview = f.propose(f.actorB, { kind: 'verification', reviewOf: prerequisite.id, checks: [] })
  const prerequisiteReviewClaim = await f.runtime.claim(f.actorB, f.mission.id, prerequisiteReview.id)
  await f.runtime.verify(f.actorB, f.mission.id, { taskId: prerequisiteReview.id, attemptId: prerequisiteReviewClaim.attempt.id, verdict: 'accept', reason: 'Independent prerequisite acceptance' })
  await assert.rejects(f.runtime.claim(f.actorA, f.mission.id, review.id), /not ready/)
  const claimed = await f.runtime.claim(f.actorB, f.mission.id, review.id)
  assert.equal(claimed.attempt.ownerId, f.b.id)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(task => task.id === source.id).status, 'submitted')
})

test('missing code checks reject a proposal without admitting work and permit correction on the same mission', async t => {
  const f = await setup(t)
  const before = f.runtime.snapshot(f.owner, f.mission.id)
  assert.throws(() => f.propose(f.actorA, { title: 'Implement value', checks: [] }), error => {
    assert.match(error.message, /task\.checks \(task "Implement value"\)/)
    assert.match(error.message, /real repository acceptance command/)
    assert.match(error.message, /same task\/request/)
    assert.match(error.message, /preserving acceptance criteria and budget/)
    return true
  })
  for (const checks of [[''], [' \n '], [12], 'node check.cjs']) {
    assert.throws(() => f.propose(f.actorA, { checks }), /task\.checks(?:\[0\])? must be/)
  }
  const after = f.runtime.snapshot(f.owner, f.mission.id)
  assert.deepEqual(after.tasks, before.tasks)
  assert.deepEqual(after.mission, before.mission)
  const corrected = f.propose(f.actorA, { title: 'Implement value', checks: ['node check.cjs'] })
  assert.equal(corrected.kind, 'implementation')
  assert.deepEqual(corrected.acceptance, ['works'])
  assert.deepEqual(corrected.checks, ['node check.cjs'])
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.length, 1)
})

test('read-only audit and report synthesis admit as research without code checks and retain independent review edges', async t => {
  const f = await setup(t)
  const audit = f.propose(f.actorA, { title: 'Audit repository', kind: 'research', checks: [] })
  const auditReview = f.propose(f.actorB, { title: 'Review audit', kind: 'verification', reviewOf: audit.id, checks: [] })
  const report = f.propose(f.actorA, { title: 'Synthesize findings', objective: 'Combine accepted audit evidence into a report',
    kind: 'research', dependencies: [audit.id], checks: [] })
  const reportReview = f.propose(f.actorB, { title: 'Review report', kind: 'verification', reviewOf: report.id, checks: [] })
  assert.deepEqual(report.dependencies, [audit.id])
  assert.equal(auditReview.reviewOf, audit.id)
  assert.equal(reportReview.reviewOf, report.id)
  assert.deepEqual(report.checks, [])
  await assert.rejects(f.runtime.claim(f.actorA, f.mission.id, report.id), /not ready/)
  const before = f.runtime.snapshot(f.owner, f.mission.id)
  assert.throws(() => f.propose(f.actorA, { title: 'Integrate code changes', kind: 'integration', checks: [] }), /task\.checks.*is required/)
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).tasks, before.tasks)
  assert.deepEqual(before.mission.acceptance, ['works'])
})

test('cumulative usage replay charges only unaccounted tokens and never reduces prior accounting',async t=>{
  const f=await setup(t)
  await f.workers.callbacks.usageSnapshot(f.a.id,125)
  await f.workers.callbacks.usageSnapshot(f.a.id,125)
  await f.workers.callbacks.usageSnapshot(f.a.id,100)
  await f.workers.callbacks.usageSnapshot(f.b.id,80)
  await f.workers.callbacks.usageSnapshot(f.a.id,150)
  assert.equal(f.runtime.snapshot(f.owner,f.mission.id).mission.usedTokens,230)
  assert.equal(f.runtime.snapshot(f.owner,f.mission.id).members.find(m=>m.id===f.a.id).accountedTokens,150)
})

test('an independently accepted repair retires blocked obligations and can converge through integration',async t=>{
  const f=await setup(t)
  async function submitAndReview(source, fail=false) {
    const claimed=await f.runtime.claim(f.actorA,f.mission.id,source.id)
    await f.runtime.submit(f.actorA,f.mission.id,{taskId:source.id,attemptId:claimed.attempt.id,output:'candidate'})
    const review=f.propose(f.actorB,{title:'Review',kind:'verification',reviewOf:source.id,checks:[]})
    const rc=await f.runtime.claim(f.actorB,f.mission.id,review.id)
    f.workers.checks=[{command:'test',exitCode:fail?1:0,output:fail?'failure':'ok'}]
    await f.runtime.verify(f.actorB,f.mission.id,{taskId:review.id,attemptId:rc.attempt.id,verdict:'accept',reason:'Checked exact artifact'})
    return review
  }
  const original=f.propose(); await submitAndReview(original,true)
  assert.throws(()=>f.propose(f.actorA,{replaces:[original.id],acceptance:['unrelated']}),/original obligations/)
  const repaired=f.propose(f.actorA,{title:'Repair',replaces:[original.id]});await submitAndReview(repaired)
  assert.equal(f.runtime.snapshot(f.owner,f.mission.id).tasks.find(t=>t.id===original.id).status,'cancelled')
  const integration=f.propose(f.actorA,{title:'Integrate',kind:'integration',dependencies:[repaired.id]});await submitAndReview(integration)
  assert.equal(f.runtime.control(f.owner,f.mission.id,'complete','Accepted integrated repair').status,'completed')
})

test('a disproved research hypothesis remains an accepted useful result after independent checks',async t=>{
  const f=await setup(t)
  const source=f.propose(f.actorA,{kind:'research',checks:[]})
  const claimed=await f.runtime.claim(f.actorA,f.mission.id,source.id)
  await f.workers.callbacks.toolRun(f.a.id,{tool:'bash',arguments:{command:'experiment'},result:{observation:'counterexample'},isError:false})
  const run=f.runtime.observe(f.actorA,f.mission.id).toolRuns[0]
  const evidence=f.runtime.publish(f.actorA,f.mission.id,{taskId:source.id,attemptId:claimed.attempt.id,claim:'The hypothesis is false',outcome:'disproved',toolRunIds:[run.id]})
  await f.runtime.submit(f.actorA,f.mission.id,{taskId:source.id,attemptId:claimed.attempt.id,output:'Useful negative result'})
  const review=f.propose(f.actorB,{kind:'verification',reviewOf:source.id,checks:[]})
  const rc=await f.runtime.claim(f.actorB,f.mission.id,review.id)
  f.workers.checks=[]
  await assert.rejects(f.runtime.verify(f.actorB,f.mission.id,{taskId:review.id,attemptId:rc.attempt.id,verdict:'accept',reason:'unsupported agreement'}),/independent host-recorded/)
  await f.workers.callbacks.toolRun(f.b.id,{tool:'bash',arguments:{command:'reproduce'},result:{observation:'counterexample'},isError:false})
  await f.runtime.verify(f.actorB,f.mission.id,{taskId:review.id,attemptId:rc.attempt.id,verdict:'accept',reason:'Counterexample independently reproduced'})
  const accepted=f.runtime.snapshot(f.owner,f.mission.id).evidence.find(e=>e.id===evidence.id)
  assert.equal(accepted.status,'verified'); assert.equal(accepted.outcome,'disproved')
  assert.equal(f.runtime.control(f.owner,f.mission.id,'complete','Research complete').status,'completed')
})
