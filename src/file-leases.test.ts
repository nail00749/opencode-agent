import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileLeaseManager, LeaseError } from "./file-leases"

const temporaryProjects: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-leases-"))
  temporaryProjects.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  return root
}

function manager(root = project(), options: { now?: () => number; reservationTtlMs?: number; activeTtlMs?: number } = {}) {
  let sequence = 0
  return new FileLeaseManager({
    projectRoot: root,
    createID: () => `lease-${++sequence}`,
    ...options,
  })
}

afterEach(() => {
  for (const root of temporaryProjects.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("FileLeaseManager reservations", () => {
  test("reserves disjoint exact files and rejects an overlapping batch atomically", () => {
    const leases = manager()
    const first = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "backend",
      files: ["src/a.ts"],
    })

    expect(first).toMatchObject({
      leaseId: "lease-1",
      state: "reserved",
      files: ["src/a.ts"],
    })
    expect(() =>
      leases.reserve({
        parentSessionID: "master-1",
        agent: "front-fast",
        label: "frontend",
        files: ["src/b.ts", "src/a.ts"],
      }),
    ).toThrow(LeaseError)

    expect(
      leases.reserve({
        parentSessionID: "master-1",
        agent: "front-fast",
        label: "frontend",
        files: ["src/b.ts"],
      }).files,
    ).toEqual(["src/b.ts"])
  })

  test("normalizes duplicate dot segments", () => {
    const leases = manager()
    const lease = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "normalize",
      files: ["src/./a.ts", "src/a.ts"],
    })
    expect(lease.files).toEqual(["src/a.ts"])
  })

  test("rejects absolute, escaping, root, and directory scopes", () => {
    const root = project()
    const leases = manager(root)
    const reserve = (file: string) =>
      leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "bad", files: [file] })

    expect(() => reserve(join(root, "src", "a.ts"))).toThrow(LeaseError)
    expect(() => reserve("../outside.ts")).toThrow(LeaseError)
    expect(() => reserve(".")).toThrow(LeaseError)
    expect(() => reserve("src")).toThrow(LeaseError)
  })

  test("canonicalizes symlink aliases and rejects symlinks outside the project", () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), "gvozd-outside-"))
    temporaryProjects.push(outside)
    writeFileSync(join(outside, "secret.ts"), "secret\n")
    symlinkSync("a.ts", join(root, "src", "alias.ts"))
    symlinkSync(join(outside, "secret.ts"), join(root, "src", "outside.ts"))
    const leases = manager(root)

    leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "real", files: ["src/a.ts"] })
    expect(() =>
      leases.reserve({ parentSessionID: "master-1", agent: "front-fast", label: "alias", files: ["src/alias.ts"] }),
    ).toThrow(LeaseError)
    expect(() =>
      leases.reserve({ parentSessionID: "master-1", agent: "front-fast", label: "outside", files: ["src/outside.ts"] }),
    ).toThrow(LeaseError)
  })
})

describe("FileLeaseManager claims and authorization", () => {
  test("claim requires the assigned agent and reserving parent", () => {
    const leases = manager()
    const lease = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "backend",
      files: ["src/a.ts"],
    })

    expect(() =>
      leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-2", agent: "back-fast" }),
    ).toThrow(LeaseError)
    expect(() =>
      leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "front-fast" }),
    ).toThrow(LeaseError)

    expect(
      leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" }),
    ).toMatchObject({ state: "active", sessionID: "child-1" })
  })

  test("claim is idempotent but one session cannot own two leases", () => {
    const leases = manager()
    const first = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "one", files: ["src/a.ts"] })
    const second = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "two", files: ["src/b.ts"] })
    const input = { leaseId: first.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" }

    expect(leases.claim(input).leaseId).toBe(first.leaseId)
    expect(leases.claim(input).leaseId).toBe(first.leaseId)
    expect(() => leases.claim({ ...input, leaseId: second.leaseId })).toThrow(LeaseError)
  })

  test("a coordinator can claim its own reservation", () => {
    const leases = manager()
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "master", label: "integration", files: ["src/a.ts"] })
    expect(leases.claim({ leaseId: lease.leaseId, sessionID: "master-1", agent: "master" }).state).toBe("active")
  })

  test("authorizes only complete in-scope mutation batches", () => {
    const root = project()
    const leases = manager(root)
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })

    expect(leases.authorizeMutation("child-1", ["src/a.ts"]).leaseId).toBe(lease.leaseId)
    expect(leases.authorizeMutation("child-1", [join(root, "src", "a.ts")]).leaseId).toBe(lease.leaseId)
    expect(() => leases.authorizeMutation("child-1", [])).toThrow(LeaseError)
    expect(() => leases.authorizeMutation("child-1", ["src/a.ts", "src/b.ts"])).toThrow(LeaseError)
    expect(() => leases.authorizeMutation("other", ["src/a.ts"])).toThrow(LeaseError)
  })

  test("extends an active lease atomically and only by its coordinator", () => {
    const leases = manager()
    const first = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: first.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    const other = leases.reserve({ parentSessionID: "master-2", agent: "front-fast", label: "other", files: ["src/c.ts"] })

    expect(() => leases.extend({ leaseId: first.leaseId, parentSessionID: "master-2", files: ["src/b.ts"] })).toThrow(LeaseError)
    expect(() => leases.extend({ leaseId: first.leaseId, parentSessionID: "master-1", files: ["src/b.ts", "src/c.ts"] })).toThrow(LeaseError)
    expect(leases.extend({ leaseId: first.leaseId, parentSessionID: "master-1", files: ["src/b.ts"] }).files).toEqual([
      "src/a.ts",
      "src/b.ts",
    ])
    expect(leases.authorizeMutation("child-1", ["src/b.ts"]).leaseId).toBe(first.leaseId)
    expect(other.state).toBe("reserved")
  })
})

describe("FileLeaseManager lifecycle", () => {
  test("expires reservations and refreshes active leases on activity", () => {
    let now = 1_000
    const leases = manager(project(), {
      now: () => now,
      reservationTtlMs: 100,
      activeTtlMs: 200,
    })
    const expired = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "old", files: ["src/a.ts"] })
    now = 1_101
    leases.sweep()
    expect(leases.listForCoordinator("master-1")).toEqual([])

    const active = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "new", files: ["src/a.ts"] })
    leases.claim({ leaseId: active.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    now = 1_250
    leases.touchSession("child-1")
    now = 1_401
    leases.sweep()
    expect(leases.authorizeMutation("child-1", ["src/a.ts"]).leaseId).toBe(active.leaseId)
    expect(expired.leaseId).not.toBe(active.leaseId)
  })

  test("an expired active lease does not block the session from claiming another lease", () => {
    let now = 1_000
    const leases = manager(project(), { now: () => now, activeTtlMs: 100 })
    const first = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "first", files: ["src/a.ts"] })
    const second = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "second", files: ["src/b.ts"] })
    leases.claim({ leaseId: first.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })

    now = 1_101
    expect(
      leases.claim({ leaseId: second.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" }).leaseId,
    ).toBe(second.leaseId)
  })

  test("releases by owner or terminal session and redacts canonical paths", () => {
    const leases = manager()
    const reserved = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    expect(leases.listForCoordinator("master-2")).toEqual([])
    expect(leases.listForCoordinator("master-1")[0]?.files).toEqual(["src/a.ts"])
    expect(() => leases.release(reserved.leaseId, "master-2")).toThrow(LeaseError)

    leases.claim({ leaseId: reserved.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    expect(leases.hasActiveLeases()).toBe(true)
    leases.releaseSession("child-1")
    expect(leases.hasActiveLeases()).toBe(false)
    expect(leases.listForCoordinator("master-1")).toEqual([])

    expect(() => leases.release("missing", "master-1")).not.toThrow()
  })
})
