import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outdir = join(root, "dist")
rmSync(outdir, { recursive: true, force: true })

const runtime = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir,
  target: "bun",
  format: "esm",
  external: ["@opencode/plugin"],
})
if (!runtime.success) throw new AggregateError(runtime.logs, "Failed to build the Gvozd plugin")

const cli = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  outdir,
  target: "node",
  format: "esm",
  naming: "cli.js",
})
if (!cli.success) throw new AggregateError(cli.logs, "Failed to build the Gvozd CLI")

const cliPath = join(outdir, "cli.js")
if (!existsSync(cliPath)) throw new Error("CLI build did not produce dist/cli.js")
const source = readFileSync(cliPath, "utf8")
if (!source.startsWith("#!/usr/bin/env node\n")) writeFileSync(cliPath, `#!/usr/bin/env node\n${source}`)
chmodSync(cliPath, 0o755)
