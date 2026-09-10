/**
 * S3 shared refusal inventory (mechanical, source-derived).
 *
 * Every control-path refusal must carry a stable `[diagnostic_code]` token and
 * an imperative next step whose named tool and parameter resolve in the real
 * tool schema. This module enumerates the refusal call sites of a TypeScript
 * source file by walking the source itself — every `throw new Error(...)` whose
 * argument is a message, and every object literal that carries a `code` string
 * together with a `message` or `reason` — so a new refusal cannot be added
 * without appearing in the inventory.
 *
 * Nothing here is a hand-picked list of samples: `refusalSites` is the walker,
 * `assessRefusal` is the contract, and `toolSchemaIndex` captures the schema the
 * production registration path actually hands to the harness. The module is
 * deliberately dependency-free (no TypeScript compiler) and importable by the
 * serialized runtime/workspace annotation task, which owns the refusals this
 * branch may not edit:
 *
 *     node tests/refusal-inventory.mjs src/runtime.ts src/workspaces.ts
 *
 * The contract enforced per site (see `assessRefusal`): *   1. a stable code token, exactly one, matching the site's declared code when
 *      the site declares one;
 *   2. an imperative next step (an action verb such as `retry`/`correct`);
 *   3. at least one named parameter — a backticked identifier — and every named
 *      parameter and `swarm_*` tool resolves in the captured tool schema; a
 *      named tool must have one of its own parameters named next to it;
 *   4. documented exemptions: argument guards (`object`/`text`/`array`/
 *      `optionalInteger`) name the parameter they validate dynamically, and a
 *      `formatDiagnostic(...)` throw delegates its code to the coded diagnostic
 *      inventory. A refusal that delegates to another module must be declared in
 *      `DELEGATED_MESSAGES` and its provider must render a code token.
 */
import { pathToFileURL } from 'node:url'

/**
 * Whether the `/` at `index` opens a regular-expression literal rather than a
 * division: a regex can follow an operator, an opening bracket, a keyword such
 * as `return`/`typeof`, or the start of the file. Regex bodies may contain
 * quotes (`/reasoning effort \"([^\"]+)\"/i`), so misreading one desynchronizes
 * every later string/template scan and would silently drop refusals.
 */
export function looksLikeRegex(source, index) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--
  if (cursor < 0) return true
  let start = cursor
  while (start >= 0 && /[A-Za-z_$]/.test(source[start])) start--
  const word = source.slice(start + 1, cursor + 1)
  if (/^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(word)) return true
  return '(,=:[!&|?{};+-*%~^<>'.includes(source[cursor])
}

/** Skip one string, template literal, regex literal or comment token starting at `index`. */
export function skipToken(source, index) {
  const char = source[index]
  if (char === '/' && source[index + 1] === '/') {
    const end = source.indexOf('\n', index)
    return end === -1 ? source.length : end
  }
  if (char === '/' && source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2)
    return end === -1 ? source.length : end + 2
  }
  if (char === '/' && looksLikeRegex(source, index)) {
    let cursor = index + 1
    let inClass = false
    while (cursor < source.length) {
      const inner = source[cursor]
      if (inner === '\\') { cursor += 2; continue }
      if (inner === '\n') return cursor
      if (inner === '[') inClass = true
      else if (inner === ']') inClass = false
      else if (inner === '/' && !inClass) return cursor + 1
      cursor++
    }
    return cursor
  }
  if (char === "'" || char === '"') {
    let cursor = index + 1
    while (cursor < source.length) {
      const inner = source[cursor]
      if (inner === '\\') { cursor += 2; continue }
      cursor++
      if (inner === char) break
    }
    return cursor
  }
  if (char === '`') {
    let cursor = index + 1
    while (cursor < source.length) {
      const inner = source[cursor]
      if (inner === '\\') { cursor += 2; continue }
      if (inner === '`') return cursor + 1
      if (inner === '$' && source[cursor + 1] === '{') {
        const end = findMatching(source, cursor + 1)
        cursor = end === -1 ? source.length : end + 1
        continue
      }
      cursor++
    }
    return cursor
  }
  return index + 1
}

/** Index of the delimiter matching the one at `openIndex` (`(`, `{` or `[`). */
export function findMatching(source, openIndex) {
  const open = source[openIndex]
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : undefined
  if (close === undefined) return -1
  let depth = 0
  let index = openIndex
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') { index = skipToken(source, index); continue }
    if (char === '/') {
      const end = skipToken(source, index)
      if (end > index + 1) { index = end; continue }
    }
    if (char === open) depth++
    else if (char === close) { depth--; if (depth === 0) return index }
    index++
  }
  return -1
}

/** A copy of `source` with comment and string/template bodies blanked out, so code positions can be searched. */
export function maskSource(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') {
      const end = skipToken(source, index)
      for (let cursor = index; cursor < end; cursor++) out += source[cursor] === '\n' ? '\n' : ' '
      index = end
      continue
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*' || looksLikeRegex(source, index))) {
      const end = skipToken(source, index)
      for (let cursor = index; cursor < end; cursor++) out += source[cursor] === '\n' ? '\n' : ' '
      index = end
      continue
    }
    out += char
    index++
  }
  return out
}

function lineAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < source.length; cursor++) if (source[cursor] === '\n') line++
  return line
}

/** The top-level `,`-separated segments of a balanced region, code-aware. */
function topLevelSegments(source, from, to) {
  const segments = []
  let start = from
  let depth = 0
  let index = from
  while (index < to) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') { index = skipToken(source, index); continue }
    if (char === '/') {
      const end = skipToken(source, index)
      if (end > index + 1) { index = end; continue }
    }
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) { segments.push([start, index]); start = index + 1 }
    index++
  }
  segments.push([start, to])
  return segments
}

/** The own properties of an object literal, keyed by name, with raw value expressions. */
function objectProperties(source, masked, open, close) {
  const properties = new Map()
  for (const [from, to] of topLevelSegments(source, open + 1, close)) {
    // Keys are matched against the masked region so a leading comment or a
    // string literal cannot hide a property.
    const match = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*:/.exec(masked.slice(from, to))
    if (match) properties.set(match[1], source.slice(from + match[0].length, to).trim())
  }
  return properties
}

/** The nearest enclosing object literal opening brace for `index`, or -1. */
function enclosingObjectStart(masked, index) {
  let depth = 0
  for (let cursor = index; cursor >= 0; cursor--) {
    if (masked[cursor] === '}') depth++
    else if (masked[cursor] === '{') {
      if (depth === 0) return cursor
      depth--
    }
  }
  return -1
}

/** The innermost function whose body contains `index`, with its name and body range. */
function enclosingFunction(source, masked, index) {
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
  let found
  for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
    if (match.index > index) break
    const openParen = match.index + match[0].length - 1
    const closeParen = findMatching(source, openParen)
    if (closeParen === -1 || closeParen > index) continue
    const openBrace = masked.indexOf('{', closeParen)
    if (openBrace === -1 || openBrace > index) continue
    const closeBrace = findMatching(source, openBrace)
    if (closeBrace === -1 || closeBrace < index) continue
    found = { name: match[1], from: openBrace, to: closeBrace }
  }
  return found
}

/** Parse a template literal into its static quasis and its substitution expressions. */
export function templateParts(literal) {
  const quasis = []
  const substitutions = []
  let current = ''
  let index = 1
  while (index < literal.length - 1) {
    const char = literal[index]
    if (char === '\\') {
      const next = literal[index + 1]
      current += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
      index += 2
      continue
    }
    if (char === '$' && literal[index + 1] === '{') {
      quasis.push(current)
      current = ''
      const end = findMatching(literal, index + 1)
      substitutions.push(literal.slice(index + 2, end).trim())
      index = end + 1
      continue
    }
    current += char
    index++
  }
  quasis.push(current)
  return { quasis, substitutions, text: quasis.join(' ') }
}

function unescapeLiteral(body, quote) {
  let out = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char !== '\\') { out += char; continue }
    const next = body[index + 1]
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === quote ? quote : next
    index++
  }
  return out
}

/** Classify one thrown-message expression: literal, template, concatenation, formatDiagnostic or dynamic. */
export function classifyExpression(expression) {
  const trimmed = expression.trim()
  if (trimmed.startsWith('formatDiagnostic')) return { kind: 'formatDiagnostic', text: null, substitutions: [] }
  if (trimmed.startsWith('`') || trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const end = skipToken(trimmed, 0)
    if (end === trimmed.length) {
      if (trimmed[0] === '`') return { kind: 'template', ...templateParts(trimmed) }
      return { kind: 'literal', text: unescapeLiteral(trimmed.slice(1, -1), trimmed[0]), substitutions: [] }
    }
  }
  const pieces = topLevelSegments(trimmed, 0, trimmed.length).map(([from, to]) => trimmed.slice(from, to))
    .flatMap(piece => piece.split('+').map(part => part.trim()).filter(Boolean))
  if (pieces.length > 1 && pieces.every(piece => piece.startsWith('`') || piece.startsWith("'") || piece.startsWith('"'))) {
    const parsed = pieces.map(piece => classifyExpression(piece))
    if (parsed.every(item => item.text !== null)) return { kind: 'concat', text: parsed.map(item => item.text).join(''), substitutions: parsed.flatMap(item => item.substitutions) }
  }
  return { kind: 'dynamic', text: null, substitutions: [] }
}

export const CODE_TOKEN = /\[([a-z][a-z0-9_]{2,63})\]/
export const CODE_TOKEN_ALL = /\[([a-z][a-z0-9_]{2,63})\]/g
/** Imperative action verbs a next step may start from. */
export const IMPERATIVE_ACTIONS = /\b(?:retry|resubmit|re-?propose|re-?run|re-?submit|cancel|withdraw|replace|correct|repair|raise|lower|reduce|increase|set|pass|supply|provide|add|remove|omit|name|use|choose|declare|keep|split|narrow|widen|inspect|call|fix|follow|wait|stop|end|assign|resume|propose|admit|list|update|adjust|drop|move|fill|run|verify|preserve|respect)\b/i

/**
 * Enumerate every refusal site in one source file.
 * Returns `{ kind, file, line, code, property, expression, expressionKind, text, codes, tools, params, substitutions, guard, guardName }`.
 */
export function refusalSites(source, file) {
  const masked = maskSource(source)
  const sites = []
  const throwPattern = /throw new Error\(/g
  for (let match = throwPattern.exec(masked); match !== null; match = throwPattern.exec(masked)) {
    const open = match.index + 'throw new Error'.length
    const close = findMatching(source, open)
    const expression = (close === -1 ? source.slice(open + 1) : source.slice(open + 1, close)).trim().replace(/!$/, '')
    sites.push(describe({ kind: 'throw', file, source, masked, index: match.index, expression }))
  }
  // The `code:` key is code, but its string value is masked; search the
  // original source and require the key itself to sit at a code position.
  const codePattern = /code:\s*'([a-z][a-z0-9_]*)'/g
  for (let match = codePattern.exec(source); match !== null; match = codePattern.exec(source)) {
    if (masked.slice(match.index, match.index + 4) !== 'code') continue
    const open = enclosingObjectStart(masked, match.index)
    if (open === -1) continue
    const close = findMatching(source, open)
    if (close === -1) continue
    const properties = objectProperties(source, masked, open, close)
    const property = properties.has('message') ? 'message' : properties.has('reason') ? 'reason' : undefined
    if (property === undefined) continue
    sites.push(describe({ kind: 'message', file, source, masked, index: open, objectRange: [open, close], code: match[1], property, expression: properties.get(property) }))
  }
  return sites.sort((left, right) => left.line - right.line || (left.kind === right.kind ? 0 : left.kind === 'throw' ? -1 : 1))
}

function describe(base) {
  const expression = base.expression.trim()
  const info = classifyExpression(expression)
  const text = info.text
  const fn = base.kind === 'throw' ? enclosingFunction(base.source, base.masked, base.index) : undefined
  return {
    ...base,
    line: lineAt(base.source, base.index),
    expression,
    expressionKind: info.kind,
    text,
    substitutions: info.substitutions ?? [],
    codes: text === null ? [] : [...text.matchAll(CODE_TOKEN_ALL)].map(match => match[1]),
    tools: text === null ? [] : [...new Set([...text.matchAll(/\bswarm_[a-z][a-z0-9_]*\b/g)].map(match => match[0]))],
    params: text === null ? [] : [...new Set([...text.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map(match => match[1]))],
    guard: base.kind === 'throw' && ['object', 'text', 'array', 'optionalInteger'].includes(fn?.name ?? ''),
    guardName: fn?.name,
    functionBody: fn === undefined ? undefined : base.source.slice(fn.from, fn.to),
  }
}

/**
 * Every `code: '...'` string literal in the source, whether or not it is part
 * of an inventoried message site. This is the coverage guard: a `code` literal
 * that carries a `message`/`reason` but was not captured would be a silently
 * missed refusal, so `uncoveredCodeLiterals` must only return classification
 * markers (objects with `runnable`/`requirement`) and optional type members.
 */
export function codeLiterals(source) {
  const masked = maskSource(source)
  const pattern = /code\??:\s*'([a-z][a-z0-9_]*)'/g
  const entries = []
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (masked.slice(match.index, match.index + 4) !== 'code') continue
    const open = enclosingObjectStart(masked, match.index)
    const close = open === -1 ? -1 : findMatching(source, open)
    const properties = open === -1 || close === -1 ? new Map() : objectProperties(source, masked, open, close)
    entries.push({ code: match[1], index: match.index, line: lineAt(source, match.index), optional: source[match.index + 4] === '?', keys: [...properties.keys()] })
  }
  return entries
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
    authoredIn: 'src/runtime.ts',
    probe: 'reviewPathExit',
    note: 'Runtime.notifyReviewBlocked renders formatDiagnostic(missingReviewDiagnostic(...)) and appends the swarm_propose/reviewOf exit; tests/review-path-admission.test.mjs pins the diagnostic render itself.',
  },
]

/** The contract checks for one site. Returns a list of violations (empty means compliant). */
export function assessRefusal(site, index) {
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
    const body = site.functionBody ?? ''
    if (![...index.diagnosticProducers].some(name => body.includes(`${name}(`))) violations.push(`formatDiagnostic throw in ${site.guardName ?? 'an unknown function'} does not reference a local coded diagnostic producer`)
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
  } else {
    if (site.codes.length === 0) {
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
    } else if (site.kind === 'message' && site.codes[0] !== site.code) {
      violations.push(`inline code ${site.codes[0]} does not match the declared code ${site.code}`)
    }
  }
  if (text === null) return violations
  if (!IMPERATIVE_ACTIONS.test(text)) violations.push('no imperative next step (action verb)')
  if (site.params.length === 0) violations.push('next step names no parameter (backticked identifier)')
  for (const tool of site.tools) {
    if (!index.toolNames.has(tool)) { violations.push(`next step names unknown tool ${tool}`); continue }
    const own = index.ownProperties.get(tool)
    if (own !== undefined && !site.params.some(param => own.has(param))) violations.push(`next step names ${tool} without naming one of its parameters`)
  }
  for (const param of site.params) {
    if (index.toolNames.has(param) || index.propertyNames.has(param)) continue
    violations.push(`next step names parameter ${param}, which no registered tool schema declares`)
  }
  return violations
}

/** Precompute the local diagnostic-producer functions of a scanned file set. */
export function diagnosticProducers(sitesByFile) {
  const producers = new Set()
  for (const sites of sitesByFile) for (const site of sites) {
    if (site.kind === 'message' && site.property === 'message') {
      const fn = enclosingFunction(site.source, site.masked, site.index)
      if (fn !== undefined) producers.add(fn.name)
    }
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
