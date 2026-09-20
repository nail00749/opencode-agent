import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenCodeClient } from "./opencode"
import { globalCliUpdateCommand, latestPackageVersion, parsePackageRegistration, renderUpdateResult, runUpdate, stalePackageCache, updateGlobalCli } from "./update"

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
    async pluginAdd(spec) { calls.push(`add:${spec}`) },
    async pluginRemove(spec) { calls.push(`remove:${spec}`) },
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
  test("selects the package manager that owns the installed CLI", () => {
    expect(globalCliUpdateCommand("/Users/test/.bun/install/global/node_modules/@nail00749/agent-gvozd/dist/cli.js"))
      .toEqual({ executable: "bun", args: ["add", "--global", "@nail00749/agent-gvozd@latest"] })
    expect(globalCliUpdateCommand(
      "/usr/local/lib/node_modules/@nail00749/agent-gvozd/dist/cli.js",
      "/usr/local/lib/node_modules",
    ))
      .toEqual({ executable: "npm", args: ["install", "--global", "@nail00749/agent-gvozd@latest"] })
    expect(() => globalCliUpdateCommand("/Users/test/.npm/_npx/123/node_modules/@nail00749/agent-gvozd/dist/cli.js"))
      .toThrow("Cannot determine the global package manager")
    expect(() => globalCliUpdateCommand("/workspace/node_modules/@nail00749/agent-gvozd/dist/cli.js"))
      .toThrow("Cannot determine the global package manager")
    expect(() => globalCliUpdateCommand("/workspace/opencode-agent/src/cli/update.ts"))
      .toThrow("Cannot determine the global package manager")
  })

  test("updates the globally installed CLI and verifies its package version", async () => {
    const fixture = cacheFixture()
    try {
      const packageRoot = join(fixture.root, ".bun", "install", "global", "node_modules", "@nail00749", "agent-gvozd")
      const cliEntry = join(packageRoot, "dist", "cli.js")
      mkdirSync(join(packageRoot, "dist"), { recursive: true })
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@nail00749/agent-gvozd", version: "0.3.11" }))
      writeFileSync(cliEntry, "")
      const calls: string[] = []
      const result = await updateGlobalCli({
        cliEntry,
        runner: {
          async run(executable, args) {
            calls.push(`${executable} ${args.join(" ")}`)
            writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@nail00749/agent-gvozd", version: "0.3.12" }))
            return { code: 0, stdout: "installed", stderr: "" }
          },
        },
      })
      expect(calls).toEqual(["bun add --global @nail00749/agent-gvozd@latest"])
      expect(result).toEqual({ beforeVersion: "0.3.11", afterVersion: "0.3.12", manager: "bun", output: "installed" })
    } finally {
      fixture.cleanup()
    }
  })

  test("checks npm latest without invoking OpenCode's plugin check", async () => {
    const calls: string[] = []
    const version = await latestPackageVersion({
      async run(executable, args, timeoutMs) {
        calls.push(`${executable} ${args.join(" ")} ${timeoutMs}`)
        return { code: 0, stdout: '"0.3.15"\n', stderr: "" }
      },
    })
    expect(version).toBe("0.3.15")
    expect(calls).toEqual(["npm view @nail00749/agent-gvozd@latest version --json --prefer-online 30000"])
  })

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
      const result = await runUpdate({
        check: true,
        findClient: async () => client(fixture.cache, calls, [current]),
        resolveLatestVersion: async () => "0.3.7",
      })
      expect(result.status).toBe("checked")
      expect(result.checkOutput).toContain("will migrate")
      expect(result.checkOutput).toContain("update available 0.3.6 -> 0.3.7")
      expect(result.staleCache.map((path) => path.split("/").at(-1))).toEqual(["agent-gvozd@0.3.5"])
      expect(calls).toEqual(["paths", "list"])
      expect(existsSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))).toBe(true)
      expect(renderUpdateResult(result)).toContain("1 stale Gvozd version")
    } finally {
      fixture.cleanup()
    }
  })

  test("--check compares latest registrations through npm without calling OpenCode check", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@latest"))
      const calls: string[] = []
      const current = "agent-gvozd 0.3.15 @nail00749/agent-gvozd@latest"
      const result = await runUpdate({
        check: true,
        findClient: async () => client(fixture.cache, calls, [current]),
        resolveLatestVersion: async () => "0.3.16",
      })
      expect(result.checkOutput).toBe("update available 0.3.15 -> 0.3.16")
      expect(calls).toEqual(["paths", "list"])
    } finally {
      fixture.cleanup()
    }
  })

  test("migrates a pinned Gvozd registration to latest and removes old cache roots", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.5"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6", "current-install"), { recursive: true })
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.4.0"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@next"))
      mkdirSync(join(fixture.cache, "npm", "other-plugin@1.0.0"), { recursive: true })
      const calls: string[] = []
      const before = "agent-gvozd 0.3.5 @nail00749/agent-gvozd@0.3.5"
      const stale = "agent-gvozd 0.3.5 @nail00749/agent-gvozd@latest"
      const after = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@latest"
      const result = await runUpdate({
        findClient: async () => client(fixture.cache, calls, [before, stale, after]),
        updateCli: async () => {
          calls.push("cli-update")
          return { beforeVersion: "0.3.5", afterVersion: "0.3.6", manager: "bun", output: "installed" }
        },
      })
      expect(result.status).toBe("updated")
      expect(result.after.version).toBe("0.3.6")
      expect(calls).toEqual([
        "paths",
        "list",
        "cli-update",
        "remove:@nail00749/agent-gvozd@0.3.5",
        "add:@nail00749/agent-gvozd@latest",
        "update:@nail00749/agent-gvozd@latest",
        "restart",
        "list",
        "list",
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

  test("uses the native updater once the registration tracks latest", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.7"))
      const calls: string[] = []
      const before = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@latest"
      const after = "agent-gvozd 0.3.7 @nail00749/agent-gvozd@latest"
      const result = await runUpdate({
        findClient: async () => client(fixture.cache, calls, [before, after]),
        updateCli: async () => {
          calls.push("cli-update")
          return { beforeVersion: "0.3.6", afterVersion: "0.3.7", manager: "bun", output: "installed" }
        },
      })
      expect(result.after.version).toBe("0.3.7")
      expect(calls).toEqual([
        "paths",
        "list",
        "cli-update",
        "update:@nail00749/agent-gvozd@latest",
        "restart",
        "list",
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("restores the pinned registration when latest cannot be added", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))
      const calls: string[] = []
      const current = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@0.3.6"
      const failing = client(fixture.cache, calls, [current])
      failing.pluginAdd = async (spec) => {
        calls.push(`add:${spec}`)
        if (spec.endsWith("@latest")) throw new Error("registry unavailable")
      }
      await expect(runUpdate({
        findClient: async () => failing,
        updateCli: async () => {
          calls.push("cli-update")
          return { beforeVersion: "0.3.11", afterVersion: "0.3.12", manager: "bun", output: "installed" }
        },
      })).rejects.toThrow("previous registration was restored")
      expect(calls).toEqual([
        "paths",
        "list",
        "cli-update",
        "remove:@nail00749/agent-gvozd@0.3.6",
        "add:@nail00749/agent-gvozd@latest",
        "add:@nail00749/agent-gvozd@0.3.6",
        "list",
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("reports an unreconciled registration when latest rollback removal fails", async () => {
    const fixture = cacheFixture()
    try {
      mkdirSync(join(fixture.packageRoot, "agent-gvozd@0.3.6"))
      const calls: string[] = []
      const current = "agent-gvozd 0.3.6 @nail00749/agent-gvozd@0.3.6"
      const failing = client(fixture.cache, calls, [current])
      failing.pluginUpdate = async (spec) => {
        calls.push(`update:${spec}`)
        throw new Error("registry unavailable")
      }
      failing.pluginRemove = async (spec) => {
        calls.push(`remove:${spec}`)
        if (spec.endsWith("@latest")) throw new Error("remove failed")
      }
      await expect(runUpdate({
        findClient: async () => failing,
        updateCli: async () => {
          calls.push("cli-update")
          return { beforeVersion: "0.3.6", afterVersion: "0.3.6", manager: "bun", output: "installed" }
        },
      })).rejects.toThrow("new registration could not be removed")
      expect(calls).toEqual([
        "paths",
        "list",
        "cli-update",
        "remove:@nail00749/agent-gvozd@0.3.6",
        "add:@nail00749/agent-gvozd@latest",
        "update:@nail00749/agent-gvozd@latest",
        "remove:@nail00749/agent-gvozd@latest",
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("reports CLI and OpenCode plugin versions separately", () => {
    expect(renderUpdateResult({
      status: "updated",
      cli: { beforeVersion: "0.3.11", afterVersion: "0.3.12", manager: "bun", output: "installed" },
      before: { source: "@nail00749/agent-gvozd@0.3.11", version: "0.3.11", cacheTag: "0.3.11" },
      after: { source: "@nail00749/agent-gvozd@latest", version: "0.3.12", cacheTag: "latest" },
      checkOutput: "",
      updateOutput: "Migrated registration",
      staleCache: [],
      removedCache: [],
    })).toContain("Gvozd CLI 0.3.11 -> 0.3.12: update complete\nOpenCode plugin 0.3.11 -> 0.3.12: update complete")
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
