/**
 * apply() logs an error, never throws, when the Harness it runs on is not one of
 * the supported releases: 0.1.5-rc.3 has no peer-version gate and neither host
 * reads the profile's requires.harness. The version is the manifest of the
 * `@deepseek-ai/dsh-session` package the plugin resolves; the unsupported case
 * gives a copy of the built plugin the module-proxy layout a 0.1.6-alpha.2 host
 * installs (a package directory whose manifest names that version and whose
 * entry re-exports the real package), so no other Harness is needed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadedHarnessVersion, reportHarnessSupport, SUPPORTED_HARNESS_RELEASES } from '../lib/host-version.js'

const project = fileURLToPath(new URL('../', import.meta.url))
const read = path => JSON.parse(readFileSync(join(project, path), 'utf8'))

/** A logger that records every call. */
function recorder() {
  const calls = []
  return { calls, error: message => calls.push(['error', message]), warn: message => calls.push(['warn', message]) }
}

/** apply() of the plugin at `pluginRoot` with relative state paths, in a child: its log calls and its refusal. */
function applyIn(pluginRoot) {
  const script = `const calls = []
const logger = { error: message => calls.push(['error', String(message)]), warn: message => calls.push(['warn', String(message)]), info() {}, debug() {} }
const { apply } = await import(${JSON.stringify(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)})
try { await apply({ logger }, { statePath: 'relative.sqlite', workspacesRoot: 'relative' }) } catch (error) { calls.push(['threw', error.message]) }
console.log(JSON.stringify(calls))`
  return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: pluginRoot }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))))
}

test('the supported releases the plugin checks at runtime are exactly compatibility.json\'s, its peer ranges\' and the profile\'s', () => {
  const versions = read('compatibility.json').supportedHosts.map(host => host.version)
  assert.deepEqual(SUPPORTED_HARNESS_RELEASES, versions)
  assert.deepEqual(read('profile/package.json').dsh.bundle.requires.harness, versions)
  for (const [name, range] of Object.entries(read('package.json').peerDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, versions.join(' || '), name)
})

test('the version is read from the Harness package the plugin resolves, linked or behind a module proxy', t => {
  const root = mkdtempSync(join(tmpdir(), 'host-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.ok(SUPPORTED_HARNESS_RELEASES.includes(loadedHarnessVersion()), 'the linked Harness under test is a supported release')
  // A linked package: the entry is below the package root.
  mkdirSync(join(root, 'linked/lib'), { recursive: true })
  writeFileSync(join(root, 'linked/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.6-alpha.2' }))
  writeFileSync(join(root, 'linked/lib/package.json'), JSON.stringify({ type: 'module' }))
  assert.equal(loadedHarnessVersion(() => pathToFileURL(join(root, 'linked/lib/index.js')).href), '0.1.6-alpha.2')
  // The host's module proxy: entry-0.js next to the manifest.
  mkdirSync(join(root, 'proxy'))
  writeFileSync(join(root, 'proxy/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.2-rc.1', private: true }))
  assert.equal(loadedHarnessVersion(() => pathToFileURL(join(root, 'proxy/entry-0.js')).href), '0.1.2-rc.1')
  assert.equal(loadedHarnessVersion(() => { throw new Error('not resolvable') }), undefined)
})

test('an unsupported release is logged as an error, an unreadable one as a warning, a supported one not at all; none throws', () => {
  const unsupported = recorder()
  assert.equal(reportHarnessSupport(unsupported, () => '0.1.6-alpha.2'), 'unsupported')
  assert.deepEqual(unsupported.calls.map(([level]) => level), ['error'])
  assert.match(unsupported.calls[0][1], /^agent-swarm: Unsupported Harness 0\.1\.6-alpha\.2; supported: 0\.1\.5-rc\.3, 0\.1\.7-rc\.1\./)
  const unknown = recorder()
  assert.equal(reportHarnessSupport(unknown, () => undefined), 'unknown')
  assert.deepEqual(unknown.calls.map(([level]) => level), ['warn'])
  for (const version of SUPPORTED_HARNESS_RELEASES) {
    const quiet = recorder()
    assert.equal(reportHarnessSupport(quiet, () => version), 'supported')
    assert.deepEqual(quiet.calls, [])
  }
  assert.equal(reportHarnessSupport({ error() { throw new Error('logger down') }, warn() {} }, () => '0.1.6-alpha.2'), 'unsupported')
  assert.equal(reportHarnessSupport(undefined, () => '0.1.6-alpha.2'), 'unsupported')
})

test('apply() logs an unsupported host once and goes on; on the supported Harness under test it logs nothing', async t => {
  const supported = await applyIn(project)
  assert.deepEqual(supported, [['threw', 'Swarm statePath and workspacesRoot must be absolute']])

  // The built plugin, installed the way a 0.1.6-alpha.2 host would install it.
  const root = mkdtempSync(join(tmpdir(), 'host-version-apply-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugin = join(root, 'plugin')
  cpSync(join(project, 'lib'), join(plugin, 'lib'), { recursive: true })
  cpSync(join(project, 'package.json'), join(plugin, 'package.json'))
  const modules = join(project, 'node_modules')
  mkdirSync(join(plugin, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const entry of readdirSync(modules).filter(name => name !== '@deepseek-ai')) symlinkSync(realpathSync(join(modules, entry)), join(plugin, 'node_modules', entry))
  for (const entry of readdirSync(join(modules, '@deepseek-ai')).filter(name => name !== 'dsh-session')) symlinkSync(realpathSync(join(modules, '@deepseek-ai', entry)), join(plugin, 'node_modules/@deepseek-ai', entry))
  const proxy = join(plugin, 'node_modules/@deepseek-ai/dsh-session')
  const target = JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-session'))
  mkdirSync(proxy)
  writeFileSync(join(proxy, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.6-alpha.2', private: true, type: 'module', exports: { '.': './entry-0.js' } }))
  writeFileSync(join(proxy, 'entry-0.js'), `export * from ${target}\nimport * as target from ${target}\nexport default target.default\n`)
  const calls = await applyIn(plugin)
  assert.equal(calls.length, 2, JSON.stringify(calls))
  assert.equal(calls[0][0], 'error')
  assert.match(calls[0][1], /^agent-swarm: Unsupported Harness 0\.1\.6-alpha\.2; supported: 0\.1\.5-rc\.3, 0\.1\.7-rc\.1\./)
  assert.deepEqual(calls[1], ['threw', 'Swarm statePath and workspacesRoot must be absolute'], 'the check logs and apply() carries on to its own validation')
})
