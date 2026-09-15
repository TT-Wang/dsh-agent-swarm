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
