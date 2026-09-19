import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenCodeClient } from "./opencode"
import { parsePackageRegistration, renderUpdateResult, runUpdate, stalePackageCache } from "./update"

function cacheFixture(): { root: string; cache: string; packageRoot: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-update-")))
  const cache = join(root, "cache")
  const packageRoot = join(cache, "npm", "@nail00749")
  mkdirSync(packageRoot, { recursive: true })
  return { root, cache, packageRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function client(cache: string, calls: string[], listings: string[]): OpenCodeClient {
  let listing = 0
  return {
    executable: "opencode2",
    async version() { return "2.0.8" },
    async debugPaths() { calls.push("paths"); return { config: join(cache, "config"), cache } },
    async models() { return [] },
    async pluginAdd() {},
    async pluginRemove() {},
    async pluginList() { calls.push("list"); return listings[Math.min(listing++, listings.length - 1)]! },
    async pluginCheck(spec) { calls.push(`check:${spec}`); return "Server\n  agent-gvozd 0.3.6 (current)" },
    async pluginUpdate(spec) { calls.push(`update:${spec}`); return "Updated agent-gvozd" },
    async debugAgents() { return "" },
    async serviceStatus() { return "running" },
    async serviceRestart() { calls.push("restart") },
    async apiJson() { return {} },
  }
}

describe("native plugin update", () => {
  test("parses the configured package source from current and legacy plugin listings", () => {
    expect(parsePackageRegistration("ID VERSION SOURCE\nagent-gvozd 0.3.6 @nail00749/agent-gvozd@0.3.6\n"))
      .toEqual({ source: "@nail00749/agent-gvozd@0.3.6", version: "0.3.6", cacheTag: "0.3.6" })
    expect(parsePackageRegistration("@nail00749/agent-gvozd@latest 0.3.7"))
      .toEqual({ source: "@nail00749/agent-gvozd@latest", version: "0.3.7", cacheTag: "latest" })
    expect(() => parsePackageRegistration("other-plugin 1.0.0 other-plugin@1.0.0")).toThrow("not registered")
  })

  test("--check reports stale versions without mutating the plugin or cache", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))
      const calls: string[] = []
      const current = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@0.3.6"
      const result = await runUpdate({ check: true, findClient: async () => client(fixture.cache, calls, [current]) })
      expect(result.status).toBe("checked")
      expect(result.staleCache.map((path) => path.split("/").at(-1))).toEqual(["agent-gvozd@0.3.5"])
      expect(calls).toEqual(["paths", "list", "check:@nail00749/agent-gvozd@0.3.6"])
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))).toBe(true)
      expect(renderUpdateResult(result)).toContain("1 stale Gvozd version")
    } finally {
      fixture.cleanup()
    }
  })

  test("updates only Gvozd, restarts, and removes old Gvozd version roots", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6", "current-install"), { recursive: true })
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.4.0"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@next"))
      mkdirSync(join(fixture.cache, "npm", "other-plugin@1.0.0"), { recursive: true })
      const calls: string[] = []
      const before = "agent-gvozd 0.3.5 @nail00749/agent-gvozd@0.3.5"
      const after = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@0.3.6"
      const result = await runUpdate({ findClient: async () => client(fixture.cache, calls, [before, after]) })
      expect(result.status).toBe("updated")
      expect(result.after.version).toBe("0.3.6")
      expect(calls).toEqual([
        "paths",
        "list",
        "check:@nail00749/agent-gvozd@0.3.5",
        "update:@nail00749/agent-gvozd@0.3.5",
        "restart",
        "list",
        "check:@nail00749/agent-gvozd@0.3.6",
      ])
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))).toBe(false)
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))).toBe(true)
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@0.4.0"))).toBe(true)
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@next"))).toBe(true)
      expect(existsSync(join(fixture.cache, "npm", "other-plugin@1.0.0"))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("refuses a symlink masquerading as an old Gvozd cache version", () => {
    if (process.platform === "win32") return
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))
      const outside = join(fixture.root, "outside")
      mkdirSync(outside)
      symlinkSync(outside, join(fixture.packageRoot, "agent-gvozd@0.3.5"))
      expect(() => stalePackageCache(fixture.cache, {
        source: "@nail00749/agent-gvozd@0.3.6",
        version: "0.3.6",
        cacheTag: "0.3.6",
      })).toThrow("symbolic-link")
      expect(existsSync(outside)).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })
})
