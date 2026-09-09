/**
 * F-36: validate the FAULT_OK record instead of trusting its presence.
 *
 * A scenario must report the id the runner selected, a non-empty title, at
 * least one `I<n>` invariant, a finite duration and an evidence object. A
 * malformed or mismatched record is a failure, never a pass: a scenario that
 * prints a plausible-looking record for a different fault must not satisfy the
 * runner.
 */
export const INVARIANT_PATTERN = /^I\d+$/

/** Parse and validate one scenario's stdout against the id the runner selected. */
export function parseFaultOk(stdout, expectedId) {
  const line = String(stdout).split('\n').find(item => item.startsWith('FAULT_OK '))
  if (line === undefined) return { error: `no FAULT_OK result: ${String(stdout).trim().slice(-400)}` }
  let record
  try { record = JSON.parse(line.slice('FAULT_OK '.length)) } catch (error) { return { error: `FAULT_OK is not JSON: ${error.message}` } }
  const problems = []
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    problems.push('the record is not an object')
  } else {
    if (typeof record.id !== 'string' || record.id.toUpperCase() !== String(expectedId).toUpperCase()) problems.push(`record id ${JSON.stringify(record.id)} does not match ${expectedId}`)
    if (typeof record.title !== 'string' || record.title.trim() === '') problems.push('title is empty')
    if (!Array.isArray(record.invariants) || record.invariants.length === 0) problems.push('invariants is not a non-empty array')
    else if (!record.invariants.every(item => typeof item === 'string' && INVARIANT_PATTERN.test(item))) problems.push('invariants must all match I<n>')
    if (typeof record.ms !== 'number' || !Number.isFinite(record.ms) || record.ms < 0) problems.push('ms is not a finite duration')
    if (record.evidence === null || typeof record.evidence !== 'object' || Array.isArray(record.evidence)) problems.push('evidence is not an object')
  }
  return problems.length ? { error: `invalid FAULT_OK record: ${problems.join('; ')}` } : { record }
}
