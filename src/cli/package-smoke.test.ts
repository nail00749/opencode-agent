import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"
import { CONFIG_SCHEMA_VERSION, PACKAGE_VERSION } from "../release-metadata"

const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-package-smoke-")))
const consumerDirectory = join(root, "consumer")
const packageDirectory = join(consumerDirectory, "node_modules", "@nail00749", "agent-gvozd")
const configRoot = join(root, "config", "opencode")
const binDirectory = join(root, "bin")
const logPath = join(root, "opencode.log")

function command(executable: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  })
}

beforeAll(() => {
  const built = command("bun", ["run", "build"], process.cwd())
  if (built.status !== 0) throw new Error(built.stderr)
  mkdirSync(binDirectory)
  const fake = join(binDirectory, "opencode2")
  writeFileSync(fake, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const command = process.argv.slice(2).join(" ");
appendFileSync(process.env.GVOZD_FAKE_LOG, command + "\\n");
if (command === "--version") console.log("opencode2 v2.0.2");
else if (command === "debug paths") console.log("config     " + process.env.GVOZD_FAKE_CONFIG);
else if (command === "models") console.log(process.env.GVOZD_FAKE_MODE === "missing-models" ? "custom/model" : "openai/gpt-5.6-luna\\nopenai/gpt-5.6-sol\\nopenai/gpt-5.3-codex-spark");
else if (command === "plugin list") console.log("@nail00749/agent-gvozd ${PACKAGE_VERSION}");
else if (command.startsWith("plugin check")) console.log("0 errors");
else if (command === "debug agents") console.log("master planner back-fast back-deep front-fast front-deep review-fast review-deep researcher explorer git docs verifier debugger security devops");
else if (command === "service status") console.log("running");
else if (command === "service restart") console.log("restarted");
else if (command.startsWith("plugin add ")) console.log("installed");
else { console.error("unexpected arguments: " + command); process.exitCode = 2; }
`)
  chmodSync(fake, 0o755)

  const packed = command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], process.cwd(), {
    npm_config_cache: join(root, "npm-cache"),
  })
  if (packed.status !== 0) throw new Error(packed.stderr)
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename
  mkdirSync(consumerDirectory)
  writeFileSync(join(consumerDirectory, "package.json"), '{"private":true}\n')
  const installed = command("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", join(root, filename)], consumerDirectory, {
    npm_config_cache: join(root, "npm-cache"),
  })
  if (installed.status !== 0) throw new Error(installed.stderr)
}, 180_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("packed Node CLI", () => {
  const environment = {
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    GVOZD_FAKE_LOG: logPath,
    GVOZD_FAKE_CONFIG: configRoot,
    GVOZD_OPENCODE_CONFIG_ROOT: configRoot,
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
    expect(calls).toContain(`plugin add @nail00749/agent-gvozd@${PACKAGE_VERSION}`)
    expect(calls.match(/service restart/g)?.length).toBe(2)

    const duplicateDirectory = join(root, ".opencode", "agents")
    mkdirSync(duplicateDirectory, { recursive: true })
    writeFileSync(join(duplicateDirectory, "master.md"), "legacy duplicate\n")
    const warning = command("node", [cli, "doctor"], root, environment)
    expect(warning.status, warning.stderr).toBe(0)
    expect(warning.stdout).toContain("WARN legacy-local")
    rmSync(join(root, ".opencode"), { recursive: true, force: true })
  }, 180_000)

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
  }, 180_000)

  test("emits one machine-readable doctor object", () => {
    const cli = join(packageDirectory, "dist", "cli.js")
    const result = command("node", [cli, "doctor", "--json"], root, environment)
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ schemaVersion: CONFIG_SCHEMA_VERSION, status: "pass" })
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
  }, 180_000)
})
