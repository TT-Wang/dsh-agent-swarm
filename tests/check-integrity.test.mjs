/**
 * Round 9-C check-integrity regressions (F4). Every test in this file fails on
 * the pre-fix head:
 *
 * 1. A foreign (Python) project keeps its interpreter in a gitignored project
 *    directory (`.venv`), not `node_modules`. Pre-fix only `node_modules` was
 *    materialised, so `.venv/bin/python -m pytest …` failed with exit 127 in
 *    the clean verification checkout.
 * 2. A declared check could name a host-absolute path (the benchmark repair
 *    swapped the check for `/Users/<owner>/code/<repo>/.venv/bin/python … ||
 *    /Users/<owner>/.local/bin/uv …` while preserving the acceptance text) and
 *    admission accepted it. Pre-fix no absolute path was inspected.
 *
 * The durable `task/check-changed` event that records a changed check on a
 * replacement or re-submission lives in `src/runtime.ts`, which this task's
 * declared scope excludes; it is delivered by the bounded companion task
 * F4b-checks with its own `tests/check-change-event.test.mjs` regression.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { validatePlan } from '../lib/plans.js'

const budget = { maxTokens: 100000, maxSteps: 200, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 0 }
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}

/** A Python-shaped source project whose toolchain lives in a gitignored `.venv`. */
async function pythonFixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-check-python-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'tests'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), '.venv/\nvenv/\nvendor/\n.tox/\n__pycache__/\n')
  await writeFile(path.join(source, 'tests', 'test_answer.py'), 'def test_answer():\n    assert 42 == 42\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  // The interpreter is a deterministic stand-in: it records the directory it
  // ran in and asserts the `-m pytest` argv, so the test proves that the
  // gitignored toolchain directory was materialised and invoked from the clean
  // checkout without requiring a real Python/pytest install on the host.
  await mkdir(path.join(source, '.venv', 'bin'), { recursive: true })
  await writeFile(path.join(source, '.venv', 'bin', 'python'), '#!/bin/sh\necho "venv-python cwd=$PWD args=$*"\ntest "$1" = "-m" && test "$2" = "pytest"\n')
  await chmod(path.join(source, '.venv', 'bin', 'python'), 0o755)
  // A Go-style vendor directory and a tox environment must be materialised too.
  await mkdir(path.join(source, 'vendor', 'tools'), { recursive: true })
  await writeFile(path.join(source, 'vendor', 'tools', 'marker'), 'vendored\n')
  await mkdir(path.join(source, '.tox', 'py', 'bin'), { recursive: true })
  await writeFile(path.join(source, '.tox', 'py', 'bin', 'python'), '#!/bin/sh\necho "tox-python"\n')
  await chmod(path.join(source, '.tox', 'py', 'bin', 'python'), 0o755)
  const seen = []
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000,
    confineCheck: (argv, cwd) => { seen.push(cwd); return argv }, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Fix the answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  await workspaces.prepareTask(member, task, [])
  await mkdir(path.join(member.workspace, 'src'), { recursive: true })
  await writeFile(path.join(member.workspace, 'src', 'answer.py'), 'ANSWER = 42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  return { temp, source, workspaces, member, task, artifact, seen }
}

test('a gitignored Python .venv is materialised so `.venv/bin/python -m pytest` runs in the clean checkout', async t => {
  const { source, workspaces, member, task, artifact, seen } = await pythonFixture(t)
  const results = await workspaces.verifyArtifact(member, { ...task, checks: [
    '.venv/bin/python -m pytest tests/test_answer.py',
    'test -e vendor/tools/marker && test -x .tox/py/bin/python && echo foreign-deps-materialised',
  ] }, artifact)
  assert.deepEqual(results.map(result => result.exitCode), [0, 0], JSON.stringify(results, null, 2))
  assert.equal(seen.length, 2, 'both declared checks ran')
  assert.match(results[0].output, new RegExp(`venv-python cwd=${escape(seen[0])}`), 'the interpreter runs in the clean checkout, not the source')
  assert.match(results[0].output, /args=-m pytest tests\/test_answer\.py/, 'the declared pytest argv reaches the interpreter')
  assert.match(results[1].output, /foreign-deps-materialised/, 'vendor and .tox are materialised as well')
  assert.equal((await lstat(path.join(source, '.venv'))).isDirectory(), true, 'the source venv stays a real directory')
  const tree = await git(source, 'ls-tree', '-r', '--name-only', artifact.commit)
  assert(!tree.includes('.venv') && !tree.includes('vendor') && !tree.includes('.tox'), 'materialised dependencies never enter the committed artifact')
})

function plan(workspace, overrides = {}) {
  return {
    title: 'Editable plan', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification',
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code' },
      { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration',
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'] },
    ],
    ...overrides,
  }
}

test('admission refuses a declared check that names a host-absolute path outside the system allowlist', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-check-paths-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const benchmark = `/Users/tongtao/code/memem-publish/.venv/bin/python -m pytest -q || /Users/tongtao/.local/bin/uv run pytest -q`
  const reject = checks => {
    const input = plan('/workspace')
    input.tasks[1].checks = checks
    assert.throws(() => validatePlan(input), error => {
      assert.match(error.message, /\[check_absolute_path\]/, error.message)
      assert.match(error.message, /clean verification checkout/, 'the diagnostic explains why it cannot run')
      assert.match(error.message, /checkout-relative/, 'the diagnostic names the repair')
      return true
    }, JSON.stringify(checks))
  }
  reject([benchmark])
  reject(['/Users/tongtao/.local/bin/uv run pytest'])
  reject(['/opt/homebrew/bin/node check.cjs'])
  reject(['"/Users/tongtao/code/memem-publish/.venv/bin/python" -m pytest'])
  reject(['PATH=/Users/tongtao/code/memem-publish/.venv/bin:$PATH python -m pytest'])
  // The clean checkout is a fresh worktree, so an absolute path *inside* the
  // mission workspace is not the checkout either; it must be refused too.
  reject([`${path.join(directory, '.venv', 'bin', 'python')} -m pytest`])
  // F4v ground (b) (evidence_f3c7873c): an absolute path after `:`, `@` or an
  // attached short option must be refused as well.
  reject(['PATH=$PATH:/opt/homebrew/bin node check.cjs'])
  reject(['PATH="$PATH:/Users/tongtao/code/memem-publish/.venv/bin" python -m pytest'])
  reject(['PATH=:/opt/homebrew/bin node check.cjs'])
  reject(['PYTHONPATH=$PYTHONPATH:/Users/tongtao/code/memem-publish/.venv/lib python -m pytest'])
  reject(['python -m pytest @/Users/tongtao/code/memem-publish/args.txt'])
  reject(['node -I/opt/homebrew/lib check.cjs'])
  // The rest of the confirmed direct-refusal matrix stays refused.
  reject(['PYTHON=/Users/tongtao/.local/bin/python python -m pytest'])
  reject(['node check.cjs --rootdir=/Users/tongtao/code/memem-publish'])
  reject(['$(/Users/tongtao/.local/bin/uv run pytest)'])
  reject(['cd /Users/tongtao/code/memem-publish && .venv/bin/python -m pytest'])
  reject(['LD_LIBRARY_PATH=/Users/tongtao/code/memem-publish/.venv/lib /usr/bin/env python -m pytest'])
  reject(['`/Users/tongtao/.local/bin/uv` run pytest'])
  reject(['(/opt/homebrew/bin/node check.cjs)'])
  reject(['true; /opt/homebrew/bin/node check.cjs'])
  reject(['true\n/opt/homebrew/bin/node check.cjs'])
  reject(['-Wl,-rpath,/opt/homebrew/lib node check.cjs'])
  // A2-01 (R11-12): the shell resolves a backslash-escaped or doubled leading
  // slash to the same host path, so both spellings are refused here too.
  reject(['cat \\/Users/tongtao/secret'])
  reject(['cat //Users/tongtao/secret'])
  reject(['test -f \\/Users/tongtao/code/memem-publish/package.json'])
  // R11-12 class closure: a traversal or dot-segment through a system prefix
  // normalizes to the host path, so it cannot inherit the `/usr/bin/` exemption.
  reject(['/usr/bin/../..//Users/tongtao/secret run pytest'])
  reject(['/usr/bin/./../..//Users/tongtao/secret run pytest'])
  reject(['/usr/bin/../../opt/homebrew/bin/node check.cjs'])
  // R11-12 follow-up: a quoted, backtick, eval or nested-quote body resolves to
  // one shell word, but its inner host path is still refused.
  reject(['sh -c "cat /Users/tongtao/secret"'])
  reject(["sh -c 'cat /Users/tongtao/secret'"])
  reject(['cat `echo /Users/tongtao/secret`'])
  reject(['eval "cat /Users/tongtao/secret"'])
  reject(["node -e \"require('/Users/tongtao/secret')\""])
  reject(['bash -c "cd /Users/tongtao && make"'])
  reject(['echo "test -f /Users/tongtao/secret"'])
  reject(['PATH=x:/Users/tongtao/secret node check.cjs'])
  // System executables, relative paths, shell expansions and ordinary
  // pattern/separator arguments stay admitted (the paired false-positive fix).
  for (const accepted of ['node check.cjs', '/bin/sh -c "node check.cjs"', '/usr/bin/env node check.cjs',
    'PATH=/usr/bin:/bin node check.cjs', 'PATH=/usr/bin:$PATH node check.cjs',
    'PATH="$PWD/node_modules/.bin:$PATH" toolchain-check', 'npm_config_cache="$PWD/.cache" npm test',
    'curl https://example.com/check.json', 'test -f "$PWD/package.json"',
    'test -f "$PWD/.venv/bin/python" && "$PWD/.venv/bin/python" -m pytest',
    '.venv/bin/python -m pytest', 'node_modules/.bin/tsc --noEmit', 'test -c /dev/null', 'python3 -m pytest',
    'node -e "console.log(1)"', '~/.local/bin/uv run pytest', '$HOME/.local/bin/uv run pytest',
    // A normalized system path is still a system path.
    '/usr/bin/../bin/sh -c "node check.cjs"', '/bin/../bin/sh -c true', '/usr/bin/./env node check.cjs',
    // Separator flags name the bare root, not a host file.
    'awk -F/ \'{print $1}\' package.json', 'sort -t/ -k1 file', 'tr / _ < file', 'cut -d/ -f1 file',
    // Regex/pattern arguments are not host paths, and a slash inside a word is prose.
    'grep -E \'/(src|tests)/\' package.json', 'grep -E \'/[a-z]+/\' package.json',
    'node --test --test-name-pattern=\'/rejects/\' tests/x.test.mjs', 'echo "a and/or b"',
    // A URL value is not a host path (doubled slash plus scheme before the colon).
    'curl --url=https://example.com/check.json', 'PATH=x:https://example.com/check.json node x.cjs']) {
    const input = plan('/workspace')
    input.tasks[1].checks = [accepted]
    assert.doesNotThrow(() => validatePlan(input), accepted)
  }

  // The runtime.propose admission point applies the same rule.
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(mission, id) { return path.join(mission.workspace, id) },
    async start() {}, async prepareTask() {}, async deliver() {}, async stop() {},
    isIdle() { return false }, async dispose() {},
  }
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'check-integrity-owner' }
  const mission = runtime.create(owner, { title: 'Checks', objective: 'Deliver verified code', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Fix', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['node check.cjs'], ...extra })
  assert.throws(() => propose({ checks: [benchmark] }), /\[check_absolute_path\]/)
  assert.throws(() => propose({ checks: [`${path.join(directory, '.venv', 'bin', 'python')} -m pytest`] }), /\[check_absolute_path\]/)
  // The F4v ground-(b) probes are refused at this admission point too.
  for (const probe of ['PATH=$PATH:/opt/homebrew/bin node check.cjs', 'PATH=:/opt/homebrew/bin node check.cjs',
    'PYTHONPATH=$PYTHONPATH:/Users/tongtao/code/memem-publish/.venv/lib python -m pytest',
    'python -m pytest @/Users/tongtao/code/memem-publish/args.txt', 'node -I/opt/homebrew/lib check.cjs',
    'cat \\/Users/tongtao/secret', 'cat //Users/tongtao/secret',
    '/usr/bin/../..//Users/tongtao/secret run pytest', '/usr/bin/./../..//Users/tongtao/secret run pytest',
    'sh -c "cat /Users/tongtao/secret"', "sh -c 'cat /Users/tongtao/secret'", 'eval "cat /Users/tongtao/secret"',
    "node -e \"require('/Users/tongtao/secret')\"", 'PATH=x:/Users/tongtao/secret node check.cjs']) {
    assert.throws(() => propose({ title: 'Probe', checks: [probe] }), /\[check_absolute_path\]/, probe)
  }
  for (const accepted of ['/usr/bin/../bin/sh -c "node check.cjs"', 'awk -F/ \'{print $1}\' package.json',
    'grep -E \'/(src|tests)/\' package.json', 'curl --url=https://example.com/check.json', 'echo "a and/or b"']) {
    assert.equal(propose({ title: 'Accepted probe', checks: [accepted] }).checks[0], accepted)
  }
  assert.equal(propose({ title: 'Relative check' }).checks[0], 'node check.cjs', 'a checkout-relative check is admitted')
})
