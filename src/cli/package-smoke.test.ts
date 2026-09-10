import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"

const root = mkdtempSync(join(tmpdir(), "gvozd-package-smoke-"))
const packageDirectory = join(root, "package")
const configRoot = join(root, "config", "opencode")
const binDirectory = join(root, "bin")
const logPath = join(root, "opencode.log")

function command(executable: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  })
}

beforeAll(() => {
  const built = command("bun", ["run", "build"], process.cwd())
  if (built.status !== 0) throw new Error(built.stderr)
  mkdirSync(binDirectory)
  const fake = join(binDirectory, "opencode2")
  writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> "$GVOZD_FAKE_LOG"
case "$*" in
  "--version") printf '%s\\n' 'opencode2 v0.0.0-beta-19425' ;;
  "debug paths") printf 'config     %s\\n' "$GVOZD_FAKE_CONFIG" ;;
  "models")
    if [ "$GVOZD_FAKE_MODE" = "missing-models" ]; then printf '%s\\n' 'custom/model';
    else printf '%s\\n' 'openai/gpt-5.6-luna' 'openai/gpt-5.6-sol' 'openai/gpt-5.3-codex-spark'; fi ;;
  "plugin list") printf '%s\\n' '@nail00749/agent-gvozd 0.1.0' ;;
  plugin\\ check*) printf '%s\\n' 'ok' ;;
  "debug agents") printf '%s\\n' 'master planner back-fast back-deep front-fast front-deep review-fast review-deep researcher explorer git docs verifier debugger security devops' ;;
  "service status") printf '%s\\n' 'running' ;;
  "service restart") printf '%s\\n' 'restarted' ;;
  plugin\\ add*) printf '%s\\n' 'installed' ;;
  *) printf '%s\\n' "unexpected arguments: $*" >&2; exit 2 ;;
esac
`)
  chmodSync(fake, 0o755)

  const packed = command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], process.cwd(), {
    npm_config_cache: join(root, "npm-cache"),
  })
  if (packed.status !== 0) throw new Error(packed.stderr)
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename
  const extracted = command("tar", ["-xzf", join(root, filename)], root)
  if (extracted.status !== 0) throw new Error(extracted.stderr)
}, 30_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("packed Node CLI", () => {
  const environment = {
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    GVOZD_FAKE_LOG: logPath,
    GVOZD_FAKE_CONFIG: configRoot,
  }

  test("runs setup twice idempotently from the npm artifact", () => {
    const cli = join(packageDirectory, "dist", "cli.js")
    const first = command("node", [cli, "setup", "--yes"], root, environment)
    expect(first.status, first.stderr).toBe(0)
    const second = command("node", [cli, "setup", "--yes"], root, environment)
    expect(second.status, second.stderr).toBe(0)
    expect(existsSync(join(configRoot, "agents", "master.md"))).toBe(true)
    expect(readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")).toContain("openai/gpt-5.6-sol")
    const calls = readFileSync(logPath, "utf8")
    expect(calls).toContain("plugin add @nail00749/agent-gvozd@^0.1.0")
    expect(calls.match(/service restart/g)?.length).toBe(2)

    const duplicateDirectory = join(root, ".opencode", "agents")
    mkdirSync(duplicateDirectory, { recursive: true })
    writeFileSync(join(duplicateDirectory, "master.md"), "legacy duplicate\n")
    const warning = command("node", [cli, "doctor"], root, environment)
    expect(warning.status, warning.stderr).toBe(0)
    expect(warning.stdout).toContain("WARN legacy-local")
    rmSync(join(root, ".opencode"), { recursive: true, force: true })
  }, 30_000)

  test("fails safely for missing models and unmanaged agent collisions", () => {
    const cli = join(packageDirectory, "dist", "cli.js")
    const missingRoot = join(root, "missing", "opencode")
    const missing = command("node", [cli, "setup", "--yes"], root, {
      ...environment,
      GVOZD_FAKE_CONFIG: missingRoot,
      GVOZD_FAKE_MODE: "missing-models",
    })
    expect(missing.status).toBe(1)
    expect(existsSync(missingRoot)).toBe(false)

    const collisionRoot = join(root, "collision", "opencode")
    mkdirSync(join(collisionRoot, "agents"), { recursive: true })
    writeFileSync(join(collisionRoot, "agents", "master.md"), "user owned\n")
    const collision = command("node", [cli, "setup", "--yes"], root, {
      ...environment,
      GVOZD_FAKE_CONFIG: collisionRoot,
      GVOZD_FAKE_LOG: join(root, "collision.log"),
    })
    expect(collision.status).toBe(1)
    expect(collision.stderr).toContain("unmanaged")
    expect(readFileSync(join(collisionRoot, "agents", "master.md"), "utf8")).toBe("user owned\n")
    expect(readFileSync(join(root, "collision.log"), "utf8")).not.toContain("plugin add")
  }, 30_000)

  test("emits one machine-readable doctor object", () => {
    const cli = join(packageDirectory, "dist", "cli.js")
    const result = command("node", [cli, "doctor", "--json"], root, environment)
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ schemaVersion: 1, status: "pass" })
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
  }, 30_000)
})
