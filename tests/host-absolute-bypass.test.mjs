/**
 * R11-12 / A2-01 regression: the host-absolute check refusal is not bypassed by
 * a backslash-escaped leading slash or a doubled leading slash. Both spellings
 * resolve to the same host path in a POSIX shell, so both are refused at both
 * admission call sites (`validatePlan` and `runtime.propose`).
 *
 * Pre-fix head: `absoluteCheckPaths` returned [] for `cat \/Users/…` and
 * `cat //Users/…`, while the shell read the host file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absoluteCheckPaths, classifyCheck, isCheckPattern, isSystemCheckPath, normalizeAbsolutePath, reconcileCheckPaths, shellSegments, shellTokens } from '../lib/admission.js'
import { validatePlan } from '../lib/plans.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { runProcess } from '../lib/workspaces.js'

const budget = { maxTokens: 100000, maxSteps: 200, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 0 }

function plan(workspace, checks) {
  return {
    title: 'Editable plan', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification',
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code' },
      { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration',
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks },
    ],
  }
}

test('A2-01: the shell really resolves \\/ and // to the same host path the scanner must refuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-a2-01-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'host-secret.txt')
  await writeFile(target, 'host state\n')
  for (const spelling of [target, `\\${target}`, `/${target}`, `//${target}`]) {
    const result = await runProcess(['/bin/sh', '-c', `test -f ${spelling} && echo READ`], { cwd: directory, timeoutMs: 10000, maxBytes: 2000 })
    assert.equal(result.output.trim(), 'READ', `${JSON.stringify(spelling)} must resolve to the same host file`)
  }
})

test('A2-01: the backslash-escaped and doubled leading-slash spellings are both absolute to the scanner', () => {
  const plain = '/Users/tongtao/secret'
  for (const command of [`cat ${plain}`, `cat \\${plain}`, `cat //${plain}`, `cat ///${plain}`, `cat '//${plain}'`]) {
    assert.deepEqual(absoluteCheckPaths(command), [plain], command)
    const diagnostics = reconcileCheckPaths(command, 'checks[0]')
    assert.equal(diagnostics.length, 1, command)
    assert.equal(diagnostics[0].code, 'check_absolute_path')
    assert.equal(diagnostics[0].path, plain)
  }
  // A URL is still not a host path, and a system location is still admitted.
  assert.deepEqual(absoluteCheckPaths('curl https://example.com/check.json'), [])
  assert.deepEqual(absoluteCheckPaths('curl http://127.0.0.1:5192/x'), [])
  assert.deepEqual(reconcileCheckPaths('/bin/sh -c "node check.cjs"', 'checks[0]'), [])
  assert.deepEqual(reconcileCheckPaths('node check.cjs', 'checks[0]'), [])
})

test('A2-01 class: a traversal or dot-segment through a system prefix normalizes to the host path before the exemption', () => {
  const plain = '/Users/tongtao/secret'
  assert.equal(normalizeAbsolutePath(`/usr/bin/../..//${plain.slice(1)}`), plain)
  assert.equal(normalizeAbsolutePath(`/usr/bin/./../..//${plain.slice(1)}`), plain)
  assert.equal(normalizeAbsolutePath('/usr/bin/../bin/sh'), '/usr/bin/sh')
  assert.equal(normalizeAbsolutePath('/bin/../bin/sh'), '/bin/sh')
  assert.equal(normalizeAbsolutePath('////usr//bin/./sh/'), '/usr/bin/sh/')
  for (const command of [`/usr/bin/../..//${plain.slice(1)} run pytest`, `/usr/bin/./../..//${plain.slice(1)} run pytest`, `/usr/bin/../../opt/homebrew/bin/node check.cjs`]) {
    const found = absoluteCheckPaths(command)
    assert.ok(found.length > 0, `the traversal spelling must yield a normalized path: ${command}`)
    const hostPaths = found.filter(candidate => !isSystemCheckPath(candidate))
    assert.deepEqual(hostPaths.length > 0, true, command)
    assert.equal(reconcileCheckPaths(command, 'checks[0]').length, 1, command)
  }
  // The normalized path decides the exemption: these resolve to system paths.
  for (const command of ['/usr/bin/../bin/sh -c "node check.cjs"', '/bin/../bin/sh -c true', '/usr/bin/./env node check.cjs']) {
    assert.deepEqual(reconcileCheckPaths(command, 'checks[0]'), [], command)
  }
})

test('R11-12 paired fix: pattern, separator and normalized-system arguments are not host paths', () => {
  for (const pattern of ['/', '/rejects/', '/(src|tests)/', '/[a-z]+/', '/Users/*/secret']) assert.equal(isCheckPattern(pattern), true, pattern)
  for (const path of ['/Users/tongtao/secret', '/tmp/swarm-probe', '/usr/bin/env']) assert.equal(isCheckPattern(path), false, path)
  for (const command of ['awk -F/ \'{print $1}\' package.json', 'sort -t/ -k1 file', 'tr / _ < file', 'cut -d/ -f1 file',
    'grep -E \'/(src|tests)/\' package.json', 'grep -E \'/[a-z]+/\' package.json', 'node --test --test-name-pattern=\'/rejects/\' tests/x.test.mjs']) {
    assert.deepEqual(reconcileCheckPaths(command, 'checks[0]'), [], command)
  }
})

test('R11-04: the POSIX-ish tokenizer resolves quoting and escapes the way the shell does', () => {
  assert.deepEqual(shellTokens('cat \\/abs').map(token => token.text), ['cat', '/abs'])
  assert.deepEqual(shellTokens('echo "a b" c').map(token => token.text), ['echo', 'a b', 'c'])
  assert.deepEqual(shellTokens("printf '%s' 'x y'").map(token => token.text), ['printf', '%s', 'x y'])
  assert.deepEqual(shellTokens('a;b|c&&d').map(token => token.text), ['a', ';', 'b', '|', 'c', '&', '&', 'd'])
  // `$(` keeps the substituted words visible; backticks stay verbatim (documented residual).
  assert.deepEqual(shellTokens('echo $(/abs/x)').map(token => token.text), ['echo', '$', '(', '/abs/x', ')'])
  assert.deepEqual(shellTokens('echo `/abs/x`').map(token => token.text), ['echo', '/abs/x'])
  // A single `&`, parens and heredoc bodies keep the R6 git-write semantics.
  assert.deepEqual(shellSegments('sleep 1 & git commit -m x').map(segment => segment.map(token => token.text)), [['sleep', '1', '&', 'git', 'commit', '-m', 'x']])
  assert.deepEqual(shellSegments('cd x && git add -A').map(segment => segment.map(token => token.text)), [['cd', 'x'], ['git', 'add', '-A']])
})

test('A2-01: both spellings are refused at validatePlan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-a2-01-plan-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  for (const check of ['cat \\/Users/tongtao/secret', 'cat //Users/tongtao/secret', 'test -f \\/Users/tongtao/secret']) {
    assert.throws(() => validatePlan(plan(directory, [check])), error => {
      assert.match(error.message, /\[check_absolute_path\]/, error.message)
      assert.match(error.message, /Users\/tongtao\/secret/, error.message)
      return true
    }, check)
  }
  assert.doesNotThrow(() => validatePlan(plan(directory, ['node check.cjs'])))
})

test('R11-12 follow-up: quoted, backtick, eval and nested-quote host paths are refused; URL values and prose stay admitted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-a2-01-quoted-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const host = '/Users/tongtao/secret'
  const refused = [
    `sh -c "cat ${host}"`,
    `sh -c 'cat ${host}'`,
    `cat \`echo ${host}\``,
    `eval "cat ${host}"`,
    `node -e "require('${host}')"`,
    `bash -c "cd ${host} && make"`,
    `echo "test -f ${host}"`,
    `PATH=:${host} node x.cjs`,
    `PATH=x:${host} node x.cjs`,
  ]
  for (const command of refused) {
    const diagnostics = reconcileCheckPaths(command, 'checks[0]')
    assert.equal(diagnostics.length, 1, `${command} -> ${JSON.stringify(absoluteCheckPaths(command))}`)
    assert.equal(diagnostics[0].code, 'check_absolute_path')
    assert.throws(() => validatePlan(plan(directory, [command])), /\[check_absolute_path\]/, command)
  }
  // A `<scheme>://…` value is a URL, and a slash inside a word is prose.
  for (const command of ['curl --url=https://example.com/check.json', 'PATH=x:https://example.com/check.json node x.cjs',
    'curl https://example.com/check.json', 'echo "a and/or b"', 'grep -E \'/(src|tests)/\' package.json',
    '/usr/bin/../bin/sh -c "node check.cjs"', 'node check.cjs']) {
    assert.deepEqual(reconcileCheckPaths(command, 'checks[0]'), [], command)
    assert.doesNotThrow(() => validatePlan(plan(directory, [command])), command)
  }
  // The T2c temp detector shares this scanner, so its quoted/backtick inputs are
  // seen again once T2c and T2b2c are integrated (cross-branch; not in this scope).
  assert.deepEqual(absoluteCheckPaths('sh -c "cat /tmp/t2b2c-probe"'), ['/tmp/t2b2c-probe'])
  assert.deepEqual(absoluteCheckPaths('cat `echo /tmp/t2b2c-probe`'), ['/tmp/t2b2c-probe'])
})

test('A2-01: both spellings are refused at runtime.propose', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-a2-01-runtime-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(mission, id) { return join(mission.workspace, id) },
    async start() {}, async prepareTask() {}, async deliver() {}, async stop() {},
    isIdle() { return false }, async dispose() {},
  }
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'a2-01-owner' }
  const mission = runtime.create(owner, { title: 'Bypass', objective: 'Refuse host paths', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const propose = checks => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Fix', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks })
  for (const check of ['cat \\/Users/tongtao/secret', 'cat //Users/tongtao/secret']) {
    assert.throws(() => propose([check]), /\[check_absolute_path\]/, check)
  }
  assert.equal(propose(['node check.cjs']).checks[0], 'node check.cjs')
})

test('R11-06: the classifier judges an npm script by its resolved body, not its name', () => {
  const scripts = {
    'test:deepseek': 'node --expose-internals scripts/smoke-deepseek.mjs',
    'test:sidebar-service': 'node scripts/smoke-better-sidebar.mjs',
    'test:command-deepseek': 'node --expose-internals scripts/smoke-command-deepseek.mjs',
    'test:validation-repair-web': 'node scripts/smoke-command-web.mjs --validation-repair',
    disguised: 'npm run test:deepseek',
    worker: 'node --test tests/*.test.mjs',
  }
  for (const name of ['test:deepseek', 'test:sidebar-service', 'test:command-deepseek', 'test:validation-repair-web']) {
    const classification = classifyCheck(`npm run ${name}`, scripts)
    assert.equal(classification.runnable, 'host-only', name)
    assert.equal(classification.code, 'check_requires_host')
    assert.ok(classification.requirement.length > 0)
  }
  assert.match(classifyCheck('npm run disguised', scripts).requirement, /resolves to/, 'a neutral name is refused by its resolved body')
  assert.equal(classifyCheck('npm run disguised', scripts).runnable, 'host-only', 'a neutral name cannot launder a host-only body')
  assert.equal(classifyCheck('npm run worker', scripts).runnable, 'worker')
  assert.equal(classifyCheck('npm run test:webhook', scripts).runnable, 'worker', 'an unknown script is not refused by name')
})
