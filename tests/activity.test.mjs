import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SwarmRuntime } from '../lib/runtime.js'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { runProcess } from '../lib/workspaces.js'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, LlmError, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(predicate) { for (let i=0;i<300;i++) { const value=predicate(); if(value) return value; await sleep(10) } assert.fail('Expected lifecycle transition') }
const budget = { maxTokens:100000, maxSteps:100, maxWorkers:2, maxDurationMs:60000, maxTasks:10, maxExperiments:1 }
class ControlledWorkers {
  current; stopped=[]; verification
  bind(callbacks) { this.callbacks=callbacks }
  async prepareWorkspace(m,id) { return `/isolated/${id}` }
  async start() {}
  async prepareTask() {}
  async deliver() {}
  isIdle() { return false }
  currentActivity() { return this.current }
  async stop(id) { this.current=undefined; this.stopped.push(id); this.verification?.resolve() }
  async dispose() {}
  async captureArtifact() { return {commit:'artifact',baseCommit:'base',workspace:'/isolated',changedPaths:['src/a']} }
  async verifyArtifact() { if(this.verification) await this.verification.promise; return [{command:'check',exitCode:0,output:'ok'}] }
}
async function runtimeFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'swarm-activity-')); const workers=new ControlledWorkers()
  const config={statePath:join(root,'state.sqlite'),leaseMs:100,tickMs:10,maxMessageChars:16000,maxEvents:100,maxTasksPerMember:3}
  const runtime=new SwarmRuntime(config,workers); await runtime.start()
  t.after(async()=>{await runtime.dispose();await rm(root,{recursive:true,force:true})})
  const owner={sessionId:'owner'}, mission=runtime.create(owner,{title:'Activity',objective:'Work',workspace:'/source',scope:['src/'],acceptance:['works'],budget})
  const stream=runtime.workstream(owner,mission.id,{title:'Code',objective:'Work'})
  const member=await runtime.addMember(owner,mission.id,{name:'Builder',role:'implementation'}), actor={sessionId:member.sessionId}
  const propose=(extra={})=>runtime.propose(owner,mission.id,{workstreamId:stream.id,title:'Task',objective:'Work',kind:'implementation',scope:['src/'],acceptance:['works'],checks:['check'],maxRecoveryAttempts:1,...extra})
  const task=await runtime.claim(actor,mission.id,propose().id)
  const snapshot=()=>runtime.snapshot(owner,mission.id)
  const activity={id:'owned-operation',kind:'tool',tool:'slow-tool',startedAt:Date.now(),updatedAt:Date.now()}
  return {root,runtime,workers,config,owner,mission,member,actor,task,propose,snapshot,activity}
}

test('owned long tools renew their original attempt without inventing progress; completion ends renewal', async t=>{
  const f=await runtimeFixture(t)
  f.workers.current=f.activity; f.workers.callbacks.activity(f.member.id,f.activity)
  await sleep(360)
  let snapshot=f.snapshot(); assert.equal(snapshot.tasks[0].attempt.id,f.task.attempt.id)
  assert.equal(snapshot.members[0].activity.attemptId,f.task.attempt.id)
  assert.equal(snapshot.members[0].activity.updatedAt,f.activity.updatedAt,'lease bookkeeping is not fresh work')
  f.workers.current=undefined; f.workers.callbacks.activity(f.member.id)
  await eventually(()=>f.snapshot().tasks[0].status==='blocked')
  snapshot=f.snapshot(); assert.equal(snapshot.members[0].activity,undefined); assert.equal(snapshot.tasks[0].recoveryCount,1)
})

test('persisted activity without a matching live adapter operation cannot prevent lease expiry',async t=>{
  const f=await runtimeFixture(t); f.workers.callbacks.activity(f.member.id,f.activity)
  await eventually(()=>f.snapshot().tasks[0].status==='blocked')
  assert.equal(f.snapshot().tasks[0].attempt,undefined)
})

test('pause clears activity synchronously and late observations cannot resurrect it',async t=>{
  const f=await runtimeFixture(t); f.workers.current=f.activity; f.workers.callbacks.activity(f.member.id,f.activity)
  f.runtime.control(f.owner,f.mission.id,'pause','Owner paused')
  f.workers.callbacks.activity(f.member.id,{...f.activity,updatedAt:Date.now()})
  assert.equal(f.snapshot().members[0].activity,undefined)
  assert.equal(f.snapshot().tasks[0].attempt,undefined)
})

test('deadline cancellation does not queue behind an active host verification',async t=>{
  const f=await runtimeFixture(t)
  await f.runtime.submit(f.actor,f.mission.id,{taskId:f.task.id,attemptId:f.task.attempt.id,output:'ready'})
  const reviewer=await f.runtime.addMember(f.owner,f.mission.id,{name:'Reviewer',role:'verification'})
  const review=await f.runtime.claim({sessionId:reviewer.sessionId},f.mission.id,f.propose({kind:'verification',reviewOf:f.task.id,checks:[]}).id)
  const mission=f.runtime.store.get('missions',f.mission.id);mission.deadline=Date.now()+100;f.runtime.store.transaction(()=>f.runtime.store.put('missions',mission))
  f.workers.verification=gate()
  const operation=f.runtime.verify({sessionId:reviewer.sessionId},f.mission.id,{taskId:review.id,attemptId:review.attempt.id,verdict:'accept',reason:'verified'})
  const outcome=operation.catch(error=>error)
  await eventually(()=>f.workers.stopped.length>0)
  assert.equal(f.snapshot().mission.status,'blocked')
  assert.ok(await outcome instanceof Error)
})

test('host recovery discards persisted running activity before publishing recovered members',async t=>{
  const f=await runtimeFixture(t);f.workers.current=f.activity;f.workers.callbacks.activity(f.member.id,f.activity)
  await f.runtime.dispose()
  const restored=new SwarmRuntime(f.config,new ControlledWorkers())
  try {await restored.start();assert.equal(restored.snapshot(f.owner,f.mission.id).members[0].activity,undefined)} finally {await restored.dispose()}
})

async function nativeFixture(t, responder, retry=false) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'swarm-native-activity-'))), source=join(root,'source');await mkdir(source)
  for(const args of [['init','--quiet'],['-c','user.name=Swarm','-c','user.email=swarm@localhost','commit','--allow-empty','--quiet','-m','base']]) assert.equal((await runProcess(['git',...args],{cwd:source,timeoutMs:30000,maxBytes:10000})).exitCode,0)
  const ctx=new Context();let adapter;const observed=[]
  t.after(async()=>{await adapter?.dispose();await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
  for(const plugin of [LlmRuntime,SessionStore,SessionProjection,SystemPrompt,ToolRuntime,AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence,{root:join(root,'sessions'),compression:'none',writeBatchMaxDelayMs:1})
  await ctx.plugin(SandboxPolicy,{mode:'read-only',workspaceRoot:source});await ctx.plugin(Approval,{policy:'never'});await ctx.plugin(AgentLoop,{agents:[]})
  if(retry) await ctx.plugin(LlmRetry)
  let calls=0
  class Scripted extends LlmAdapter {
    async resolveModel(provider,model) {return {provider,id:model,name:model}}
    providerRetryPolicy() { return retry ? resolveRetryPolicy({mode:'normal',maxRetries:1,backoff:{initialDelayMs:250,maxDelayMs:250,jitterRatio:0}},'test') : undefined }
    async *stream(options) {yield* responder(options,++calls)}
  }
  ctx.llm.registerAdapter(['activity-test'],new Scripted())
  await ctx.agents.create({sessionId:SessionId('activity-owner'),meta:{cwd:source},agentOptions:{provider:'activity-test',model:'scripted'}})
  adapter=new HarnessWorkers(ctx,{workspacesRoot:join(root,'worktrees'),checkTimeoutMs:30000,maxCheckOutputBytes:32000})
  adapter.bind({activity:(id,activity)=>observed.push(activity),idle(){},beforeStep:async()=>{},usage:async()=>{},toolRun:async()=>{},guard:()=>undefined,failure(){}})
  const mission={id:'activity-mission',workspace:source,objective:'Observe actual native operations'}, member={id:'activity-member',missionId:mission.id,sessionId:'activity-worker',name:'Builder',role:'implementation',workspace:await adapter.prepareWorkspace(mission,'activity-member')}
  await adapter.start({mission,member,ownerSessionId:'activity-owner'})
  const deliver=()=>adapter.deliver(member,{id:`input-${calls}`,missionId:mission.id,from:'owner',to:member.id,kind:'assignment',content:'Exercise the scripted lifecycle.',createdAt:Date.now()})
  return {ctx,adapter,member,observed,deliver,worker:ctx.agents.get(SessionId(member.sessionId))}
}
function* textChunks(text) {yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}}
function* toolChunks(name) {const id=ToolCallId('activity-call');yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:'{}'};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}}}

test('actual native streams and tool dispatch expose live activity and clear it when settled',async t=>{
  const model=gate(), tool=gate();t.after(()=>{model.resolve();tool.resolve()})
  const f=await nativeFixture(t,async function*(options,count){if(count===1){await model.promise;yield* toolChunks('slow_probe')}else yield* textChunks('done')})
  f.ctx.tools.register(defineContentToolFixture({name:'slow_probe',description:'A gated tool',parameters:{},execute:async()=>{await tool.promise;return [{type:'text',text:'finished'}]}}))
  await f.deliver();await eventually(()=>f.adapter.currentActivity(f.member.id)?.kind==='model')
  model.resolve();await eventually(()=>f.adapter.currentActivity(f.member.id)?.tool==='slow_probe')
  tool.resolve();await f.worker.whenIdle();assert.equal(f.adapter.currentActivity(f.member.id),undefined)
  assert.ok(f.observed.some(item=>item?.kind==='model'));assert.ok(f.observed.some(item=>item?.kind==='tool'));assert.equal(f.observed.at(-1),undefined)
})

test('native retry backoff has its own activity, then hands back to the next model request',async t=>{
  const f=await nativeFixture(t,async function*(_options,count){if(count===1) throw new LlmError('transient','TIMEOUT');yield* textChunks('recovered')},true)
  await f.deliver();const retry=await eventually(()=>f.adapter.currentActivity(f.member.id)?.kind==='retry' && f.adapter.currentActivity(f.member.id))
  assert.equal(retry.retryAttempt,1);assert.ok(retry.retryAt>retry.startedAt)
  await f.worker.whenIdle();assert.equal(f.adapter.currentActivity(f.member.id),undefined)
  assert.ok(f.observed.filter(item=>item?.kind==='model').length>=2)
})

test('cancelling an actual native model stream ends its liveness immediately',async t=>{
  const f=await nativeFixture(t,async function*(options){await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true})});yield* textChunks('cancelled')})
  await f.deliver();await eventually(()=>f.adapter.currentActivity(f.member.id)?.kind==='model')
  const stopping=f.adapter.stop(f.member.id);assert.equal(f.adapter.currentActivity(f.member.id),undefined);await stopping
  assert.equal(f.observed.at(-1),undefined)
})


test('frequent native activity touches advance state revisions without evicting coordination milestones',async t=>{
  const f=await runtimeFixture(t)
  f.workers.callbacks.activity(f.member.id,f.activity)
  const events=f.snapshot().events, revision=f.runtime.store.revision()
  for(let index=1;index<=150;index++) f.workers.callbacks.activity(f.member.id,{...f.activity,updatedAt:f.activity.updatedAt+index})
  assert.equal(f.runtime.store.revision(),revision+150)
  assert.equal(f.snapshot().members[0].activity.updatedAt,f.activity.updatedAt+150)
  assert.deepEqual(f.snapshot().events,events,'touch-only updates must not displace task/claimed and other milestones')
  f.workers.callbacks.activity(f.member.id,{...f.activity,id:'next-operation',kind:'model'})
  f.workers.callbacks.activity(f.member.id)
  assert.equal(f.snapshot().events.filter(event=>event.type==='member/activity').length,3,'begin, actual switch and end remain durable coordination events')
})
