import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileTaskAdmission } from '../lib/admission.js'

test('acceptance-only output path gives an actionable scope hint without blocking read-only references', () => {
  const input = { objective: 'Inspect the scheduling code', scope: ['src/'], acceptance: ['Write report to docs/reviews/findings.md'] }
  const diagnostics = reconcileTaskAdmission(input, '/nonexistent/swarm-fixture', 'task')
  const hint = diagnostics.find(row => row.code === 'objective_write_outside_scope')
  assert.equal(hint?.path, 'docs/reviews/findings.md')
  assert.equal(hint?.severity, 'advisory')
  assert.equal(reconcileTaskAdmission({ ...input, scope: ['src/', 'docs/reviews/'] }, '/nonexistent/swarm-fixture', 'task').some(row => row.code === 'objective_write_outside_scope'), false)
  assert.equal(reconcileTaskAdmission({ ...input, acceptance: ['Read docs/design.md as evidence'] }, '/nonexistent/swarm-fixture', 'task').some(row => row.severity !== 'advisory'), false)
})
