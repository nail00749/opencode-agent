import { randomUUID } from "node:crypto"
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { secureCanonicalPath } from "./secure-path"

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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another Gvozd ${operation} is active or left a lock at ${canonicalPath}; inspect it manually and do not delete it while work may be running`)
    }
    throw error
  }
  const created = fstatSync(descriptor)
  writeFileSync(descriptor, nonce)
  return { path: canonicalPath, descriptor, nonce, dev: created.dev, ino: created.ino }
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
