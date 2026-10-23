/**
 * F3: one rule chooses the plugin's store and workspaces roots
 * (src/state-roots.ts), at apply(), for both mounts. Each root comes from the
 * row's config, else `$DSH_AGENT_SWARM_ROOT`, else the Harness home +
 * `/agent-swarm`, where the home is the host's own `resolveDshHome` (a blank
 * `$DSH_HOME` is unset, `~` is expanded, a relative value is resolved). The
 * start report logs the roots once and warns once, naming both paths, when a
 * new store opens while a lower step of the rule already holds one.
 *
 * The OS home is a temporary directory for this whole file, so the default
 * step and the stores the report probes never touch the operator's `~/.dsh`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const osHome = realpathSync(mkdtempSync(join(tmpdir(), 'state-roots-home-')))
process.env.HOME = osHome
process.on('exit', () => rmSync(osHome, { recursive: true, force: true }))

const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
const { reportSwarmRoots, swarmRoots, SWARM_ROOT_ENV } = await import('../lib/state-roots.js')

const store = root => join(root, 'swarm.sqlite')
const workspaces = root => join(root, 'workspaces')
const defaultRoot = join(osHome, '.dsh', 'agent-swarm')

/** A logger that records every call. */
function recorder() {
  const calls = []
  return { calls, info: message => calls.push(['info', message]), warn: message => calls.push(['warn', message]) }
}

/** Create an (empty) store file, which is all the report probes. */
function touch(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

test('with nothing configured or set, both roots are the default Harness home\'s agent-swarm', () => {
  assert.equal(homedir(), osHome, 'the OS home of this file is the temporary one')
  assert.deepEqual(swarmRoots({}, {}), {
    statePath: store(defaultRoot),
    workspacesRoot: workspaces(defaultRoot),
    sources: { statePath: 'default', workspacesRoot: 'default' },
    otherStores: [],
  })
})

test('$DSH_HOME moves both roots with the Harness home, resolved exactly as the host resolves it', () => {
  const cases = [
    // [DSH_HOME, the root it gives, its source]
    ['/srv/dsh', '/srv/dsh/agent-swarm', 'DSH_HOME'],
    ['/srv/dsh/../other', '/srv/other/agent-swarm', 'DSH_HOME'],
    // A blank value is unset, as the host reads it, never `/agent-swarm`.
    ['', defaultRoot, 'default'],
    ['   ', defaultRoot, 'default'],
    // A leading `~` is the OS home and a relative value resolves against the cwd, never a relative root apply() refuses.
    ['~/trial', join(osHome, 'trial', 'agent-swarm'), 'DSH_HOME'],
    ['~', join(osHome, 'agent-swarm'), 'DSH_HOME'],
    ['rel/home', join(process.cwd(), 'rel', 'home', 'agent-swarm'), 'DSH_HOME'],
  ]
  for (const [value, root, source] of cases) {
    const env = { DSH_HOME: value }
    const roots = swarmRoots({}, env)
    assert.equal(roots.statePath, store(root), `DSH_HOME=${JSON.stringify(value)}`)
    assert.equal(roots.workspacesRoot, workspaces(root), `DSH_HOME=${JSON.stringify(value)}`)
    assert.equal(roots.statePath, join(resolveDshHome(undefined, env), 'agent-swarm', 'swarm.sqlite'), 'the home is the host\'s own resolveDshHome')
    assert.deepEqual(roots.sources, { statePath: source, workspacesRoot: source })
    // Only a home other than the default leaves the default home's store as a lower step.
    assert.deepEqual(roots.otherStores, root === defaultRoot ? [] : [store(defaultRoot)], `DSH_HOME=${JSON.stringify(value)}`)
  }
  assert.deepEqual(swarmRoots({}, { DSH_HOME: join(osHome, '.dsh') }).otherStores, [], 'a $DSH_HOME naming the default home is that home once')
})

test('$DSH_AGENT_SWARM_ROOT wins over the Harness home and is read by the same rule', () => {
  const home = { DSH_HOME: '/srv/dsh' }
  const roots = swarmRoots({}, { ...home, [SWARM_ROOT_ENV]: '/srv/preview' })
  assert.deepEqual(roots, {
    statePath: '/srv/preview/swarm.sqlite',
    workspacesRoot: '/srv/preview/workspaces',
    sources: { statePath: SWARM_ROOT_ENV, workspacesRoot: SWARM_ROOT_ENV },
    otherStores: ['/srv/dsh/agent-swarm/swarm.sqlite', store(defaultRoot)],
  })
  assert.equal(swarmRoots({}, { ...home, [SWARM_ROOT_ENV]: ' ' }).statePath, '/srv/dsh/agent-swarm/swarm.sqlite', 'a blank root is unset')
  assert.equal(swarmRoots({}, { [SWARM_ROOT_ENV]: '~/preview' }).statePath, join(osHome, 'preview', 'swarm.sqlite'))
  assert.equal(swarmRoots({}, { [SWARM_ROOT_ENV]: 'rel/preview' }).statePath, join(process.cwd(), 'rel', 'preview', 'swarm.sqlite'))
  assert.deepEqual(swarmRoots({}, { [SWARM_ROOT_ENV]: defaultRoot }).otherStores, [], 'a root naming the default one is that root once')
})

test('a configured root wins per field, must be absolute, and leaves no other store to report', () => {
  const env = { DSH_HOME: '/srv/dsh', [SWARM_ROOT_ENV]: '/srv/preview' }
  assert.deepEqual(swarmRoots({ statePath: '/cfg/state.sqlite' }, env), {
    statePath: '/cfg/state.sqlite',
    workspacesRoot: '/srv/preview/workspaces',
    sources: { statePath: 'config', workspacesRoot: SWARM_ROOT_ENV },
    otherStores: [],
  })
  assert.deepEqual(swarmRoots({ workspacesRoot: '/cfg/worktrees' }, env).sources, { statePath: SWARM_ROOT_ENV, workspacesRoot: 'config' })
  const both = swarmRoots({ statePath: '/cfg/state.sqlite', workspacesRoot: '/cfg/worktrees' }, env)
  assert.deepEqual([both.statePath, both.workspacesRoot], ['/cfg/state.sqlite', '/cfg/worktrees'])
  for (const config of [{ statePath: 'relative.sqlite' }, { workspacesRoot: 'relative' }, { statePath: '~/state.sqlite' }]) {
    assert.throws(() => swarmRoots(config, env), { message: 'Swarm statePath and workspacesRoot must be absolute' }, JSON.stringify(config))
  }
})

test('the start report logs the roots once, and warns once naming both paths when a new store opens beside a lower step\'s store', t => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'state-roots-')))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const trialHome = join(scratch, 'trial-home')
  const roots = swarmRoots({}, { DSH_HOME: trialHome })
  const trialStore = store(join(trialHome, 'agent-swarm'))

  // No store anywhere: the roots only.
  const quiet = recorder()
  assert.deepEqual(reportSwarmRoots(quiet, roots), [])
  assert.deepEqual(quiet.calls, [['info', `agent-swarm: store ${trialStore} ($DSH_HOME), workspaces ${workspaces(join(trialHome, 'agent-swarm'))} ($DSH_HOME)`]])

  // The default home holds a store and this home's is new: one warning names both.
  touch(store(defaultRoot))
  const warned = recorder()
  assert.deepEqual(reportSwarmRoots(warned, roots), [store(defaultRoot)])
  assert.deepEqual(warned.calls.map(([level]) => level), ['info', 'warn'])
  const [, warning] = warned.calls[1]
  assert.ok(warning.includes(`opening a new store at ${trialStore}`), warning)
  assert.ok(warning.includes(`a store already exists at ${store(defaultRoot)}`), warning)
  assert.ok(warning.includes(`set ${SWARM_ROOT_ENV}=${defaultRoot}`), warning)

  // Once this home's store exists it is not new, whatever else exists.
  touch(trialStore)
  const reopened = recorder()
  assert.deepEqual(reportSwarmRoots(reopened, roots), [])
  assert.deepEqual(reopened.calls.map(([level]) => level), ['info'])

  // A dropped or newly set $DSH_AGENT_SWARM_ROOT: every lower store is named in the one warning.
  const ownRoot = join(scratch, 'own-root')
  const moved = recorder()
  const own = swarmRoots({}, { DSH_HOME: trialHome, [SWARM_ROOT_ENV]: ownRoot })
  assert.deepEqual(reportSwarmRoots(moved, own), [trialStore, store(defaultRoot)])
  assert.deepEqual(moved.calls.map(([level]) => level), ['info', 'warn'])
  assert.ok(moved.calls[1][1].includes(`a store already exists at ${trialStore} and at ${store(defaultRoot)}`), moved.calls[1][1])
  assert.ok(moved.calls[1][1].includes(`set ${SWARM_ROOT_ENV}=${join(trialHome, 'agent-swarm')}`), 'the hint names the nearest store\'s root')

  // A configured store is the caller's statement: new or not, it is never warned about.
  const configured = recorder()
  assert.deepEqual(reportSwarmRoots(configured, swarmRoots({ statePath: join(scratch, 'configured', 'swarm.sqlite') }, { DSH_HOME: trialHome })), [])
  assert.deepEqual(configured.calls.map(([level]) => level), ['info'])
  assert.match(configured.calls[0][1], /\(configured\), workspaces .* \(\$DSH_HOME\)$/)

  // Logging never vetoes the plugin.
  assert.deepEqual(reportSwarmRoots({ info() { throw new Error('logger down') }, warn() {} }, own), [trialStore, store(defaultRoot)])
  assert.deepEqual(reportSwarmRoots(undefined, own), [trialStore, store(defaultRoot)])
})
