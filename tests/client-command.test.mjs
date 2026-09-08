import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerSwarmCommand } from '../lib/command.js'
import { registerSwarmCommandUi, SwarmCommandCard } from '../lib/types/client/command.js'

const require = createRequire(import.meta.url)
const nativeFile = (packageName, filename) => pathToFileURL(join(dirname(require.resolve(`${packageName}/package.json`)), filename))
// The public browser export is a module-protocol closure, not a Node ESM entry.
// Evaluate the exact built client bundles with shared platform identities.
const nativeModules = new Map()
const styleLoader = registerHooks({ load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
  return nextLoad(url, context)
} })
async function nativeClient(packageName) {
  let exports
  runInNewContext(await readFile(nativeFile(packageName, 'lib/client.js'), 'utf8'), {
    setTimeout, clearTimeout, AbortController, queueMicrotask,
    window: { __ModuleLoader__: { load({ factory }) { exports = factory(id => nativeModules.get(id) ?? require(id)) } } },
  })
  nativeModules.set(`${packageName}/client`, exports)
  return exports
}
const { SlotRegistry } = await nativeClient('@deepseek-ai/dsh-client-ui-renderer')
const { CommandUiRuntime } = await nativeClient('@deepseek-ai/dsh-client-ui-commands')
styleLoader.deregister()

/** Real native command client and Cordis registries; only transport/agents are substituted. */
async function commandBench(t, start = async () => ({ kind: 'success', text: '正在规划并启动协作任务。' })) {
  let definition
  registerSwarmCommand({ commands: { register(value) { definition = value; return () => {} } } }, { start })
  const descriptor = { name: definition.name, description: definition.description, input: definition.input }
  const ctx = new Context()
  const sources = new Map()
  const requests = []
  let current = 'owner-a', opens = 0
  const commands = {
    list: async () => ({ ok: true, value: [descriptor] }),
    execute: async (sessionId, line) => {
      requests.push({ sessionId, line })
      const result = await definition.handler({ agent: { id: sessionId }, commandId: `command-${requests.length}`,
        source: { kind: 'user' }, signal: new AbortController().signal, rawInput: line.slice('/agent-swarm'.length) })
      return { ok: true, value: { commandId: `command-${requests.length}`, result } }
    },
  }
  ctx.provide('locale', { bind: () => text => text })
  ctx.provide('inputTriggers', { registerSource(source) { sources.set(source.name, source); return () => sources.delete(source.name) } })
  ctx.provide('sessions', { subagentAddress: () => undefined, list: { getSnapshot: () => ({ current }) } })
  ctx.provide('remote', { commands, $on() { return () => {} } })
  ctx.provide('remote.commands', commands)
  const slots = ctx.plugin(SlotRegistry)
  await slots
  const surface = ctx.plugin({ name: 'test-command-view-surface', inject: ['slots'], apply(host) {
    host.slots.register({ name: 'root', children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } } }, () => null)
  } })
  await surface
  const native = ctx.plugin(CommandUiRuntime)
  await native
  const feature = ctx.plugin({ name: 'test-swarm-command-ui', inject: ['slots', 'sessions'], apply(host) {
    registerSwarmCommandUi(host, { openSidebar: () => { opens++ }, copy: text => text })
  } })
  await feature
  t.after(async () => { await feature.dispose(); await native.dispose(); await surface.dispose(); await slots.dispose() })
  return { ctx, feature, native, sources, requests, descriptor,
    get opens() { return opens }, setCurrent(value) { current = value },
    source: sources.get('command'), session: { sessionId: 'owner-a' },
  }
}

test('native slash discovery and composer forward one natural-language request without a popup or extra send', async t => {
  const goals = []
  const b = await commandBench(t, async request => { goals.push(request.goal); return { kind: 'success' } })
  const rows = await b.source.candidates(b.session, { query: 'agent-sw', position: 'leading', signal: new AbortController().signal })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'agent-swarm')
  assert.equal(rows[0].hint, b.descriptor.input.hint)
  const menu = b.source.onPick({ candidate: rows[0], session: b.session, position: 'leading', via: 'menu', span: { start: 0, end: 10, draftRev: 1 } })
  assert.equal(menu.claim.token, '/agent-swarm ')
  assert.equal(b.source.matchSpace(b.session, '/agent-swarm').claim.token, menu.claim.token)
  assert.equal(b.requests.length, 0, 'menu selection only arms the free-form composer')
  const goal = '给项目添加搜索功能\n保留 "原有接口"，完成后运行测试。'
  const entered = await b.source.matchEnter(b.session, `/agent-swarm ${goal}`, new AbortController().signal, { images: 0, attachments: 0 })
  assert.equal((await entered.claim.submit(goal, {})).kind, 'success')
  assert.deepEqual(b.requests, [{ sessionId: 'owner-a', line: `/agent-swarm ${goal}` }])
  assert.deepEqual(goals, [goal])
  assert.equal(b.opens, 1)
})

test('bare native command advertises goal input and rejects an empty submission without starting workers', async t => {
  let starts = 0
  const b = await commandBench(t, () => { starts++; return { kind: 'success' } })
  const bare = await b.source.matchEnter(b.session, '/agent-swarm', new AbortController().signal, { images: 0, attachments: 0 })
  assert.equal(bare.claim.token, '/agent-swarm ')
  assert.equal(b.requests.length, 0)
  await bare.claim.submit('', {})
  assert.equal(starts, 0)
  assert.equal(b.opens, 0, 'native handler error is a durable command outcome, not a successful start')
})

test('successful acknowledgment is fenced to its selected session and registrations unload', async t => {
  let finish
  const b = await commandBench(t, () => new Promise(resolve => { finish = resolve }))
  const entered = await b.source.matchEnter(b.session, '/agent-swarm 完成任务', new AbortController().signal, { images: 0, attachments: 0 })
  const pending = entered.claim.submit('完成任务', {})
  b.setCurrent('owner-b')
  finish({ kind: 'success' })
  await pending
  assert.equal(b.opens, 0)
  b.ctx.emit('command/executed', 'owner-b', 'other-command', { kind: 'success' })
  b.ctx.emit('command/executed', 'owner-b', 'agent-swarm', { kind: 'error', text: 'failed' })
  assert.equal(b.opens, 0)
  assert.equal(b.ctx.slots.entries('conversation.chat.commandview').length, 1)
  await b.feature.dispose()
  b.ctx.emit('command/executed', 'owner-b', 'agent-swarm', { kind: 'success' })
  assert.equal(b.opens, 0)
  assert.equal(b.ctx.slots.entries('conversation.chat.commandview').length, 0)
  await b.native.dispose()
  assert.equal(b.sources.size, 0)
})

test('native command card keeps the original goal visible and reports pending, failed and successful outcomes', () => {
  const node = { kind: 'command', seq: 1, time: 1, commandId: 'cmd-1', name: 'agent-swarm', args: ' <script>bad()</script>\n修改搜索功能 ', outcome: null }
  const render = outcome => renderToStaticMarkup(React.createElement(SwarmCommandCard, { node: { ...node, outcome }, onOpenSidebar() {} }))
  const pending = render(null)
  assert.match(pending, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(pending, /<script>/)
  assert.match(pending, /Starting collaboration…/)
  assert.match(pending, /Open swarm sidebar/)
  assert.match(render({ kind: 'error', text: '仓库未初始化' }), /role="alert"[^>]*>仓库未初始化/)
  assert.match(render({ kind: 'success', text: '已自动启动' }), /已自动启动/)
})
