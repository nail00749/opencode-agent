import { tmpdir } from "node:os"
import { join } from "node:path"

const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), "agent-gvozd-npm-cache") },
  stdout: "pipe",
  stderr: "pipe",
})
if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "npm pack --dry-run failed")

const payload = JSON.parse(result.stdout.toString()) as Array<{ files?: Array<{ path: string }> }>
const paths = payload[0]?.files?.map((file) => file.path).sort() ?? []
const exact = new Set(["package.json", "README.md", "LICENSE"])
const allowed = (path: string) => exact.has(path) || path.startsWith("dist/") || path.startsWith("defaults/")
const unexpected = paths.filter((path) => !allowed(path))
if (unexpected.length > 0) throw new Error(`Unexpected npm package files: ${unexpected.join(", ")}`)
for (const required of ["dist/index.js", "dist/cli.js", "package.json", "README.md", "LICENSE"]) {
  if (!paths.includes(required)) throw new Error(`Required npm package file is missing: ${required}`)
}
console.log(`Verified ${paths.length} npm package files`)
