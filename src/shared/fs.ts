import { randomUUID } from "node:crypto"
import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, sep } from "node:path"

/** `lstat` that returns `undefined` for a missing path and rethrows other errors. */
export function statOptional(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** True when `target` equals or lives below `root` without escaping via `..`. */
export function isWithinOrEqual(root: string, target: string): boolean {
  const child = relative(root, target)
  return !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child)
}

/** True when `target` is strictly below `root` (equal counts as outside). */
export function isWithin(root: string, target: string): boolean {
  return root !== target && isWithinOrEqual(root, target)
}

/** Throwing variant of {@link isWithinOrEqual} for callers that fail with a label. */
export function assertWithin(root: string, target: string, label: string): void {
  if (!isWithinOrEqual(root, target)) throw new Error(`${label} must stay inside ${root}: ${target}`)
}

/**
 * Creates a file exclusively (fails when the target exists) with owner-only
 * permissions. The caller decides what safety checks must run first.
 */
export function createExclusiveFile(path: string, content: string): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    writeFileSync(descriptor, content)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Atomically replaces a file through a unique temporary sibling. The caller
 * owns concurrency checks; this only guarantees the swap does not expose a
 * partial write.
 */
export function replaceFileAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  createExclusiveFile(temporary, content)
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

/**
 * Asserts the nearest existing ancestor of `path` is a user-owned, non-symlink
 * directory that is not group/world writable and grants write access. Missing
 * suffixes are skipped: only the existing boundary is checked.
 */
export function assertWriteable(path: string, label: string): void {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  try {
    const current = lstatSync(candidate)
    if (current.isSymbolicLink() || (!current.isDirectory() && candidate !== path)) throw new Error("unsafe parent")
    const uid = process.getuid?.()
    if (uid !== undefined && (current.uid !== uid || (current.mode & 0o022) !== 0)) throw new Error("unsafe ownership or mode")
    accessSync(candidate, fsConstants.W_OK | (current.isDirectory() ? fsConstants.X_OK : 0))
  } catch {
    throw new Error(`${label} is not writeable: ${path}`)
  }
}