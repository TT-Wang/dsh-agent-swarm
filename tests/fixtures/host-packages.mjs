/**
 * The installed host's package set, read through the tests' own module
 * resolution (the linked host's node_modules), so an in-process composition
 * mounts a package only where the host ships it. A package the host ships but
 * cannot load fails the test instead of reading as absent.
 */

/** Whether the installed host ships the package. */
export function hostShips(name) {
  try { import.meta.resolve(name); return true }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return false
    throw error
  }
}

/** The package's module namespace, or undefined when the installed host does not ship it. */
export async function hostPackage(name) {
  return hostShips(name) ? await import(name) : undefined
}
