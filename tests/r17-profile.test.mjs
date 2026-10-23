/**
 * R17-G11 / mission acceptance 11: the platform is mountable by declaration.
 *
 * The shipped bundle package (`profile/`) declares its `dsh.bundle.patch`, its
 * prerequisite bundles, the supported Harness releases and the bundle layer it
 * conflicts with. Its composition, like the plugin package's own layer, inserts
 * the plugin row with no root of its own: the plugin chooses both roots at start
 * by one rule (F3, src/state-roots.ts). These tests prove, on this checkout:
 *
 *   1. the package metadata names the patch, the prerequisites, the supported
 *      Harness releases and the conflicting bundle layer;
 *   2. the shipped composition names no user-specific absolute path, and both
 *      mounts insert the row with an empty config, so neither carries a second
 *      copy of the root rule;
 *   3. the host's own profile loader (`loadProfile` + `composeEntries`, the same
 *      functions `dsh --profile` composes with) reads the declared bundle from
 *      a real profile directory into exactly one plugin row, and that row names
 *      the dual-face package whose `dsh.client` declaration mounts the Web
 *      client UI;
 *   4. the declared conflict is real: composing the plugin package's own bundle
 *      layer together with this one inserts the same row id twice;
 *   5. a real `dsh --profile web` host boots that profile, opens its store under
 *      `$DSH_HOME/agent-swarm` and serves the plugin's client bundle in the
 *      served boot graph;
 *   6. a real host on the DIRECT mount under an isolated `DSH_HOME` opens that
 *      home's store, not the default home's, logs the roots it chose, and warns
 *      once, naming both paths, that the default home already holds a store;
 *   7. a caller-supplied preview root moves both roots — through the `--patch`
 *      overlay the attended preview already uses, and through
 *      `DSH_AGENT_SWARM_ROOT`.
 *
 * Every host here runs with its own OS home (`HOME`) under the test root, so
 * the default step of the root rule never reaches the operator's `~/.dsh`.
 *
 * The profile directories these tests mount mirror the state that
 * `dsh plugin --profile web add file:<checkout>/profile` (or `link:<checkout>`
 * for the direct mount) leaves (the layer as a profile dependency plus its
 * payload resolvable) without invoking a package manager, so the declared check
 * needs no pnpm binary; the install command itself is exercised by the round's
 * recorded mounting evidence and by the attended deployment.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempDirectory } from './temp-root.mjs'
import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import { importHarness } from './fixtures/built-harness.mjs'

const project = fileURLToPath(new URL('..', import.meta.url))
const bundleDir = join(project, 'profile')
const harnessRoot = resolveHarnessRoot()
assertSupportedHarness(harnessRoot)
const harnessCli = join(harnessRoot, 'apps/cli/lib/bin.js')
await access(harnessCli)

const plugin = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const bundle = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
const compatibility = JSON.parse(await readFile(join(project, 'compatibility.json'), 'utf8'))
const { loadOverlayPatches, loadProfile, composeEntries } = await importHarness(harnessRoot, '@deepseek-ai/dsh-app-boot')
const shippedPatches = loadOverlayPatches('r17-profile-test', join(bundleDir, bundle.dsh.bundle.patch))
const shippedRow = shippedPatches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'dsh-external-agent-swarm')
const prerequisites = bundle.dsh.bundle.requires.bundles

/**
 * Mount the profile the same way the CLI install leaves it: the bundle declared
 * in `dsh.profile.bundles` with its payload resolvable beside it, or, for the
 * direct mount, the plugin package itself as the layer.
 */
async function mountProfile(root, { name = 'web', direct = false } = {}) {
  const home = join(root, 'home')
  const dir = join(home, 'profiles', name)
  const bundleLink = join(dir, 'node_modules', ...bundle.name.split('/'))
  const payloadLink = join(dir, 'node_modules', ...plugin.name.split('/'))
  await mkdir(dirname(payloadLink), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    // The declared prerequisites come first, then the layer — the order the bundle's metadata requires.
    dsh: { profile: { bundles: [...prerequisites, direct ? plugin.name : bundle.name] } },
  }, null, 2) + '\n')
  if (!direct) await symlink(bundleDir, bundleLink, 'dir')
  await symlink(project, payloadLink, 'dir')
  return { home, dir }
}

/** Boot one real Web host over a mounted profile; resolves at the authenticated launch URL. */
async function bootWeb({ root, home, patch, env = {} }) {
  const run = join(root, 'run')
  await mkdir(run, { recursive: true })
  const child = spawn(process.execPath, [
    '--expose-internals', harnessCli, '--profile', 'web',
    // The launcher's own flags end at the first token it does not know, so --patch precedes the app's.
    ...(patch === undefined ? [] : ['--patch', patch]),
    '--port', '0', '--no-open',
  ], {
    cwd: run,
    env: {
      ...process.env,
      // The host's own OS home: the default Harness home the root rule falls back to stays under this root.
      HOME: join(root, 'os-home'),
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_AGENTS_HOME: join(root, 'agents-home'),
      DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'),
      // A sandboxed host may only write under this root; keep every child temp there.
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not publish a launch URL:\n${output.slice(-4000)}`))
    }, 120_000)
    const settle = () => {
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', settle)
    child.stderr.on('data', settle)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited before readiness (${String(code)}):\n${output.slice(-4000)}`))
    })
  })
  return {
    child,
    url,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise(resolve => { child.once('exit', resolve) })
      child.kill('SIGTERM')
      const forced = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
      forced.unref()
      await exited
      clearTimeout(forced)
    },
  }
}

/** Exchange the launch token for the authenticated cookie and read the served index document. */
async function authenticatedIndex(url) {
  const exchange = await fetch(url, { redirect: 'manual' })
  assert.equal(exchange.status, 303, 'the launch URL must exchange its token for the auth cookie')
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'the token exchange must set the browser cookie')
  const page = await fetch(new URL('/', url).href, { headers: { cookie } })
  assert.equal(page.status, 200, 'the authenticated index must be served')
  return page.text()
}

/** Parse the client boot graph the served index publishes. */
function bootGraph(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  assert.ok(start >= 0, 'the served index must publish the client boot graph')
  const end = html.indexOf('</script>', start)
  return JSON.parse(html.slice(start + marker.length, end).trim().replace(/;$/, ''))
}

/** Poll a filesystem fact until it holds, so a slow host write is not read as a failure. */
async function until(condition, label, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('the bundle package declares its patch, prerequisites and conflicts in its own metadata', () => {
  assert.equal(bundle.dsh?.bundle?.patch, './cordis.patch.yml', 'the manifest must declare the patch document as the package content')
  assert.equal(bundle.version, plugin.version, 'the mount bundle and the platform it mounts ship as one release')
  assert.equal(bundle.files?.includes('cordis.patch.yml'), true, 'the packed bundle must carry the patch document')
  assert.deepEqual(bundle.dsh.bundle.requires.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], 'the prerequisites are the host layers the composition is applied over')
  assert.deepEqual(bundle.dsh.bundle.requires.harness, compatibility.supportedHosts.map(host => host.version), 'the declared Harness prerequisites must be exactly the supported releases')
  assert.deepEqual(bundle.dsh.bundle.conflicts.bundles, [plugin.name], 'the conflicting bundle layer is the plugin package, which inserts the same row')
  assert.equal(bundle.dependencies?.[plugin.name], 'file:..', 'the bundle carries the platform it mounts as its own dependency')
})

test('the shipped composition names no user-specific absolute path, and both mounts leave the roots to the plugin\'s one rule', () => {
  const text = readFileSync(join(bundleDir, bundle.dsh.bundle.patch), 'utf8')
  for (const forbidden of ['/Users/', '/home/', '/root/', project, process.cwd(), homedir()]) {
    assert.ok(!text.includes(forbidden), `the shipped composition must not name ${forbidden}`)
  }
  assert.ok(!text.includes('!!js'), 'the composition evaluates nothing: a second copy of the root rule would drift from the plugin\'s')
  assert.ok(shippedRow, 'the composition must insert the plugin row')
  assert.equal(shippedRow.name, plugin.name)
  assert.deepEqual(shippedRow.config, {}, 'the bundle row carries no root of its own')
  const directRow = loadOverlayPatches('r17-profile-test', join(project, 'cordis.patch.yml')).flatMap(patch => patch.insert ?? []).find(entry => entry.id === shippedRow.id)
  assert.deepEqual(directRow, shippedRow, 'the direct mount inserts the same row, so a mount switch cannot change the store')
})

test('the host profile loader composes the declared bundle into one plugin row, and the client UI rides that row', async () => {
  const root = await tempDirectory('dsh-swarm-profile-mount-')
  try {
    const { home } = await mountProfile(root)
    const profile = loadProfile('r17-profile-test', 'web', join(harnessRoot, 'apps/cli/package.json'), home)
    const layer = profile.layers.find(candidate => candidate.packageName === bundle.name)
    assert.ok(layer, 'the declared bundle must resolve from the profile directory')
    assert.deepEqual(layer.patchPaths.map(path => realpathSync(path)), [realpathSync(join(bundleDir, 'cordis.patch.yml'))], 'the composed layer must be the declared patch document')
    const rows = composeEntries(profile.layers.map(candidate => candidate.patches))
    const inserted = rows.filter(row => row.id === 'dsh-external-agent-swarm')
    assert.equal(inserted.length, 1, 'the declared composition must insert the plugin row exactly once')
    assert.equal(inserted[0].name, plugin.name)
    assert.deepEqual(inserted[0].config, {}, 'the composed row carries no root: the plugin chooses it at start')
    // A later layer — the deployment's --patch overlay — replaces the row's whole config,
    // so the caller supplies its preview root without editing the shipped composition.
    const callerRoot = join(root, 'caller-preview')
    const overlaid = composeEntries([...profile.layers.map(candidate => candidate.patches), [{
      id: 'dsh-external-agent-swarm',
      config: { statePath: join(callerRoot, 'swarm.sqlite'), workspacesRoot: join(callerRoot, 'worktrees') },
    }]])
    const overlaidRow = overlaid.find(row => row.id === 'dsh-external-agent-swarm')
    assert.equal(overlaidRow.config.statePath, join(callerRoot, 'swarm.sqlite'), 'the caller overlay must replace the shipped default root')
    assert.equal(overlaidRow.config.workspacesRoot, join(callerRoot, 'worktrees'))
    // The client UI mounts from this same row: the client module system scans
    // mounted rows for a package declaring dsh.client and serving ./client.
    assert.equal(plugin.dsh?.client?.platform, 'web', 'the inserted package must declare the Web client half')
    assert.ok(Array.isArray(plugin.dsh.client.inject) && plugin.dsh.client.inject.length > 0, 'the client half must declare its inject list')
    assert.equal(plugin.exports?.['./client']?.default, './lib/client.js')
    await access(join(project, 'lib/client.js'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the declared conflict is real: the plugin package layer would insert the same row id', () => {
  const pluginLayer = loadOverlayPatches('r17-profile-test', join(project, 'cordis.patch.yml'))
  const rows = composeEntries([pluginLayer, shippedPatches])
  const duplicate = rows.filter(row => row.id === 'dsh-external-agent-swarm')
  assert.equal(duplicate.length, 2, 'mounting both bundle layers duplicates the row, so the declared conflict is a real mount conflict')
})

test('a real dsh web host mounts the declared bundle at $DSH_HOME/agent-swarm and serves its client UI', { timeout: 180_000 }, async () => {
  const root = await tempDirectory('dsh-swarm-profile-boot-')
  let running
  try {
    const { home } = await mountProfile(root)
    running = await bootWeb({ root, home })
    const graph = bootGraph(await authenticatedIndex(running.url))
    const client = graph.entries.find(entry => entry.id === plugin.name)
    assert.ok(client, 'the client module system must mount the plugin package scanned from the composed row')
    // The boot graph references a client half relative to the document, as a one-entry combo of the plugin route.
    assert.equal(client.url, `plugins/??${plugin.name}/client.js&rev=${client.rev}`, 'the boot graph must serve the client bundle of the inserted row')
    assert.deepEqual(client.inject, plugin.dsh.client.inject, 'the mounted client half must carry the declared inject list')
    const store = join(home, 'agent-swarm', 'swarm.sqlite')
    await until(() => existsSync(store), 'the store under the Harness home')
  } finally {
    if (running !== undefined) await running.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the direct mount under an isolated DSH_HOME opens that home\'s store, logs it, and warns once naming the default home\'s store', { timeout: 180_000 }, async () => {
  const root = await tempDirectory('dsh-swarm-direct-root-')
  let running
  try {
    const { home } = await mountProfile(root, { direct: true })
    // The default Harness home of this host's OS home already holds a store: the
    // one a build that ignored DSH_HOME opened. An empty file stays empty only if
    // nothing opens it as a database.
    const defaultStore = join(root, 'os-home', '.dsh', 'agent-swarm', 'swarm.sqlite')
    await mkdir(dirname(defaultStore), { recursive: true })
    await writeFile(defaultStore, '')
    // The Web profile mounts no log exporter; this overlay adds the host's console
    // exporter so the plugin's start report reaches the host's output.
    const patch = join(root, 'console-logger.patch.yml')
    await writeFile(patch, JSON.stringify([{ insert: [{
      id: 'logger-console',
      name: pathToFileURL(join(harnessRoot, 'vendor/logger-console/lib/index.js')).href,
      // Cordis ranks a warning below info (ERROR 0, INFO 1, WARN 2), so warnings need threshold 2.
      config: { colors: false, showTime: '', levels: { default: 2 } },
    }] }], null, 2) + '\n')
    running = await bootWeb({ root, home, patch })
    const store = join(home, 'agent-swarm', 'swarm.sqlite')
    await until(() => existsSync(store), 'the store under the isolated Harness home')
    await until(() => running.output().includes('opening a new store'), 'the warning that names the default home\'s store')
    assert.equal(readFileSync(defaultStore).length, 0, 'the default home\'s store is never opened')
    const output = running.output()
    assert.ok(output.includes(`agent-swarm: store ${store} ($DSH_HOME), workspaces ${join(home, 'agent-swarm', 'workspaces')} ($DSH_HOME)`), output.slice(-4000))
    const warnings = output.split('\n').filter(line => line.includes('opening a new store'))
    assert.equal(warnings.length, 1, 'the warning is given once')
    assert.match(warnings[0], /^\[W\] /, 'it is logged as a warning')
    assert.ok(warnings[0].includes(store) && warnings[0].includes(defaultStore), `the warning names both paths: ${warnings[0]}`)
  } finally {
    if (running !== undefined) await running.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a caller-supplied preview root through the deployment --patch overlay moves both roots', { timeout: 180_000 }, async () => {
  const root = await tempDirectory('dsh-swarm-preview-root-')
  let running
  try {
    const { home } = await mountProfile(root)
    const previewRoot = join(root, 'preview')
    const patch = join(root, 'preview.patch.yml')
    // The attended preview's own overlay shape: the rows are addressed by id above the bundle layer.
    await writeFile(patch, JSON.stringify([{
      id: 'dsh-external-agent-swarm',
      config: { statePath: join(previewRoot, 'swarm.sqlite'), workspacesRoot: join(previewRoot, 'worktrees') },
    }], null, 2) + '\n')
    running = await bootWeb({ root, home, patch })
    bootGraph(await authenticatedIndex(running.url))
    await until(() => existsSync(join(previewRoot, 'swarm.sqlite')), 'the store at the caller-supplied preview root')
    assert.ok(!existsSync(join(home, 'agent-swarm', 'swarm.sqlite')), 'the shipped default must not open when the caller names a root')
  } finally {
    if (running !== undefined) await running.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH_AGENT_SWARM_ROOT supplies the caller root without editing the shipped composition', { timeout: 180_000 }, async () => {
  const root = await tempDirectory('dsh-swarm-environment-root-')
  let running
  try {
    const { home } = await mountProfile(root)
    const callerRoot = join(root, 'caller-root')
    running = await bootWeb({ root, home, env: { DSH_AGENT_SWARM_ROOT: callerRoot } })
    bootGraph(await authenticatedIndex(running.url))
    await until(() => existsSync(join(callerRoot, 'swarm.sqlite')), 'the store at the environment-supplied root')
    assert.ok(!existsSync(join(home, 'agent-swarm', 'swarm.sqlite')), 'the environment root must replace the default, not add to it')
  } finally {
    if (running !== undefined) await running.stop()
    await rm(root, { recursive: true, force: true })
  }
})
