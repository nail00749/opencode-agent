import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/core/config"
import { syncAgents } from "../src/core/sync"

const projectRoot = fileURLToPath(new URL("..", import.meta.url))
const configRoot = mkdtempSync(join(tmpdir(), "agent-gvozd-sync-verify-"))

try {
  const result = syncAgents(loadConfig(projectRoot, { configRoot }), { check: true })
  const drift = result.created.length + result.updated.length + result.removed.length
  if (drift > 0) {
    console.error(
      `Sync drift: ${result.created.length} created, ${result.updated.length} updated, ${result.removed.length} removed`,
    )
    process.exitCode = 1
  } else {
    console.log(`Verified ${result.unchanged.length} generated files are in sync`)
  }
} catch (error) {
  console.error(`Sync verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rmSync(configRoot, { recursive: true, force: true })
}
