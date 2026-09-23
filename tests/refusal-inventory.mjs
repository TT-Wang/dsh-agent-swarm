/**
 * S3 shared refusal inventory (mechanical, source-derived).
 *
 * Every control-path refusal must carry a stable `[diagnostic_code]` token and
 * a next step whose named tool and parameter resolve in the real tool schema.
 * The contract is a property of the rendered TEXT checked against the
 * registered tool schemas (`assessText`); the source walk only finds the text.
 * `refusalSites` enumerates the refusal call sites of a TypeScript source file
 * from its syntax tree (`refusalNodes`, tests/source-semantics.mjs) — every
 * `throw new <AnyClass>(...)`, so `PolicyError` and every coded subclass are
 * inventoried without a registry, and every object literal that carries a
 * `code` literal together with a `message` or `reason` — so a new refusal
 * cannot be added without appearing in the inventory.
 *
 * Nothing here is a hand-picked list of samples: `refusalSites` is the walker,
 * `assessText`/`assessRefusal` are the contract, and `toolSchemaIndex` captures
 * the schema the production registration path actually hands to the harness.
 * The CLI serves the serialized runtime/workspace annotation task:
 *
 *     node tests/refusal-inventory.mjs src/runtime.ts src/workspaces.ts
 *
 * The contract enforced on rendered text (see `assessText`):
 *   1. exactly one stable `[code]` token;
 *   2. an imperative next step: an action verb from `IMPERATIVE_ACTIONS` in the
 *      prose, outside the code token and backticked names;
 *   3. at least one named parameter — a backticked identifier — and every named
 *      parameter and `swarm_*` tool resolves in the captured tool schema; a
 *      named tool must have one of its own parameters named next to it.
 * `assessRefusal` applies it to a source site, where the token may also come
 * from the site: a coded object literal's `code` (rendered by
 * `formatDiagnostic`), a declared delegate (`DELEGATED_MESSAGES`), or a
 * documented exemption — argument guards (`object`/`text`/`array`/
 * `optionalInteger`) name the parameter they validate dynamically, and a
 * `formatDiagnostic(...)` throw delegates its code to a local coded producer.
 */
import { pathToFileURL } from 'node:url'
import { codeProperties, refusalNodes } from './source-semantics.mjs'

export const CODE_TOKEN = /\[([a-z][a-z0-9_]{2,63})\]/
export const CODE_TOKEN_ALL = /\[([a-z][a-z0-9_]{2,63})\]/g
const GUARDS = ['object', 'text', 'array', 'optionalInteger']
/**
 * Imperative action verbs a next step may start from. The first group is the
 * list the lexer-era lint enforced (tests/refusal-inventory.mjs at 664222d);
 * the second adds the imperatives current refusals and guard terminals lead
 * with (the owner-reply terminal's "Answer it … or close it", "amend an
 * unsubmitted task", "reassign the same review", "extend active planning",
 * "observe again", "restart with the root restored", "Resolve Git merge
 * conflicts", "reload before saving", "edit the saved plan", "ensure the final
 * captured artifact includes it", "re-check the board", "leave it open", "send
 * the answer", "relaunch the complete plan", "create a new mission").
 * Deliberately absent: `decide`, `accept` and `capture`, which the refusals
 * the batch-2 verifier found use descriptively ("the owner must decide",
 * "cannot accept work", "did not capture"), and `review`, `report`, `request`,
 * `check`, `state`, `read`, `open` and `submit`, which refusal prose uses
 * mostly as nouns or adjectives.
 */
export const IMPERATIVE_ACTIONS = new RegExp(`\\b(?:${[
  'retry', 'resubmit', 're-?propose', 're-?run', 're-?submit', 'cancel', 'withdraw', 'replace', 'correct', 'repair', 'raise', 'lower', 'reduce',
  'increase', 'set', 'pass', 'supply', 'provide', 'add', 'remove', 'omit', 'name', 'use', 'choose', 'declare', 'keep', 'split', 'narrow', 'widen',
  'inspect', 'call', 'fix', 'follow', 'wait', 'stop', 'end', 'assign', 'resume', 'propose', 'admit', 'list', 'update', 'adjust', 'drop', 'move',
  'fill', 'run', 'verify', 'preserve', 'respect',
  'answer', 'close', 'amend', 'reassign', 'extend', 'observe', 'restart', 'restore', 'resolve', 'reload', 'create', 'edit', 'ensure', 're-?check',
  'leave', 'send', 'relaunch',
].join('|')})\\b`, 'i')
/** The instruction prose of a text: the `[code]` token and backticked names are identifiers, not verbs. */
const prose = text => text.replace(CODE_TOKEN_ALL, ' ').replace(/`[^`]*`/g, ' ')

/** The code tokens, `swarm_*` tools and backticked parameters one rendered text names. */
export function textFacts(text) {
  return {
    codes: [...text.matchAll(CODE_TOKEN_ALL)].map(match => match[1]),
    tools: [...new Set([...text.matchAll(/\bswarm_[a-z][a-z0-9_]*\b/g)].map(match => match[0]))],
    params: [...new Set([...text.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map(match => match[1]))],
  }
}

/**
 * Enumerate every refusal site in one source file.
 * Returns `{ kind, file, line, code, property, errorClass, expression, expressionKind, partial, text, codes, tools, params, substitutions, guard, guardName, functionBody, calls, objectRange, advisory }`.
 * `kind` is `throw` for `throw new Error(...)`, `coded-throw` for a throw of any
 * other class (its `code` is the first argument when that is a code literal),
 * and `message` for a coded object literal. `partial` marks a site that is
 * only partially checked: `text` holds the literal parts of a template or `+`
 * chain, and the text its `substitutions` render is ignored (`messageText`).
 */
export function refusalSites(source, file) {
  const sites = refusalNodes(source, file).map(({ functionName, ...node }) => {
    const text = node.text === null ? null : `${node.prefix ?? ''}${node.text}`
    return { ...node, file, source, text, ...(text === null ? { codes: [], tools: [], params: [] } : textFacts(text)),
      guard: node.kind === 'throw' && GUARDS.includes(functionName ?? ''), guardName: functionName }
  })
  return sites.sort((left, right) => left.line - right.line || (left.kind === right.kind ? 0 : left.kind === 'throw' ? -1 : 1))
}

/**
 * Every `code` literal in the source (object property, type member or parameter),
 * whether or not it is part of an inventoried message site. This is the coverage guard:
 * a `code` literal that carries a `message`/`reason` but was not captured would
 * be a silently missed refusal, so `uncoveredCodeLiterals` must only return
 * classification markers (objects with `runnable`/`requirement`) and optional
 * type members.
 */
export function codeLiterals(source) {
  return codeProperties(source, 'source.ts')
}

/** The `code` literals no inventoried message site covers. */
export function uncoveredCodeLiterals(source, sites) {
  const ranges = sites.filter(site => site.kind === 'message').map(site => site.objectRange)
  return codeLiterals(source).filter(entry => !ranges.some(([from, to]) => entry.index >= from && entry.index <= to))
}

/** Recursively collect every declared property name of a JSON schema node. */
export function schemaPropertyNames(schema, into = new Set()) {
  if (schema === null || typeof schema !== 'object') return into
  if (schema.properties !== undefined && typeof schema.properties === 'object') {
    for (const [name, value] of Object.entries(schema.properties)) { into.add(name); schemaPropertyNames(value, into) }
  }
  if (schema.items !== undefined) schemaPropertyNames(schema.items, into)
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) for (const sub of schema[key]) schemaPropertyNames(sub, into)
  return into
}

/**
 * Capture the tool schemas the production registration path hands to the
 * harness. `registerTools` is the real installer; a recording context is the
 * only substitution, so the index cannot drift from the shipped schema.
 */
export async function toolSchemaIndex(budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }) {
  const { registerTools, SWARM_TOOLS } = await import('../lib/tools.js')
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, {}, budget)
  const toolNames = new Set(SWARM_TOOLS)
  const propertyNames = new Set()
  for (const definition of definitions.values()) schemaPropertyNames(definition.parameters, propertyNames)
  const ownProperties = new Map([...definitions].map(([name, definition]) => [name, schemaPropertyNames(definition.parameters)]))
  return { definitions, toolNames, propertyNames, ownProperties, names: [...SWARM_TOOLS] }
}

/**
 * A refusal that delegates its message to another module's diagnostic. The
 * delegate must be declared with the source that authors the message and the
 * runtime probe that renders it, so the code token is verified, not assumed.
 */
export const DELEGATED_MESSAGES = [
  {
    file: 'src/tools.ts',
    expression: 'authorization.diagnostic',
    authoredIn: 'src/authorization.ts',
    probe: 'workspaceAuthorizationDiagnostic',
    note: 'WorkspaceRefused.diagnostic is authored by workspaceAuthorizationDiagnostic; the throw site appends the executable exit.',
  },
]

/**
 * A diagnostic whose message body is composed by its caller: the diagnostic is a
 * stable code carrier, and the imperative exit is delivered by the declared
 * composer, whose source must prove it (the probe returns true only when the
 * exit is present). Used where an existing exact-render test pins the message
 * itself and may not be relaxed.
 */
export const CALLER_COMPOSED_MESSAGES = [
  {
    file: 'src/admission.ts',
    code: 'review_path_missing',
    authoredIn: 'src/notices.ts',
    probe: 'reviewPathExit',
    note: 'Notices.notifyReviewBlocked (src/notices.ts since the M1a split) renders formatDiagnostic(missingReviewDiagnostic(...)) and appends the swarm_propose/reviewOf exit; tests/review-path-admission.test.mjs pins the diagnostic render itself.',
  },
]

/** The next-step half of the contract, over one rendered text's prose and the tools and parameters it names. */
function exitViolations(text, { tools, params }, index) {
  const violations = []
  if (!IMPERATIVE_ACTIONS.test(prose(text))) violations.push('no imperative next step (action verb)')
  if (params.length === 0) violations.push('next step names no parameter (backticked identifier)')
  for (const tool of tools) {
    if (!index.toolNames.has(tool)) { violations.push(`next step names unknown tool ${tool}`); continue }
    const own = index.ownProperties.get(tool)
    if (own !== undefined && !params.some(param => own.has(param))) violations.push(`next step names ${tool} without naming one of its parameters`)
  }
  for (const param of params) {
    if (index.toolNames.has(param) || index.propertyNames.has(param)) continue
    violations.push(`next step names parameter ${param}, which no registered tool schema declares`)
  }
  return violations
}

/**
 * The refusal contract over rendered text, exactly as the model reads it:
 * exactly one `[code]` token, an imperative action verb in its prose, at least
 * one backticked parameter, and every backticked identifier and `swarm_*` tool
 * resolves in `schemaIndex` (from `toolSchemaIndex`), with a named tool's own
 * parameter named next to it. Returns the violations (empty means compliant).
 */
export function assessText(text, schemaIndex) {
  const facts = textFacts(text)
  const violations = []
  if (facts.codes.length === 0) violations.push('no [diagnostic_code] token')
  else if (facts.codes.length > 1) violations.push(`multiple diagnostic code tokens: ${facts.codes.join(', ')}`)
  return [...violations, ...exitViolations(text, facts, schemaIndex)]
}

/**
 * The contract for one source site: `assessText`'s checks, where the code
 * token may instead come from the site itself (a coded object literal's `code`,
 * a declared delegate) or a documented exemption applies. Returns a list of
 * violations (empty means compliant).
 */
export function assessRefusal(site, index) {
  // Advisory diagnostics are inventoried for visibility, but do not refuse anything or require an exit.
  if (site.kind === 'message' && site.advisory) return []
  const violations = []
  const text = site.text
  if (site.guard) {
    // Argument guards validate a parameter whose name is supplied by the caller.
    if (text === null || !/\bretry\b/i.test(text)) violations.push('argument guard has no retry instruction')
    if (text === null || !/parameter/i.test(text)) violations.push('argument guard does not name the parameter it validates')
    return violations
  }
  if (site.expressionKind === 'formatDiagnostic') {
    // Compositional: formatDiagnostic prefixes `[code]` for a coded diagnostic,
    // and the diagnostic producers are themselves checked as message sites. The
    // enclosing function must call one of those local producers.
    if (![...index.diagnosticProducers].some(name => site.calls?.has(name))) violations.push(`formatDiagnostic throw in ${site.guardName ?? 'an unknown function'} does not reference a local coded diagnostic producer`)
    return violations
  }
  if (site.kind === 'message' && site.property === 'message') {
    if (!/^[a-z][a-z0-9_]*$/.test(site.code)) violations.push(`unstable diagnostic code ${JSON.stringify(site.code)}`)
    if (text === null) {
      const caller = CALLER_COMPOSED_MESSAGES.find(entry => entry.file === site.file && entry.code === site.code)
      if (caller === undefined) violations.push('dynamic diagnostic message text')
      else if (index.probes?.[caller.probe]?.() !== true) violations.push(`the declared composer ${caller.authoredIn} does not supply the imperative exit for ${site.code}`)
    }
    if (site.codes.length) violations.push(`diagnostic message inlines ${site.codes.join(', ')} on top of the code field rendered by formatDiagnostic`)
  } else if (site.codes.length === 0) {
    const delegate = DELEGATED_MESSAGES.find(entry => entry.file === site.file && (
      site.expression === entry.expression || site.substitutions.includes(entry.expression)))
    if (delegate === undefined) {
      violations.push(`no [diagnostic_code] token and no declared delegated diagnostic (expression: ${site.expression.slice(0, 80)})`)
    } else {
      const rendered = index.probes?.[delegate.probe]?.()
      if (typeof rendered !== 'string' || !CODE_TOKEN.test(rendered)) violations.push(`delegated diagnostic from ${delegate.authoredIn} carries no code token`)
    }
  } else if (site.codes.length > 1) {
    violations.push(`multiple diagnostic code tokens: ${site.codes.join(', ')}`)
  } else if (site.code !== undefined && site.codes[0] !== site.code) {
    violations.push(`inline code ${site.codes[0]} does not match the declared code ${site.code}`)
  }
  // A `partial` site's text is its literal parts only: what its dynamic segments render is not checked.
  return text === null ? violations : [...violations, ...exitViolations(text, site, index)]
}

/** Precompute the local diagnostic-producer functions of a scanned file set. */
export function diagnosticProducers(sitesByFile) {
  const producers = new Set()
  for (const sites of sitesByFile) for (const site of sites) {
    if (site.kind === 'message' && site.property === 'message' && site.guardName !== undefined) producers.add(site.guardName)
  }
  return producers
}

/**
 * Apply an explicit allowlist to an inventory. An allowlisted site is skipped
 * only while it still violates the contract: an entry whose refusal is already
 * coded and actionable is stale and fails, so the allowlist can only shrink.
 * Returns `{ checked, allowed, stale }`.
 */
export function applyAllowlist(sites, allowlist, assess) {
  const byKey = new Map(sites.map(site => [`${site.file}:${site.line}`, site]))
  const allowed = new Set()
  const stale = []
  for (const entry of allowlist) {
    const key = `${entry.file}:${entry.line}`
    const site = byKey.get(key)
    if (site === undefined) { stale.push({ ...entry, reason: 'no refusal site at this file and line' }); continue }
    if (assess(site).length === 0) { stale.push({ ...entry, reason: 'the refusal is already coded and actionable' }); continue }
    allowed.add(key)
  }
  const checked = sites.filter(site => !allowed.has(`${site.file}:${site.line}`))
  return { checked, allowed, stale }
}

/** The uncoded sites of an inventory, for the deferred report. */
export function deferredSites(sites, assess) {
  return sites.map(site => ({ site, violations: assess(site) })).filter(item => item.violations.length > 0)
}

/** A compact human-readable inventory line. */
export function formatSite(site) {
  const code = site.code ?? (site.codes[0] ?? 'none')
  return `${site.file}:${site.line} ${site.kind}${site.property ? `(${site.property})` : ''} [${code}]${site.guard ? ' guard' : ''}`
}

// A small CLI so the serialized runtime/workspace task can consume the same
// inventory without importing the test module: prints every refusal site and
// marks the ones that do not yet satisfy the contract.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs')
  const index = await toolSchemaIndex()
  const { workspaceAuthorizationDiagnostic } = await import('../lib/authorization.js')
  index.probes = { workspaceAuthorizationDiagnostic: () => workspaceAuthorizationDiagnostic('probe', { grants: [], loadedAt: 0, unresolved: [] }) }
  for (const file of process.argv.slice(2)) {
    const sites = refusalSites(readFileSync(file, 'utf8'), file)
    const producers = diagnosticProducers([sites])
    for (const site of sites) {
      const violations = assessRefusal(site, { ...index, diagnosticProducers: producers })
      console.log(`${formatSite(site)}${violations.length ? ` — ${violations.join('; ')}` : ' — compliant'}`)
    }
  }
}
