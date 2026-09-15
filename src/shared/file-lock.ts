import { randomUUID } from "node:crypto"
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { secureCanonicalPath } from "./secure-path"

/** An old lock with a dead or malformed owner is safe to collect. */
const STALE_LOCK_AGE_MS = 30 * 60 * 1_000

function lockOwnerAlive(path: string): boolean {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return true // Unreadable lock: treat as live rather than steal it.
  }
  const pid = Number(contents.split(":")[0])
  // Metadata is written synchronously immediately after O_EXCL creation. An
  // old malformed file is therefore a crash remnant, not an active lock.
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    return true // EPERM and friends: the owner may still exist.
  }
}

function assertSecure(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Lock directory is unsafe: ${path}`)
  const uid = process.getuid?.()
  if (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) {
    throw new Error(`Lock directory must be owner-controlled and not group/world writable: ${path}`)
  }
  accessSync(path, constants.W_OK | constants.X_OK)
}

function acquire(path: string, operation: string): { path: string; descriptor: number; nonce: string; dev: number; ino: number } {
  const canonicalPath = secureCanonicalPath(path, "Lock path")
  const directory = dirname(canonicalPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (secureCanonicalPath(canonicalPath, "Lock path") !== canonicalPath) throw new Error(`Lock path changed during creation: ${path}`)
  assertSecure(directory)
  const nonce = `${process.pid}:${randomUUID()}\n`
  let descriptor: number
  try {
    descriptor = openSync(canonicalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // A lock whose owning process is gone (or one that sat unclaimed far past
    // any plausible run) is stale; removing it recovers from crashes instead
    // of demanding manual inspection.
    if (removeStaleLock(canonicalPath)) {
      descriptor = openSync(canonicalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } else {
      throw new Error(`Another Gvozd ${operation} is active or left a lock at ${canonicalPath}; inspect it manually and do not delete it while work may be running`)
    }
  }
  const created = fstatSync(descriptor)
  writeFileSync(descriptor, nonce)
  return { path: canonicalPath, descriptor, nonce, dev: created.dev, ino: created.ino }
}

function removeStaleLock(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return false
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false
  if (Date.now() - stat.mtimeMs < STALE_LOCK_AGE_MS) return false
  if (lockOwnerAlive(path)) return false
  try {
    // Re-verify the file is still the same inode before unlinking.
    const current = lstatSync(path)
    if (current.isSymbolicLink() || !current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function release(lock: ReturnType<typeof acquire>): void {
  closeSync(lock.descriptor)
  if (existsSync(lock.path)) {
    const current = lstatSync(lock.path)
    if (current.isFile() && !current.isSymbolicLink() && current.dev === lock.dev && current.ino === lock.ino
      && readFileSync(lock.path, "utf8") === lock.nonce) unlinkSync(lock.path)
  }
}

export async function withExclusiveFileLock<T>(path: string, callback: () => Promise<T> | T): Promise<T> {
  const lock = acquire(path, "setup")
  try {
    return await callback()
  } finally {
    release(lock)
  }
}

export function withExclusiveFileLockSync<T>(path: string, callback: () => T, operation = "operation"): T {
  const lock = acquire(path, operation)
  try {
    return callback()
  } finally {
    release(lock)
  }
}
