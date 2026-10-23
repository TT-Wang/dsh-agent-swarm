/**
 * The one owner of a swarm tool's failure text (`toolFailure`, src/tools.ts).
 * The Harness renders a tool's rejection from an Error's message and
 * `String()`s anything else, so the live drop3 owner read "Error: [object
 * Object]" for its cancelled launch. Every value a tool can be rejected with
 * leaves as an Error whose message is readable; the real Loader composition
 * (tests/harness-launch-refusal.mjs) drives the same rule through the owner's
 * tool loop.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolFailure } from '../lib/tools.js'
import { PolicyError, recordedFailure, thrownText } from '../lib/policy-error.js'

const live = () => new AbortController().signal

test('an Error leaves as itself, its message untouched', () => {
  const refusal = new PolicyError('member_reasoning_effort_unsupported', 'validation_error', '[member_reasoning_effort_unsupported] members[impl].reasoningEffort: refused')
  assert.equal(toolFailure('swarm_launch', refusal, live()), refusal)
  const plain = new TypeError('bad argument')
  assert.equal(toolFailure('swarm_observe', plain, live()), plain)
})

test('the session\'s cancellation cause becomes a typed [tool_cancelled] refusal naming it', () => {
  const controller = new AbortController()
  const cause = Object.freeze({ kind: 'disposed' })
  controller.abort(cause)
  const failure = toolFailure('swarm_launch', cause, controller.signal)
  assert.ok(failure instanceof PolicyError)
  assert.equal(failure.code, 'tool_cancelled')
  assert.equal(failure.message, '[tool_cancelled] swarm_launch was cancelled by its session ({"kind":"disposed"}) before it returned. What it committed before the cancellation stands: read the current state with swarm_observe before calling swarm_launch again.')
  assert.equal(String(failure), `Error: ${failure.message}`, 'a recorded reason reads as the refusal')
})

test('any other value becomes a typed [tool_failed] refusal carrying its readable text, never "[object Object]"', () => {
  const cyclic = { kind: 'cyclic' }; cyclic.self = cyclic
  const trap = new Proxy({}, { get() { throw new Error('trapped') }, getPrototypeOf() { throw new Error('trapped') } })
  for (const [value, text] of [
    [{ kind: 'store-offline' }, '{"kind":"store-offline"}'],
    [{ message: 'carried message' }, 'carried message'],
    ['a bare string', 'a bare string'],
    [undefined, 'undefined'],
    [null, 'null'],
    [42, '42'],
    [10n, '10'],
    [Symbol('why'), 'Symbol(why)'],
    [function named() {}, 'a function "named"'],
    [cyclic, 'a thrown value that cannot be read'],
    [trap, 'a thrown value that cannot be read'],
  ]) {
    assert.equal(thrownText(value), text)
    const failure = toolFailure('swarm_observe', value, live())
    assert.ok(failure instanceof PolicyError)
    assert.equal(failure.code, 'tool_failed')
    assert.equal(failure.message, `[tool_failed] swarm_observe failed with a thrown value that is not an Error: ${text}. Read the current state with swarm_observe before calling swarm_observe again.`)
  }
  // An aborted call rejected with something other than its own cause is not a cancellation.
  const controller = new AbortController()
  controller.abort(Object.freeze({ kind: 'user' }))
  assert.equal(toolFailure('swarm_observe', { kind: 'other' }, controller.signal).code, 'tool_failed')
})

/**
 * A failed launch's durable records (the automatic request's recorded reason,
 * the draft's launch failure) carry the same readable text: an Error as its
 * own rendering, byte for byte, anything else as `thrownText` reads it
 * (tests/planner.test.mjs drives both records and the recovery notice).
 */
test('a launch failure is recorded as its Error rendering or its readable text, never "[object Object]"', () => {
  assert.equal(recordedFailure(new PolicyError('check_syntax_invalid', 'validation_error', '[check_syntax_invalid] refused')), 'Error: [check_syntax_invalid] refused')
  assert.equal(recordedFailure(new TypeError('bad argument')), 'TypeError: bad argument')
  const hostile = new Error('hostile rendering'); hostile.toString = () => { throw new Error('unrenderable') }
  assert.equal(recordedFailure(hostile), 'hostile rendering')
  const trap = new Proxy({}, { get() { throw new Error('trapped') }, getPrototypeOf() { throw new Error('trapped') } })
  for (const value of [Object.freeze({ kind: 'catalog-offline' }), { message: 'carried message' }, 'a bare string', undefined, trap]) assert.equal(recordedFailure(value), thrownText(value))
})
