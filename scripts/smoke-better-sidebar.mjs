/** Exact installed Better Sidebar service contract; no full plugin or web host loads. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { build } from 'tsdown'
import { createSidebarAdapter } from '../lib/types/client/sidebar.js'

const project = fileURLToPath(new URL('../', import.meta.url))
const installed = await realpath(resolve(process.env.DSH_BETTER_SIDEBAR_ROOT ?? join(homedir(), '.dsh/profiles/web/node_modules/dsh-better-sidebar')))
const reportPath = resolve(process.env.DSH_SIDEBAR_REPORT ?? join(project, 'artifacts/sidebar/better-sidebar-service.json'))
const temp = await mkdtemp(join(tmpdir(), 'dsh-swarm-sidebar-service-'))
const ctx = new Context()
const checks = []
const timers = new Set()
const priorGlobals = new Map(['window', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const boundary = {
  actualCode: 'Installed Better Sidebar service, state reducers and store; compiled Agent Swarm sidebar adapter; actual installed Harness Cordis.',
  simulatedEnvironment: 'An in-memory browser window/localStorage shim; no DOM rendering, web transport, models or user profile writes.',
  wholePluginLoaded: false,
  provesWholePluginCompatibility: false,
  limitation: 'This verifies the installed Better Sidebar service contract and adapter lifecycle only; it does not load the full Better Sidebar host/client package.',
}
const report = { status: 'running', startedAt: new Date().toISOString(), boundary, checks }
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'Cordis service dependency should settle')
}
try {
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-better-sidebar')
  assert.equal(manifest.version, '0.18.0', 're-review the service contract before accepting a different installed version')
  report.installedPackage = { name: manifest.name, version: manifest.version, source: installed }
  report.sourceSHA256 = {}
  for (const file of ['src/client/service.ts', 'src/client/state.ts', 'src/client/breakpoints.ts', 'src/client/paths.ts', 'src/prefs-shared.ts']) {
    report.sourceSHA256[file] = createHash('sha256').update(await readFile(join(installed, file))).digest('hex')
  }
  report.compiledAdapterSHA256 = createHash('sha256').update(await readFile(join(project, 'lib/types/client/sidebar.js'))).digest('hex')
  const cordis = JSON.parse(await readFile(join(project, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8'))
  report.cordisVersion = cordis.version
  await access(join(project, 'node_modules/react'))
  await symlink(join(project, 'node_modules'), join(temp, 'node_modules'), 'dir')
  const entry = join(temp, 'actual-sidebar.ts')
  await writeFile(entry, [
    `export { createBetterSidebarService } from ${JSON.stringify(join(installed, 'src/client/service.ts'))};`,
    `export { createSidebarStore, allLeaves } from ${JSON.stringify(join(installed, 'src/client/state.ts'))};`,
  ].join('\n'))
  await build({
    config: false, entry: [entry], outDir: join(temp, 'bundle'), format: 'esm', platform: 'node',
    target: 'node22', dts: false, clean: true,
    deps: { neverBundle: ['react'], alwaysBundle: id => id !== 'react' },
    outputOptions: { entryFileNames: 'actual-sidebar.mjs' },
  })
  const memory = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(String(key)) ?? null,
    setItem: (key, value) => { memory.set(String(key), String(value)) },
    removeItem: key => { memory.delete(String(key)) },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerWidth: 1280, innerHeight: 900, location: { search: '' },
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer) },
  } })
  const { createBetterSidebarService, createSidebarStore, allLeaves } = await import(pathToFileURL(join(temp, 'bundle/actual-sidebar.mjs')))
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  assert.equal(service.version, manifest.version)
  const tabs = state => allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'agent-swarm')
  let adapter
  const descriptor = { id: 'agent-swarm', single: true, title: () => 'Agent Swarm', component: props => props }
  const feature = ctx.plugin({ name: 'swarm-actual-sidebar-consumer', apply(scope) {
    adapter = createSidebarAdapter(scope, () => descriptor)
  } })
  await feature
  assert.equal(adapter.getSnapshot(), false)
  assert.equal(adapter.open(), false)
  checks.push('Absent optional service keeps fallback ownership and performs no tab open.')

  const transitions = []
  adapter.subscribe(() => transitions.push(adapter.getSnapshot()))
  const provider = ctx.plugin({ name: 'actual-better-sidebar-service', apply(scope) { scope.provide('betterSidebar', service) } })
  await provider
  await until(() => adapter.getSnapshot())
  assert.equal(service.getTab('agent-swarm').component, descriptor.component)
  assert.equal(typeof service.getTab('agent-swarm').createTab, 'function')
  assert.equal(service.getTabs().filter(tab => tab.id === 'agent-swarm').length, 1)
  checks.push('Compiled adapter registers exactly one descriptor in the genuine installed registry through actual Cordis.')

  store.setSession('owner-a')
  store.update(state => { state.panelOpen = false })
  assert.equal(adapter.open(), true)
  assert.equal(adapter.open(), true)
  assert.equal(tabs(store.getSnapshot().state).length, 1)
  assert.equal(tabs(store.getSnapshot().state)[0].title, 'Agent Swarm')
  assert.equal(store.getSnapshot().state.panelOpen, true, 'descriptor reveal patch opens the right panel')
  store.update(state => { state.panelOpen = false; state.bottomOpen = false; state.activePane = allLeaves(state.bottomSplits)[0].id })
  adapter.open()
  assert.equal(store.getSnapshot().state.panelOpen, true, 'an existing right-side tab opens its own panel even when the last active pane was below')
  assert.equal(store.getSnapshot().state.bottomOpen, false)
  checks.push('Public createTab reveal patches expand the owning right panel; repeated opens preserve one tab and the user-chosen placement.')

  store.setSession('bottom-owner')
  store.update(state => { state.panelOpen = false; state.bottomOpen = false; state.activePane = allLeaves(state.bottomSplits)[0].id })
  adapter.open()
  assert.equal(store.getSnapshot().state.bottomOpen, true)
  assert.equal(store.getSnapshot().state.panelOpen, false, 'a new tab in the bottom pane opens only that pane')
  store.update(state => { state.panelOpen = false; state.bottomOpen = false; state.activePane = allLeaves(state.splits)[0].id })
  adapter.open()
  assert.equal(store.getSnapshot().state.bottomOpen, true, 'reopening an existing bottom tab respects its placement')
  assert.equal(store.getSnapshot().state.panelOpen, false)
  window.innerWidth = 390
  store.update(state => { state.panelOpen = false; state.bottomOpen = false })
  adapter.open()
  assert.equal(store.getSnapshot().state.panelOpen, true, 'narrow viewports reveal the merged native drawer')
  assert.equal(store.getSnapshot().state.bottomOpen, false)
  window.innerWidth = 1280
  checks.push('Bottom-pane opens reveal the bottom workbench; mobile opens reveal the native merged drawer.')

  store.update(state => {
    const leaf = allLeaves(state.bottomSplits).find(leaf => leaf.tabs.some(tab => tab.type === 'agent-swarm'))
    const tab = leaf.tabs.find(tab => tab.type === 'agent-swarm')
    leaf.tabs = leaf.tabs.filter(item => item !== tab); leaf.active = null
    state.floats = [{ id: 'user-float', tab, x: 40, y: 50, w: 390, h: 650 }]
    state.panelOpen = false; state.bottomOpen = false
  })
  adapter.open()
  assert.equal(store.getSnapshot().state.floats.length, 1)
  assert.equal(store.getSnapshot().state.panelOpen, false)
  assert.equal(store.getSnapshot().state.bottomOpen, false)
  checks.push('A tab the user has floated stays in its existing window without opening unrelated panels.')

  store.setSession('owner-b')
  assert.equal(tabs(store.getSnapshot().state).length, 0)
  adapter.open()
  assert.equal(tabs(store.getSnapshot().state).length, 1)
  assert.equal(tabs(store.getSessionStates().get('owner-a')).length, 1)
  store.setSession('pinned-owner')
  store.update(state => { state.panelOpen = false; state.bottomOpen = false })
  store.setSession('owner-b')
  const beforeTargeted = store.getSnapshot()
  service.openTab({ type: 'agent-swarm' }, { sessionId: 'pinned-owner', cwd: '/isolated-pinned-workspace' })
  assert.equal(store.getSnapshot().sessionId, 'owner-b', 'targeted open never navigates the main session')
  assert.equal(store.getSnapshot(), beforeTargeted, 'targeted open leaves active panel geometry unchanged')
  assert.equal(store.getSessionStates().get('pinned-owner').panelOpen, false, 'inactive targeted opens do not force a later panel expansion')
  assert.equal(tabs(store.getSessionStates().get('pinned-owner')).length, 1)
  const pinnedProps = { scope: { sessionId: 'pinned-owner', cwd: '/isolated-pinned-workspace' }, visible: false }
  assert.equal(service.getTab('agent-swarm').component(pinnedProps), pinnedProps)
  checks.push('Genuine store isolates sessions and targeted opens; descriptor preserves pinned scope and hidden visibility.')

  await provider.dispose()
  await until(() => !adapter.getSnapshot())
  assert.equal(service.getTab('agent-swarm'), undefined)
  assert.equal(adapter.open(), false)
  assert.equal(tabs(store.getSessionStates().get('owner-a')).length, 1, 'unregistration preserves the host-owned saved layout')
  checks.push('Service removal unregisters the descriptor and restores fallback ownership while preserving saved tabs.')

  const replacement = createBetterSidebarService(store)
  await ctx.plugin({ name: 'replacement-actual-sidebar-service', apply(scope) { scope.provide('betterSidebar', replacement) } })
  await until(() => adapter.getSnapshot())
  assert.equal(replacement.getTab('agent-swarm').component, descriptor.component)
  await feature.dispose()
  assert.equal(replacement.getTab('agent-swarm'), undefined)
  assert.equal(adapter.getSnapshot(), false)
  adapter.dispose()
  assert.deepEqual(transitions, [true, false, true, false])
  checks.push('Service replacement re-registers once; feature unload and repeated disposal remove the contribution cleanly.')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
  process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  for (const timer of timers) clearTimeout(timer)
  for (const [key, prior] of priorGlobals) {
    if (prior) Object.defineProperty(globalThis, key, prior)
    else delete globalThis[key]
  }
  await rm(temp, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Better Sidebar service contract ${report.status}: ${checks.length} checks. Report: ${reportPath}\n`)
  if (report.error) process.stderr.write(`${report.error.stack ?? report.error}\n`)
}
