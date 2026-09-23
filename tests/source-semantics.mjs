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

/** The static text of a message expression: a literal, a template (quasis joined by a gap) or a `+` chain with a gap for each non-literal operand. */
export function messageText(node, tree) {
  node = unwrap(node)
  if (node === undefined) return { expressionKind: 'dynamic', text: null, substitutions: [] }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'formatDiagnostic') return { expressionKind: 'formatDiagnostic', text: null, substitutions: [] }
  if (ts.isStringLiteral(node)) return { expressionKind: 'literal', text: node.text, substitutions: [] }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { expressionKind: 'template', text: node.text, substitutions: [] }
  if (ts.isTemplateExpression(node)) return { expressionKind: 'template', text: [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' '), substitutions: node.templateSpans.map(span => span.expression.getText(tree)) }
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return { expressionKind: 'dynamic', text: null, substitutions: [] }
  const operands = [], flatten = item => { item = unwrap(item); if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.PlusToken) { flatten(item.left); flatten(item.right) } else operands.push(item) }
  flatten(node)
  const parts = operands.map(item => ts.isStringLiteralLike(item) || ts.isTemplateExpression(item) ? messageText(item, tree) : { expressionKind: 'dynamic', text: ' ', substitutions: [item.getText(tree)] })
  if (parts.every(part => part.expressionKind === 'dynamic')) return { expressionKind: 'dynamic', text: null, substitutions: [] }
  return { expressionKind: 'concat', text: parts.map(part => part.text).join(''), substitutions: parts.flatMap(part => part.substitutions) }
}

/**
 * Every refusal node of one source: each `throw new <AnyClass>(…)` and each object literal
 * carrying a `code` literal with a `message` or `reason`. The code of a class throw is its
 * first argument when that is a code literal; its message is the first later argument that
 * is not a code-like literal or a number. A class declared here whose constructor renders
 * `[${firstParameter}] …` prefixes the code token, as its instances do.
 */
export function refusalNodes(text, filename) {
  const tree = sourceTree(text, filename), found = [], prefixing = new Set()
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
        const message = args.slice(code === undefined ? 0 : 1).find(arg => codeText(arg) === undefined && !ts.isNumericLiteral(arg))
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
