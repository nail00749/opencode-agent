import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

export type FileLeaseRole = "coordinator" | "writer" | "readonly"
export type LeaseState = "reserved" | "active"

export type LeaseErrorCode =
  | "INVALID_PATH"
  | "FILE_CONFLICT"
  | "LEASE_NOT_FOUND"
  | "LEASE_EXPIRED"
  | "NOT_LEASE_OWNER"
  | "WRONG_ASSIGNEE"
  | "WRONG_PARENT"
  | "LEASE_ALREADY_CLAIMED"
  | "SESSION_ALREADY_CLAIMED"
  | "NO_ACTIVE_LEASE"
  | "OUT_OF_SCOPE"

export class LeaseError extends Error {
  readonly code: LeaseErrorCode

  constructor(code: LeaseErrorCode, message: string) {
    super(message)
    this.name = "LeaseError"
    this.code = code
  }
}

export interface LeaseStatus {
  leaseId: string
  parentSessionID: string
  sessionID?: string
  agent: string
  label: string
  state: LeaseState
  files: string[]
  createdAt: number
  claimedAt?: number
  lastActivityAt: number
  expiresAt: number
}

export interface FileLeaseManagerOptions {
  projectRoot: string
  reservationTtlMs?: number
  activeTtlMs?: number
  now?: () => number
  createID?: () => string
}

export interface ReserveInput {
  parentSessionID: string
  agent: string
  label: string
  files: readonly string[]
}

export interface ClaimInput {
  leaseId: string
  sessionID: string
  parentSessionID?: string
  agent: string
}

interface LeaseRecord {
  leaseId: string
  parentSessionID: string
  sessionID?: string
  agent: string
  label: string
  state: LeaseState
  files: Set<string>
  createdAt: number
  claimedAt?: number
  lastActivityAt: number
  expiresAt: number
}

const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1_000
const DEFAULT_ACTIVE_TTL_MS = 30 * 60 * 1_000

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized === "") throw new LeaseError("INVALID_PATH", `${label} must not be empty`)
  return normalized
}

function assertPositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== "" && !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child)
}

function displayPath(root: string, target: string): string {
  return relative(root, target).replaceAll("\\", "/")
}

export class FileLeaseManager {
  readonly projectRoot: string
  readonly reservationTtlMs: number
  readonly activeTtlMs: number

  private readonly now: () => number
  private readonly createID: () => string
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly fileOwners = new Map<string, string>()
  private readonly sessionOwners = new Map<string, string>()

  constructor(options: FileLeaseManagerOptions) {
    this.projectRoot = realpathSync(options.projectRoot)
    if (!statSync(this.projectRoot).isDirectory()) throw new Error(`Project root is not a directory: ${this.projectRoot}`)
    this.reservationTtlMs = assertPositiveDuration(
      options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
      "reservationTtlMs",
    )
    this.activeTtlMs = assertPositiveDuration(options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS, "activeTtlMs")
    this.now = options.now ?? Date.now
    this.createID = options.createID ?? randomUUID
  }

  reserve(input: ReserveInput): LeaseStatus {
    this.sweep()
    const parentSessionID = nonEmpty(input.parentSessionID, "parentSessionID")
    const agent = nonEmpty(input.agent, "agent")
    const label = nonEmpty(input.label, "label")
    const files = this.normalizeLeaseFiles(input.files)
    this.assertFilesAvailable(files)

    let leaseId = this.createID()
    while (this.leases.has(leaseId)) leaseId = this.createID()
    const now = this.now()
    const lease: LeaseRecord = {
      leaseId,
      parentSessionID,
      agent,
      label,
      state: "reserved",
      files: new Set(files),
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.reservationTtlMs,
    }
    this.leases.set(leaseId, lease)
    for (const file of files) this.fileOwners.set(file, leaseId)
    return this.toStatus(lease)
  }

  extend(input: { leaseId: string; parentSessionID: string; files: readonly string[] }): LeaseStatus {
    this.sweep()
    const lease = this.requireLease(input.leaseId)
    if (lease.parentSessionID !== input.parentSessionID) {
      throw new LeaseError("NOT_LEASE_OWNER", `Lease ${input.leaseId} belongs to another coordinator session`)
    }
    const files = this.normalizeLeaseFiles(input.files)
    this.assertFilesAvailable(files, lease.leaseId)
    for (const file of files) {
      lease.files.add(file)
      this.fileOwners.set(file, lease.leaseId)
    }
    this.refresh(lease)
    return this.toStatus(lease)
  }

  claim(input: ClaimInput): LeaseStatus {
    const expired = this.removeExpired(input.leaseId)
    if (expired) throw new LeaseError("LEASE_EXPIRED", `Lease ${input.leaseId} has expired`)
    this.sweep()
    const lease = this.requireLease(input.leaseId)
    if (lease.agent !== input.agent) {
      throw new LeaseError("WRONG_ASSIGNEE", `Lease ${input.leaseId} is assigned to ${lease.agent}, not ${input.agent}`)
    }
    if (input.sessionID !== lease.parentSessionID && input.parentSessionID !== lease.parentSessionID) {
      throw new LeaseError("WRONG_PARENT", `Lease ${input.leaseId} was reserved by another parent session`)
    }
    if (lease.sessionID) {
      if (lease.sessionID !== input.sessionID) {
        throw new LeaseError("LEASE_ALREADY_CLAIMED", `Lease ${input.leaseId} is already active in another session`)
      }
      this.refresh(lease)
      return this.toStatus(lease)
    }
    const existing = this.sessionOwners.get(input.sessionID)
    if (existing && existing !== lease.leaseId) {
      throw new LeaseError("SESSION_ALREADY_CLAIMED", `Session ${input.sessionID} already owns lease ${existing}`)
    }

    const now = this.now()
    lease.sessionID = input.sessionID
    lease.state = "active"
    lease.claimedAt = now
    lease.lastActivityAt = now
    lease.expiresAt = now + this.activeTtlMs
    this.sessionOwners.set(input.sessionID, lease.leaseId)
    return this.toStatus(lease)
  }

  authorizeMutation(sessionID: string, resources: readonly string[]): LeaseStatus {
    this.sweep()
    if (resources.length === 0) {
      throw new LeaseError("OUT_OF_SCOPE", "OpenCode supplied no mutation target resources; the write is denied")
    }
    const leaseId = this.sessionOwners.get(sessionID)
    if (!leaseId) throw new LeaseError("NO_ACTIVE_LEASE", `Session ${sessionID} has no active file lease`)
    const lease = this.requireLease(leaseId)
    const files = resources.map((resource) => this.canonicalize(resource, true))
    const outside = files.find((file) => !lease.files.has(file))
    if (outside) {
      throw new LeaseError(
        "OUT_OF_SCOPE",
        `File ${displayPath(this.projectRoot, outside)} is outside lease ${lease.leaseId} (${lease.label}); ask Master to extend the scope`,
      )
    }
    this.refresh(lease)
    return this.toStatus(lease)
  }

  touchSession(sessionID: string): void {
    this.sweep()
    const leaseId = this.sessionOwners.get(sessionID)
    if (!leaseId) return
    const lease = this.leases.get(leaseId)
    if (lease) this.refresh(lease)
  }

  release(leaseId: string, parentSessionID: string): void {
    this.sweep()
    const lease = this.leases.get(leaseId)
    if (!lease) return
    if (lease.parentSessionID !== parentSessionID) {
      throw new LeaseError("NOT_LEASE_OWNER", `Lease ${leaseId} belongs to another coordinator session`)
    }
    this.remove(lease)
  }

  releaseSession(sessionID: string): void {
    this.sweep()
    const owned = this.sessionOwners.get(sessionID)
    if (owned) {
      const lease = this.leases.get(owned)
      if (lease) this.remove(lease)
    }
    for (const lease of [...this.leases.values()]) {
      if (lease.parentSessionID === sessionID && lease.state === "reserved") this.remove(lease)
    }
  }

  listForCoordinator(parentSessionID: string): LeaseStatus[] {
    this.sweep()
    return [...this.leases.values()]
      .filter((lease) => lease.parentSessionID === parentSessionID)
      .sort((left, right) => left.createdAt - right.createdAt || left.leaseId.localeCompare(right.leaseId))
      .map((lease) => this.toStatus(lease))
  }

  hasActiveLeases(): boolean {
    this.sweep()
    return [...this.leases.values()].some((lease) => lease.state === "active")
  }

  sweep(): void {
    const now = this.now()
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt <= now) this.remove(lease)
    }
  }

  clear(): void {
    this.leases.clear()
    this.fileOwners.clear()
    this.sessionOwners.clear()
  }

  private removeExpired(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.expiresAt > this.now()) return false
    this.remove(lease)
    return true
  }

  private requireLease(leaseId: string): LeaseRecord {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new LeaseError("LEASE_NOT_FOUND", `Lease ${leaseId} does not exist`)
    return lease
  }

  private refresh(lease: LeaseRecord): void {
    const now = this.now()
    lease.lastActivityAt = now
    lease.expiresAt = now + (lease.state === "active" ? this.activeTtlMs : this.reservationTtlMs)
  }

  private remove(lease: LeaseRecord): void {
    this.leases.delete(lease.leaseId)
    if (lease.sessionID) this.sessionOwners.delete(lease.sessionID)
    for (const file of lease.files) {
      if (this.fileOwners.get(file) === lease.leaseId) this.fileOwners.delete(file)
    }
  }

  private assertFilesAvailable(files: readonly string[], currentLeaseId?: string): void {
    for (const file of files) {
      const ownerId = this.fileOwners.get(file)
      if (!ownerId || ownerId === currentLeaseId) continue
      const owner = this.leases.get(ownerId)
      const relativeFile = displayPath(this.projectRoot, file)
      if (!owner) throw new LeaseError("FILE_CONFLICT", `File ${relativeFile} is already reserved`)
      throw new LeaseError(
        "FILE_CONFLICT",
        `File ${relativeFile} is ${owner.state} by ${owner.agent} for ${owner.label}; change the split or serialize the work`,
      )
    }
  }

  private normalizeLeaseFiles(files: readonly string[]): string[] {
    if (files.length === 0) throw new LeaseError("INVALID_PATH", "A lease requires at least one exact file")
    return [...new Set(files.map((file) => this.canonicalize(file, false)))].sort()
  }

  private canonicalize(input: string, allowAbsolute: boolean): string {
    const value = input.trim()
    if (value === "" || value.includes("\0")) throw new LeaseError("INVALID_PATH", "File path must not be empty")
    if (!allowAbsolute && isAbsolute(value)) throw new LeaseError("INVALID_PATH", `Absolute lease path is not allowed: ${value}`)
    if (value.includes("*") || value.includes("?")) {
      throw new LeaseError("INVALID_PATH", `Lease paths must name exact files, not patterns: ${value}`)
    }
    if (value.endsWith("/") || value.endsWith("\\")) {
      throw new LeaseError("INVALID_PATH", `Lease paths must name files, not directories: ${value}`)
    }

    const candidate = resolve(this.projectRoot, value)
    if ((!allowAbsolute || !isAbsolute(value)) && !isWithin(this.projectRoot, candidate)) {
      throw new LeaseError("INVALID_PATH", `File must stay inside the project root: ${value}`)
    }

    let ancestor = candidate
    const suffix: string[] = []
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new LeaseError("INVALID_PATH", `Cannot resolve file path: ${value}`)
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }

    let canonicalAncestor: string
    try {
      canonicalAncestor = realpathSync(ancestor)
    } catch {
      throw new LeaseError("INVALID_PATH", `Cannot canonicalize file path: ${value}`)
    }
    const canonical = resolve(canonicalAncestor, ...suffix)
    if (!isWithin(this.projectRoot, canonical)) {
      throw new LeaseError("INVALID_PATH", `File resolves outside the project root: ${value}`)
    }
    try {
      if (lstatSync(canonical).isDirectory()) {
        throw new LeaseError("INVALID_PATH", `Lease paths must name files, not directories: ${value}`)
      }
    } catch (error) {
      if (error instanceof LeaseError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return canonical
  }

  private toStatus(lease: LeaseRecord): LeaseStatus {
    return {
      leaseId: lease.leaseId,
      parentSessionID: lease.parentSessionID,
      ...(lease.sessionID ? { sessionID: lease.sessionID } : {}),
      agent: lease.agent,
      label: lease.label,
      state: lease.state,
      files: [...lease.files].map((file) => displayPath(this.projectRoot, file)).sort(),
      createdAt: lease.createdAt,
      ...(lease.claimedAt === undefined ? {} : { claimedAt: lease.claimedAt }),
      lastActivityAt: lease.lastActivityAt,
      expiresAt: lease.expiresAt,
    }
  }
}
