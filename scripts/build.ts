import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const distdir = join(root, "dist")
// Build into a staging directory and swap files in one by one. OpenCode watches
// dist/index.js and dist/tui.js; deleting dist first makes a running host fail
// to load the plugin (ENOENT) and drop the whole agent team until restart.
const outdir = join(root, ".dist-build")
rmSync(outdir, { recursive: true, force: true })

const runtime = await Bun.build({
  entrypoints: [join(root, "src", "plugin", "index.ts")],
  outdir,
  target: "bun",
  format: "esm",
  external: ["@opencode/plugin"],
})
if (!runtime.success) throw new AggregateError(runtime.logs, "Failed to build the Gvozd plugin")

const tui = await Bun.build({
  entrypoints: [join(root, "src", "tui", "index.tsx")],
  outdir,
  target: "bun",
  format: "esm",
  naming: "tui.js",
  // JSX and the plugin TUI context resolve at runtime inside OpenCode, so the
  // published artifact must reference the host's copies.
  external: ["@opencode/plugin", "@opencode/client", "@opentui/core", "@opentui/solid", "solid-js"],
})
if (!tui.success) throw new AggregateError(tui.logs, "Failed to build the Gvozd TUI plugin")

const cli = await Bun.build({
  entrypoints: [join(root, "src", "cli", "index.ts")],
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

mkdirSync(distdir, { recursive: true })
const built = readdirSync(outdir)
for (const name of built) renameSync(join(outdir, name), join(distdir, name))
for (const name of readdirSync(distdir)) {
  if (!built.includes(name)) rmSync(join(distdir, name), { recursive: true, force: true })
}
rmSync(outdir, { recursive: true, force: true })
