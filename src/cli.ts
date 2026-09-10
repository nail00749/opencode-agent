#!/usr/bin/env bun

import { loadConfig } from "./config"
import { formatSyncResult, syncAgents } from "./sync"

function usage(): never {
  console.error("Usage: agent-gvozd sync [directory] [--check]")
  process.exit(2)
}

const args = process.argv.slice(2)
const command = args.shift()
if (command !== "sync") usage()

const check = args.includes("--check")
const positional = args.filter((arg) => !arg.startsWith("--"))
if (positional.length > 1) usage()
const directory = positional[0] ?? process.cwd()
const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--check")
if (unknown.length > 0) usage()

try {
  const config = loadConfig(directory)
  const result = syncAgents(config, {
    check,
    onDiff: (diff) => console.log(`${diff}\n`),
  })
  console.log(formatSyncResult(result, check))
  if (check && result.created.length + result.updated.length + result.removed.length > 0) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
