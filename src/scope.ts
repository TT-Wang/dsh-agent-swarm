/** Workspace-relative scopes: exact files, directory prefixes ending in '/', or '**'. */
export function validScope(scope: string): boolean {
  return scope === '**' || (scope.length > 0 && !scope.startsWith('/') && !scope.includes('\\')
    && !scope.includes('*') && !scope.split('/').some(part => part === '..' || part === '.')
    && !scope.includes('//'))
}
/** Whether a relative file path is covered by at least one declared scope. */
export function withinScope(path: string, scopes: readonly string[]): boolean {
  if (!validScope(path) || path === '**') return false
  return scopes.some(scope => scope === '**' || scope === path || (scope.endsWith('/') && path.startsWith(scope)))
}
/** A proposal can narrow its mission's permitted paths but cannot widen them. */
export function scopeSubset(child: readonly string[], parent: readonly string[]): boolean {
  return child.length > 0 && child.every(scope => validScope(scope)
    && (parent.includes('**') || (scope !== '**' && parent.some(p => p === scope || (p.endsWith('/') && scope.startsWith(p))))))
}
