import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInit } from "./init"

describe("project init", () => {
  test("scaffolds the project layer, materializes agents, and prints next steps", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-init-")))
    try {
      const output: string[] = []
      const result = await runInit({ target: root, cwd: root, output: (message) => output.push(message) })
      expect(result.directory).toBe(root)
      expect(result.createdConfig).toBe(true)
      const source = readFileSync(result.configPath, "utf8")
      expect(source).toContain('"$schema"')
      expect(source).not.toContain("GVOZD_TRUST_PROJECT_CONFIG")
      expect(source).not.toContain('"jev"')
      expect(source).not.toContain('"lease"')
      expect(source).not.toContain('"defaultAgent"')
      // Owner-only project config for the manual probe evidence.
      expect(lstatSync(result.configPath).mode & 0o777).toBe(0o600)
      expect(existsSync(join(root, "docs", ".gvozd", "agents"))).toBe(true)
      expect(existsSync(join(root, ".opencode", "agents", "master.md"))).toBe(true)
      const joined = output.join("\n")
      expect(joined).toContain(`Initialized Gvozd project layer in ${root}`)
      expect(joined).toContain("Next steps:")
      expect(joined).toContain("gvozd sync")
      expect(joined).toContain("gvozd doctor")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("defaults the target to cwd and keeps an existing project config", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-init-")))
    try {
      const first = await runInit({ cwd: root })
      expect(first.directory).toBe(root)
      const custom = readFileSync(first.configPath, "utf8").replace('"agents": {}', '"agents": { "docs": { "description": "Project docs voice" } }')
      writeFileSync(first.configPath, custom)
      const second = await runInit({ cwd: root })
      expect(second.createdConfig).toBe(false)
      expect(readFileSync(second.configPath, "utf8")).toContain("Project docs voice")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses symlinked components and traversal outside the validated root", async () => {
    if (process.platform === "win32") return
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-init-")))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-init-outside-")))
    try {
      symlinkSync(outside, join(root, "linked"))
      await expect(runInit({ target: join(root, "linked", "project"), cwd: root })).rejects.toThrow("symbolic-link")
      expect(existsSync(join(outside, "project"))).toBe(false)
      expect(existsSync(join(root, "project"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
