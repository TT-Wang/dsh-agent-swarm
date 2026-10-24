/**
 * F3: one rule chooses the plugin's store and workspaces roots
 * (src/state-roots.ts), at apply(), for both mounts. Each root comes from the
 * row's config, else `$DSH_AGENT_SWARM_ROOT`, else the Harness home +
 * `/agent-swarm`, where the home is the host's own `resolveDshHome` (a blank
 * `$DSH_HOME` is unset, `~` is expanded, a relative value is resolved). The
 * start report is one line at info per start naming the roots it opened, the
 * step that chose each and whether the store is new; it looks for no other
 * store.
 *
 * The OS home is a temporary directory for this whole file, so the default
 * step and the stores this file creates never touch the operator's `~/.dsh`.
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

/** A logger that records every call, at every Cordis level. */
function recorder() {
  const calls = []
  const at = level => message => calls.push([level, message])
  return { calls, error: at('error'), info: at('info'), warn: at('warn'), debug: at('debug') }
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
  }
})

test('$DSH_AGENT_SWARM_ROOT wins over the Harness home and is read by the same rule', () => {
  const home = { DSH_HOME: '/srv/dsh' }
  const roots = swarmRoots({}, { ...home, [SWARM_ROOT_ENV]: '/srv/preview' })
  assert.deepEqual(roots, {
    statePath: '/srv/preview/swarm.sqlite',
    workspacesRoot: '/srv/preview/workspaces',
    sources: { statePath: SWARM_ROOT_ENV, workspacesRoot: SWARM_ROOT_ENV },
  })
  assert.equal(swarmRoots({}, { ...home, [SWARM_ROOT_ENV]: ' ' }).statePath, '/srv/dsh/agent-swarm/swarm.sqlite', 'a blank root is unset')
  assert.equal(swarmRoots({}, { [SWARM_ROOT_ENV]: '~/preview' }).statePath, join(osHome, 'preview', 'swarm.sqlite'))
  assert.equal(swarmRoots({}, { [SWARM_ROOT_ENV]: 'rel/preview' }).statePath, join(process.cwd(), 'rel', 'preview', 'swarm.sqlite'))
})

test('a configured root wins per field and must be absolute', () => {
  const env = { DSH_HOME: '/srv/dsh', [SWARM_ROOT_ENV]: '/srv/preview' }
  assert.deepEqual(swarmRoots({ statePath: '/cfg/state.sqlite' }, env), {
    statePath: '/cfg/state.sqlite',
    workspacesRoot: '/srv/preview/workspaces',
    sources: { statePath: 'config', workspacesRoot: SWARM_ROOT_ENV },
  })
  assert.deepEqual(swarmRoots({ workspacesRoot: '/cfg/worktrees' }, env).sources, { statePath: SWARM_ROOT_ENV, workspacesRoot: 'config' })
  const both = swarmRoots({ statePath: '/cfg/state.sqlite', workspacesRoot: '/cfg/worktrees' }, env)
  assert.deepEqual([both.statePath, both.workspacesRoot], ['/cfg/state.sqlite', '/cfg/worktrees'])
  for (const config of [{ statePath: 'relative.sqlite' }, { workspacesRoot: 'relative' }, { statePath: '~/state.sqlite' }]) {
    assert.throws(() => swarmRoots(config, env), { message: 'Swarm statePath and workspacesRoot must be absolute' }, JSON.stringify(config))
  }
})

test('the start report is one info line per start naming the roots it opened and whether the store is new, and it names no other store', t => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'state-roots-')))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const trialHome = join(scratch, 'trial-home')
  const roots = swarmRoots({}, { DSH_HOME: trialHome })
  const trialStore = store(join(trialHome, 'agent-swarm'))
  const trialLine = `agent-swarm: store ${trialStore} ($DSH_HOME, new), workspaces ${workspaces(join(trialHome, 'agent-swarm'))} ($DSH_HOME)`

  // No store anywhere: the roots, and that the store is new.
  const quiet = recorder()
  assert.equal(reportSwarmRoots(quiet, roots), undefined)
  assert.deepEqual(quiet.calls, [['info', trialLine]])

  // The default home holds a store, as does a root this environment does not name: the line is the same.
  // Under an isolated home the default home's store can be another live host's,
  // so whether it is this host's to keep is the operator's call (the upgrade note),
  // never advice the start line gives.
  touch(store(defaultRoot))
  touch(store(join(scratch, 'dropped-root')))
  const beside = recorder()
  reportSwarmRoots(beside, roots)
  assert.deepEqual(beside.calls, [['info', trialLine]], 'one line, at info, the rank an exporter shows by default')

  // Once this home's store exists it is not new.
  touch(trialStore)
  const reopened = recorder()
  reportSwarmRoots(reopened, roots)
  assert.deepEqual(reopened.calls, [['info', trialLine.replace(', new)', ')')]])

  // Each root names the step that chose it.
  const own = recorder()
  const ownRoot = join(scratch, 'own-root')
  reportSwarmRoots(own, swarmRoots({ workspacesRoot: join(scratch, 'configured') }, { DSH_HOME: trialHome, [SWARM_ROOT_ENV]: ownRoot }))
  assert.deepEqual(own.calls, [['info', `agent-swarm: store ${store(ownRoot)} ($${SWARM_ROOT_ENV}, new), workspaces ${join(scratch, 'configured')} (configured)`]])
  const configured = recorder()
  reportSwarmRoots(configured, swarmRoots({ statePath: join(scratch, 'configured', 'swarm.sqlite') }, {}))
  assert.deepEqual(configured.calls, [['info', `agent-swarm: store ${join(scratch, 'configured', 'swarm.sqlite')} (configured, new), workspaces ${workspaces(defaultRoot)} (default home)`]])

  // Logging never vetoes the plugin.
  assert.doesNotThrow(() => reportSwarmRoots({ info() { throw new Error('logger down') } }, roots))
  assert.doesNotThrow(() => reportSwarmRoots(undefined, roots))
})
