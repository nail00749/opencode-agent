import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"

/**
 * Validates every existing lexical component without following symlinks, then
 * resolves only the nearest validated existing ancestor. This function never
 * creates or changes filesystem state.
 */
export function secureCanonicalPath(target: string, label = "Path"): string {
  if (!isAbsolute(target)) throw new Error(`${label} must be absolute: ${target}`)
  const lexical = resolve(target)
  const root = parse(lexical).root
  const components = relative(root, lexical).split(sep).filter(Boolean)
  let current = root
  let nearestExisting = root
  const missingSuffix: string[] = []
  let missing = false

  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} has an unsafe filesystem root: ${root}`)
  const existingDirectories = [{ path: root, stat: rootStat }]

  for (const component of components) {
    current = join(current, component)
    if (missing) {
      missingSuffix.push(component)
      continue
    }
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      missing = true
      missingSuffix.push(component)
      continue
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link component: ${current}`)
    if (current !== lexical && !stat.isDirectory()) {
      throw new Error(`${label} contains a non-directory ancestor: ${current}`)
    }
    if (stat.isDirectory()) existingDirectories.push({ path: current, stat })
    nearestExisting = current
  }

  if (process.platform !== "win32") {
    // A sticky temp directory is safe only once an already-created private
    // boundary exists below it; a missing suffix can never be that boundary.
    const uid = process.getuid?.()
    for (let index = 0; index < existingDirectories.length; index++) {
      const entry = existingDirectories[index]!
      if ((entry.stat.mode & 0o022) === 0) continue
      const sticky = (entry.stat.mode & 0o1000) !== 0
      const hasPrivateBoundary = sticky && uid !== undefined && existingDirectories
        .slice(index + 1)
        .some((candidate) => candidate.stat.uid === uid && (candidate.stat.mode & 0o022) === 0)
      if (!hasPrivateBoundary) {
        throw new Error(`${label} contains a group/world-writable directory without an existing private boundary: ${entry.path}`)
      }
    }
  }

  const canonicalAncestor = realpathSync(nearestExisting)
  if (canonicalAncestor !== nearestExisting) {
    throw new Error(`${label} contains a non-canonical or changed ancestor: ${nearestExisting}`)
  }
  return resolve(canonicalAncestor, ...missingSuffix)
}
