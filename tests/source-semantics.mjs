import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export function sourceTree(text, filename = 'source.ts') {
  return ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Class fields and module bindings can survive a call; temporary locals need no ordinal registry. */
export function persistentCollections(text, filename) {
  const tree = sourceTree(text, filename), found = []
  const visit = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.expression.text)) {
      let current = node.parent
      while (current && !ts.isSourceFile(current)) {
        if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isPropertyAccessExpression(current.left) && current.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
          found.push({ name: current.left.name.text, kind: node.expression.text })
          break
        }
        if (ts.isFunctionLike(current)) break
        if (ts.isPropertyDeclaration(current) || (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)
          && ts.isVariableStatement(current.parent.parent) && ts.isSourceFile(current.parent.parent.parent))) {
          found.push({ name: current.name.getText(tree), kind: node.expression.text })
          break
        }
        current = current.parent
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** Read only the event type argument, including nested conditional branches and named literals. */
export function emittedEventTypes(text, filename, constants = new Map()) {
  const tree = sourceTree(text, filename), result = new Set()
  const read = expression => {
    if (!expression) return
    if (ts.isStringLiteralLike(expression)) result.add(expression.text)
    else if (ts.isIdentifier(expression) && constants.has(expression.text)) result.add(constants.get(expression.text))
    else if (ts.isConditionalExpression(expression)) { read(expression.whenTrue); read(expression.whenFalse) }
    else if (ts.isParenthesizedExpression(expression)) read(expression.expression)
  }
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'event') read(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return [...result]
}

const CODE_LITERAL = /^[a-z][a-z0-9_]*$/
const unwrap = node => { while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node))) node = node.expression; return node }
const codeText = node => { node = unwrap(node); return node && ts.isStringLiteralLike(node) && CODE_LITERAL.test(node.text) ? node.text : undefined }
const nameOf = node => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : undefined

/**
 * The class declarations of a set of sources, by name: the parent class, the
 * constructor's parameter names (undefined when the class declares no
 * constructor, so its arguments pass straight to the parent's) and the
 * arguments of its `super(…)` call.
 */
export function errorClasses(sources) {
  const classes = new Map()
  for (const { text, filename } of sources) {
    declareClasses(filename.endsWith('.tsx') ? ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) : sourceTree(text, filename), filename, classes)
  }
  return classes
}

function declareClasses(tree, filename, classes) {
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
      const ctor = node.members.find(member => ts.isConstructorDeclaration(member) && member.body)
      const superCall = ctor?.body.statements.map(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? item.expression : undefined).find(Boolean)
      classes.set(node.name.text, { name: node.name.text, file: filename, parent: heritage && ts.isIdentifier(heritage) ? heritage.text : undefined,
        params: ctor?.parameters.map(parameter => parameter.name.getText(tree)), superArgs: superCall ? [...superCall.arguments] : undefined })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

/** Whether `name` is `ancestor` or reaches it, through `classes`, as a transitive parent. */
export function extendsClass(classes, name, ancestor) {
  for (let at = name, seen = new Set(); at !== undefined && !seen.has(at); seen.add(at), at = classes.get(at)?.parent) if (at === ancestor) return true
  return false
}

/**
 * Where each named constructor parameter of `name` and of every declared
 * ancestor comes from at a `new <name>(…)`: `{ index }` is the call's argument
 * at that position; `{ node }` is an expression a class declaration itself
 * passes to `super` (the code `TaskGraphAdmissionError` fixes, say). A
 * subclass that declares no constructor inherits its parent's positions, and
 * an ancestor parameter the subclass forwards by name keeps the subclass's
 * position. Undefined for a class `classes` does not declare.
 */
export function constructorArguments(classes, name, seen = new Set()) {
  const declared = classes.get(name)
  if (declared === undefined || seen.has(name)) return undefined
  seen.add(name)
  const inherited = declared.parent === undefined ? undefined : constructorArguments(classes, declared.parent, seen)
  if (declared.params === undefined) return inherited ?? new Map()
  const slots = new Map()
  for (const [parameter, slot] of inherited ?? []) {
    if (slot.index === undefined) { slots.set(parameter, slot); continue }
    const argument = unwrap(declared.superArgs?.[slot.index])
    const forwarded = argument !== undefined && ts.isIdentifier(argument) ? declared.params.indexOf(argument.text) : -1
    if (forwarded !== -1) slots.set(parameter, { index: forwarded })
    else if (argument !== undefined) slots.set(parameter, { node: argument })
  }
  declared.params.forEach((parameter, index) => slots.set(parameter, { index }))
  return slots
}

let declaredInSource
/** `errorClasses` over every TypeScript file under src/, read once. */
export function sourceErrorClasses() {
  if (declaredInSource === undefined) {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    declaredInSource = errorClasses(readdirSync(root, { recursive: true }).filter(file => /\.tsx?$/.test(file)).sort()
      .map(file => ({ filename: `src/${file.split(sep).join('/')}`, text: readFileSync(join(root, file), 'utf8') })))
  }
  return declaredInSource
}

/**
 * The static text of a message expression: a literal, a template (quasis joined by a gap) or a `+` chain with a gap for each non-literal operand.
 * `partial` marks a template or `+` chain with dynamic parts: `text` is its literal parts only, and whatever
 * `substitutions` render at run time (caller input, adapter output such as check_syntax_invalid's
 * `checkSyntaxDetail(…)`) is never checked. A `dynamic` or `formatDiagnostic` expression has no text at all.
 */
export function messageText(node, tree) {
  node = unwrap(node)
  if (node === undefined) return { expressionKind: 'dynamic', text: null, substitutions: [], partial: false }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'formatDiagnostic') return { expressionKind: 'formatDiagnostic', text: null, substitutions: [], partial: false }
  if (ts.isStringLiteral(node)) return { expressionKind: 'literal', text: node.text, substitutions: [], partial: false }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { expressionKind: 'template', text: node.text, substitutions: [], partial: false }
  // Dynamic segments are ignored: each `${…}` becomes a one-space gap, so only the quasis are checked.
  if (ts.isTemplateExpression(node)) return { expressionKind: 'template', text: [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' '), substitutions: node.templateSpans.map(span => span.expression.getText(tree)), partial: true }
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return { expressionKind: 'dynamic', text: null, substitutions: [], partial: false }
  const operands = [], flatten = item => { item = unwrap(item); if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.PlusToken) { flatten(item.left); flatten(item.right) } else operands.push(item) }
  flatten(node)
  // Dynamic segments are ignored: a non-literal operand becomes a one-space gap, so only the literal operands are checked.
  const parts = operands.map(item => ts.isStringLiteralLike(item) || ts.isTemplateExpression(item) ? messageText(item, tree) : { expressionKind: 'dynamic', text: ' ', substitutions: [item.getText(tree)] })
  if (parts.every(part => part.expressionKind === 'dynamic')) return { expressionKind: 'dynamic', text: null, substitutions: [], partial: false }
  const substitutions = parts.flatMap(part => part.substitutions)
  return { expressionKind: 'concat', text: parts.map(part => part.text).join(''), substitutions, partial: substitutions.length > 0 }
}

/**
 * Every refusal node of one source: each `throw new <AnyClass>(…)` and each object literal
 * carrying a `code` literal with a `message` or `reason`. The code of a class throw is its
 * first argument when that is a code literal. Its message is the argument at the position of
 * the constructor parameter named `message`, read from the class declarations in src/ and in
 * this source (`constructorArguments`: a class that declares no constructor takes its
 * parent's); only for a class whose declaration does not take the message as a parameter is
 * it the first argument shaped like a message, else the first that is not a code-like literal
 * or a number. A class declared here whose constructor renders `[${firstParameter}] …`
 * prefixes the code token, as its instances do.
 */
export function refusalNodes(text, filename) {
  const tree = sourceTree(text, filename), found = [], prefixing = new Set()
  const classes = new Map(sourceErrorClasses())
  declareClasses(tree, filename, classes)
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const enclosing = node => { for (let at = node.parent; at; at = at.parent) if ((ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) && at.name && at.body) return at }
  const calls = fn => { const names = new Set(), visit = node => { if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) names.add(ts.isIdentifier(node.expression) ? node.expression.text : node.expression.name.text); ts.forEachChild(node, visit) }; if (fn) visit(fn.body); return names }
  const site = (node, fields, message) => { const fn = enclosing(node); found.push({ ...fields, index: node.getStart(tree), line: line(node), expression: message?.getText(tree) ?? '', ...messageText(message, tree), functionName: fn?.name.text, functionBody: fn?.body.getText(tree), calls: calls(fn) }) }
  for (const statement of tree.statements) if (ts.isClassDeclaration(statement) && statement.name) {
    const ctor = statement.members.find(ts.isConstructorDeclaration), first = ctor?.parameters[0]?.name.getText(tree)
    const render = ctor?.body?.statements.map(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? unwrap(item.expression.arguments[0]) : undefined).find(Boolean)
    if (render && ts.isTemplateExpression(render) && render.head.text === '[' && render.templateSpans[0].expression.getText(tree) === first && render.templateSpans[0].literal.text.startsWith('] ')) prefixing.add(statement.name.text)
  }
  const visit = node => {
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(unwrap(node.expression))) {
      const created = unwrap(node.expression), errorClass = created.expression.getText(tree), args = created.arguments ?? []
      if (errorClass === 'Error') site(node, { kind: 'throw' }, args[0])
      else {
        const code = codeText(args[0])
        // The declared message parameter decides: at src/plans.ts's aggregate AdmissionError the
        // code is a conditional and the message a `.join` call, so neither shape nor position finds it.
        const declared = constructorArguments(classes, errorClass)?.get('message')
        const rest = args.slice(code === undefined ? 0 : 1)
        // Fallback for a class that does not take its message as a parameter: prefer the
        // argument shaped like a message over position.
        const shaped = arg => {
          const value = unwrap(arg)
          return ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)
            || (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
            || (ts.isCallExpression(value) && value.expression.getText(tree) === 'formatDiagnostic')
        }
        const message = declared?.index !== undefined ? args[declared.index]
          : rest.find(arg => codeText(arg) === undefined && shaped(arg)) ?? rest.find(arg => codeText(arg) === undefined && !ts.isNumericLiteral(arg))
        site(node, { kind: 'coded-throw', errorClass, code, prefix: code !== undefined && prefixing.has(errorClass) ? `[${code}] ` : '' }, message)
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map(node.properties.filter(item => nameOf(item) !== undefined).map(item => [nameOf(item), item]))
      const code = properties.get('code'), property = ['message', 'reason'].find(key => properties.has(key) && ts.isPropertyAssignment(properties.get(key)))
      if (code && ts.isPropertyAssignment(code) && codeText(code.initializer) && property) {
        const severity = properties.get('severity')
        site(node, { kind: 'message', code: codeText(code.initializer), property, objectRange: [node.getStart(tree), node.getEnd() - 1], advisory: severity !== undefined && ts.isPropertyAssignment(severity) && ts.isStringLiteralLike(severity.initializer) && severity.initializer.text === 'advisory' }, properties.get(property).initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** Every `code` property, member or parameter whose value or literal type is a code literal. */
export function codeProperties(text, filename) {
  const tree = sourceTree(text, filename), found = []
  const visit = node => {
    const typed = ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)
    const type = typed && node.type && ts.isUnionTypeNode(node.type) ? node.type.types[0] : typed ? node.type : undefined
    const value = ts.isPropertyAssignment(node) ? node.initializer : type && ts.isLiteralTypeNode(type) ? type.literal : undefined
    if (nameOf(node) === 'code' && codeText(value)) {
      const siblings = node.parent.properties ?? node.parent.members ?? node.parent.parameters ?? []
      found.push({ code: codeText(value), index: node.getStart(tree), line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, optional: node.questionToken !== undefined, keys: siblings.map(nameOf).filter(Boolean) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}
