/**
 * F-36: the fault runner validates the FAULT_OK record instead of trusting its
 * presence. These tests exercise the validator directly and prove the runner
 * refuses an unknown selective id instead of silently ignoring it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseFaultOk } from '../scripts/faults/record.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('..', import.meta.url))
const ok = overrides => JSON.stringify({ id: 'F1', title: 'a fault fired', invariants: ['I1'], ms: 12, evidence: {}, ...overrides })
const stdoutFor = value => `scenario noise\nFAULT_OK ${value}\n`

test('F-36: a well-formed record matches its scenario id case-insensitively', () => {
  assert.equal(parseFaultOk(stdoutFor(ok({ id: 'F3a' })), 'F3A').record?.id, 'F3a')
  assert.equal(parseFaultOk(stdoutFor(ok()), 'F1').record?.title, 'a fault fired')
})

test('F-36: a missing, malformed or mismatched record is refused', () => {
  assert.match(parseFaultOk('nothing here\n', 'F1').error, /no FAULT_OK result/)
  assert.match(parseFaultOk(stdoutFor('{ not json'), 'F1').error, /not JSON/)
  assert.match(parseFaultOk(stdoutFor('[]'), 'F1').error, /not an object/)
  assert.match(parseFaultOk(stdoutFor(ok({ id: 'F2' })), 'F1').error, /does not match F1/)
  assert.match(parseFaultOk(stdoutFor(ok({ title: '   ' })), 'F1').error, /title is empty/)
  assert.match(parseFaultOk(stdoutFor(ok({ invariants: [] })), 'F1').error, /invariants is not a non-empty array/)
  assert.match(parseFaultOk(stdoutFor(ok({ invariants: ['W1'] })), 'F1').error, /I<n>/)
  assert.match(parseFaultOk(stdoutFor(ok({ ms: Number.NaN })), 'F1').error, /ms is not a finite duration/)
  assert.match(parseFaultOk(stdoutFor(ok({ evidence: [] })), 'F1').error, /evidence is not an object/)
})

test('F-36: the runner refuses an unknown --only id instead of ignoring it', async () => {
  await assert.rejects(execute(process.execPath, ['scripts/faults/run.mjs', '--only', 'NOPE'], { cwd: project }), error => {
    assert.equal(error.code, 1)
    assert.match(String(error.stderr), /unknown scenario id\(s\): NOPE/)
    return true
  })
})
