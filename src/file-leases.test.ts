import { afterEach, describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FileLeaseManager,
  GVOZD_CASE_INSENSITIVE_FILESYSTEM,
  LeaseError,
  resolveCaseInsensitiveFilesystem,
} from "./file-leases"

const temporaryProjects: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-leases-"))
  temporaryProjects.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  return root
}

function manager(root = project(), options: {
  now?: () => number
  reservationTtlMs?: number
  activeTtlMs?: number
  caseInsensitive?: boolean
  platform?: NodeJS.Platform
} = {}) {
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

  test("deduplicates exact canonical paths", () => {
    const leases = manager()
    const lease = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "normalize",
      files: ["src/./a.ts", "src/a.ts", "src/a.ts"],
    })
    expect(lease.files).toEqual(["src/a.ts"])
  })

  test("rejects distinct planned aliases in one case-insensitive batch without reserving either", () => {
    const leases = manager(project(), { caseInsensitive: true })
    try {
      leases.reserve({
        parentSessionID: "master-1",
        agent: "back-fast",
        label: "case aliases",
        files: ["src/New.ts", "src/new.ts"],
      })
      throw new Error("expected ambiguous alias rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(LeaseError)
      expect((error as LeaseError).code).toBe("INVALID_PATH")
      expect((error as Error).message).toContain("ambiguous file aliases src/New.ts and src/new.ts")
    }

    expect(leases.reserve({
      parentSessionID: "master-1",
      agent: "front-fast",
      label: "available after rejected batch",
      files: ["src/new.ts"],
    }).files).toEqual(["src/new.ts"])
  })

  test("separately leases and authorizes New/new files on a case-sensitive filesystem", () => {
    const root = project()
    const upperPath = join(root, "src", "New.ts")
    const lowerPath = join(root, "src", "new.ts")
    writeFileSync(upperPath, "upper\n")
    writeFileSync(lowerPath, "lower\n")
    if (realpathSync(upperPath) === realpathSync(lowerPath)) return

    const leases = manager(root, { caseInsensitive: false })
    const upper = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "upper",
      files: ["src/New.ts"],
    })
    const lower = leases.reserve({
      parentSessionID: "master-1",
      agent: "front-fast",
      label: "lower",
      files: ["src/new.ts"],
    })
    leases.claim({ leaseId: upper.leaseId, sessionID: "upper-child", parentSessionID: "master-1", agent: "back-fast" })
    leases.claim({ leaseId: lower.leaseId, sessionID: "lower-child", parentSessionID: "master-1", agent: "front-fast" })
    expect(leases.authorizeMutation("upper-child", ["src/New.ts"]).leaseId).toBe(upper.leaseId)
    expect(leases.authorizeMutation("lower-child", ["src/new.ts"]).leaseId).toBe(lower.leaseId)
    expect(() => leases.authorizeMutation("upper-child", ["src/new.ts"])).toThrow("outside lease")
    expect(() => leases.authorizeMutation("lower-child", ["src/New.ts"])).toThrow("outside lease")
  })

  test("separately leases and authorizes NFC/NFD files on a normalization-sensitive filesystem", () => {
    const root = project()
    const nfc = "src/caf\u00e9.ts"
    const nfd = "src/cafe\u0301.ts"
    const nfcPath = join(root, nfc)
    const nfdPath = join(root, nfd)
    writeFileSync(nfcPath, "NFC\n")
    writeFileSync(nfdPath, "NFD\n")
    if (realpathSync(nfcPath) === realpathSync(nfdPath)) return

    const leases = manager(root, { caseInsensitive: false })
    const composed = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "NFC",
      files: [nfc],
    })
    const decomposed = leases.reserve({
      parentSessionID: "master-1",
      agent: "front-fast",
      label: "NFD",
      files: [nfd],
    })
    leases.claim({ leaseId: composed.leaseId, sessionID: "nfc-child", parentSessionID: "master-1", agent: "back-fast" })
    leases.claim({ leaseId: decomposed.leaseId, sessionID: "nfd-child", parentSessionID: "master-1", agent: "front-fast" })
    expect(leases.authorizeMutation("nfc-child", [nfc]).leaseId).toBe(composed.leaseId)
    expect(leases.authorizeMutation("nfd-child", [nfd]).leaseId).toBe(decomposed.leaseId)
    expect(() => leases.authorizeMutation("nfc-child", [nfd])).toThrow("outside lease")
    expect(() => leases.authorizeMutation("nfd-child", [nfc])).toThrow("outside lease")
  })

  test("release removes the normalized owner key and permits an alias reservation", () => {
    const leases = manager(project(), { caseInsensitive: true })
    const first = leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "first spelling",
      files: ["src/New.ts"],
    })
    leases.release(first.leaseId, "master-1")
    expect(leases.reserve({
      parentSessionID: "master-1",
      agent: "front-fast",
      label: "released alias",
      files: ["src/new.ts"],
    }).files).toEqual(["src/new.ts"])
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

    const real = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "real", files: ["src/a.ts"] })
    expect(() =>
      leases.reserve({ parentSessionID: "master-1", agent: "front-fast", label: "alias", files: ["src/alias.ts"] }),
    ).toThrow(LeaseError)
    expect(() =>
      leases.reserve({ parentSessionID: "master-1", agent: "front-fast", label: "outside", files: ["src/outside.ts"] }),
    ).toThrow(LeaseError)
    leases.claim({ leaseId: real.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    expect(leases.authorizeMutation("child-1", ["src/alias.ts"]).leaseId).toBe(real.leaseId)
  })

  test("rejects existing internal hard-link aliases", () => {
    const root = project()
    linkSync(join(root, "src", "a.ts"), join(root, "src", "alias.ts"))
    const leases = manager(root)
    for (const file of ["src/a.ts", "src/alias.ts"]) {
      try {
        leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "hardlink", files: [file] })
        throw new Error("expected hard-link rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(LeaseError)
        expect((error as LeaseError).code).toBe("INVALID_PATH")
      }
    }
  })

  test("rejects an in-project hard link to an external file", () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), "gvozd-hardlink-outside-"))
    temporaryProjects.push(outside)
    const external = join(outside, "external.ts")
    writeFileSync(external, "external\n")
    linkSync(external, join(root, "src", "external-alias.ts"))
    const leases = manager(root)
    expect(() => leases.reserve({
      parentSessionID: "master-1",
      agent: "back-fast",
      label: "outside-hardlink",
      files: ["src/external-alias.ts"],
    })).toThrow("Hard-linked")
  })

  test("rejects existing socket targets where Unix sockets are supported", async () => {
    if (process.platform === "win32") return
    const root = project()
    const socketPath = join(root, "src", "lease.sock")
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    try {
      const leases = manager(root)
      expect(() => leases.reserve({
        parentSessionID: "master-1",
        agent: "back-fast",
        label: "socket",
        files: ["src/lease.sock"],
      })).toThrow("regular files")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe("filesystem case policy", () => {
  test("uses platform defaults only when the override is unset", () => {
    expect(resolveCaseInsensitiveFilesystem({}, "darwin")).toBe(true)
    expect(resolveCaseInsensitiveFilesystem({}, "win32")).toBe(true)
    expect(resolveCaseInsensitiveFilesystem({}, "linux")).toBe(false)
  })

  test("accepts only exact operator overrides", () => {
    expect(resolveCaseInsensitiveFilesystem({ [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: "0" }, "darwin")).toBe(false)
    expect(resolveCaseInsensitiveFilesystem({ [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: "1" }, "linux")).toBe(true)

    for (const invalid of ["", "true", "false", " 1", "01"]) {
      expect(() => resolveCaseInsensitiveFilesystem({ [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: invalid }, "linux"))
        .toThrow(`${GVOZD_CASE_INSENSITIVE_FILESYSTEM} must be exactly 1 or 0`)
    }
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

  test("revalidates a planned file and denies a hard link created before mutation", () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), "gvozd-hardlink-outside-"))
    temporaryProjects.push(outside)
    const external = join(outside, "external.ts")
    writeFileSync(external, "external\n")
    const leases = manager(root)
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "planned", files: ["src/planned.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    linkSync(external, join(root, "src", "planned.ts"))
    try {
      leases.authorizeMutation("child-1", ["src/planned.ts"])
      throw new Error("expected mutation denial")
    } catch (error) {
      expect(error).toBeInstanceOf(LeaseError)
      expect((error as LeaseError).code).toBe("OUT_OF_SCOPE")
    }
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

describe("FileLeaseManager snapshot", () => {
  test("returns claimed leases first, then reserved, each with display paths", () => {
    const root = project()
    const leases = manager(root)
    const reserved = leases.reserve({ parentSessionID: "m1", agent: "back-deep", label: "migration", files: ["src/migrate.ts"] })
    const active = leases.reserve({ parentSessionID: "m1", agent: "back-fast", label: "fix", files: ["src/fix.ts"] })
    leases.claim({ leaseId: active.leaseId, sessionID: "w1", parentSessionID: "m1", agent: "back-fast" })

    const snapshot = leases.snapshot()
    expect(snapshot.map((lease) => lease.leaseId)).toEqual([active.leaseId, reserved.leaseId])
    expect(snapshot[0]).toMatchObject({ agent: "back-fast", state: "active", files: ["src/fix.ts"] })
    expect(snapshot[1]).toMatchObject({ agent: "back-deep", state: "reserved", files: ["src/migrate.ts"] })
  })

  test("returns an empty snapshot without leases", () => {
    expect(manager(project()).snapshot()).toEqual([])
  })
})
