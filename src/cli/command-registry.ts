// Single source of truth for the `gvozd` command surface: every command,
// flag, value enum, and first-positional choice the CLI parses (see
// `src/cli/index.ts` and `parseGoalArgs` in `src/cli/goal.ts`). HELP text,
// shell completion emitters, and the parity tests all derive from this
// registry, so adding a flag to a parser without registering it here fails
// the parity test instead of silently shipping without completion.

import { MODEL_PRESET_IDS, MODEL_PRESET_NAMES, SETUP_PRESET_IDS, SETUP_PRESET_NAMES } from "../core/setup-presets"

export interface CliFlagDefinition {
  /** Long flag spelling, for example `--preset`. */
  readonly name: string
  /** True when the flag consumes a following value (or an `=`-form). */
  readonly takesValue: boolean
  /** Closed value set offered by Tab completion; absent means free-form. */
  readonly values?: readonly string[]
  readonly description: string
  /** True when the flag is valid only for one subcommand (goal start). */
  readonly startOnly?: boolean
}

export interface CliCommandDefinition {
  readonly name: string
  /** Verbatim HELP lines rendered under `Commands:` for this command. */
  readonly helpLines: readonly string[]
  readonly flags: readonly CliFlagDefinition[]
  /** First-positional choices (subcommands), when the position is closed. */
  readonly subcommands?: readonly string[]
}

export const GLOBAL_FLAGS: readonly CliFlagDefinition[] = [
  { name: "--help", takesValue: false, description: "Show this help" },
  { name: "--version", takesValue: false, description: "Show the Gvozd version" },
]

const YES_FLAG: CliFlagDefinition = { name: "--yes", takesValue: false, description: "Skip confirmations" }

const MODEL_PRESET_FLAG: CliFlagDefinition = {
  name: "--preset",
  takesValue: true,
  values: MODEL_PRESET_IDS,
  description: `Model profile (${MODEL_PRESET_NAMES})`,
}

const JEV_PRESET_FLAG: CliFlagDefinition = {
  name: "--jev-preset",
  takesValue: true,
  values: SETUP_PRESET_IDS,
  description: `Jev question flow (${SETUP_PRESET_NAMES})`,
}

export const COMMANDS: readonly CliCommandDefinition[] = [
  {
    name: "setup",
    helpLines: [`  setup [--yes] [--preset ${MODEL_PRESET_NAMES}] [--jev-preset ${SETUP_PRESET_NAMES}]    Install or upgrade the global agent team`],
    flags: [YES_FLAG, MODEL_PRESET_FLAG, JEV_PRESET_FLAG],
  },
  {
    name: "update",
    helpLines: ["  update [--check] Update the global CLI and registered plugin"],
    flags: [{ name: "--check", takesValue: false, description: "Read-only version check" }],
  },
  {
    name: "config",
    helpLines: [`  config [--yes] [--preset ${MODEL_PRESET_NAMES}] [--jev-preset ${SETUP_PRESET_NAMES}]   Configure model preferences`],
    flags: [YES_FLAG, MODEL_PRESET_FLAG, JEV_PRESET_FLAG],
  },
  {
    name: "doctor",
    helpLines: ["  doctor [--json]  Diagnose the global installation"],
    flags: [{ name: "--json", takesValue: false, description: "Machine-readable report" }],
  },
  {
    name: "sync",
    helpLines: [
      "  sync [--check] [--dev-plugin]  Maintain the project-local installation",
      "                   --dev-plugin also writes the local plugin entrypoint (dev repositories only)",
    ],
    flags: [
      { name: "--check", takesValue: false, description: "Report drift without changing files" },
      { name: "--dev-plugin", takesValue: false, description: "Write the local plugin entrypoint" },
    ],
  },
  {
    name: "agents",
    helpLines: [
      "  agents [list]    Show the resolved agent team",
      "  agents disable <id> | enable <id>  Toggle an agent in the global config",
    ],
    flags: [],
    subcommands: ["list", "disable", "enable"],
  },
  {
    name: "trust-project",
    helpLines: ["  trust-project [directory]  Print the current project trust token"],
    flags: [],
  },
  {
    name: "analyze",
    helpLines: [
      "  analyze <sessionID> [--json] [--stdout]  Export one OpenCode session",
      "                   (messages, tool calls, permission denials) as a Markdown",
      "                   report; --json writes JSON; --stdout prints instead of",
      "                   writing gvozd-<sessionID>.md into the current directory",
    ],
    flags: [
      { name: "--json", takesValue: false, description: "Machine-readable dump" },
      { name: "--stdout", takesValue: false, description: "Print instead of writing a file" },
    ],
  },
  {
    name: "init",
    helpLines: [
      "  init [directory] Scaffold the project layer (docs/.gvozd) and materialize",
      "                   .opencode/agents in-process; defaults to the current directory",
    ],
    flags: [],
  },
  {
    name: "goal",
    helpLines: [
      "  goal <start|status|stop> <sessionID> [goalId]  Start, inspect, or stop the family goal",
      "                   (scripted surface; live control lives in /gvozd-goal)",
    ],
    flags: [
      { name: "--measure", takesValue: true, description: "Measure command (start only)", startOnly: true },
      { name: "--verify", takesValue: true, description: "Verify command (start only)", startOnly: true },
    ],
    subcommands: ["start", "status", "stop"],
  },
  {
    name: "completion",
    helpLines: ["  completion <bash|zsh|fish>  Print shell tab-completion for gvozd"],
    flags: [],
    subcommands: ["bash", "zsh", "fish"],
  },
]

export function findCommand(name: string): CliCommandDefinition | undefined {
  return COMMANDS.find((command) => command.name === name)
}

/** Every `--flag` spelling the CLI accepts, including globals. */
export function allFlagNames(): Set<string> {
  const names = new Set<string>(GLOBAL_FLAGS.map((flag) => flag.name))
  for (const command of COMMANDS) {
    for (const flag of command.flags) names.add(flag.name)
  }
  return names
}

function formatHelpFlag(flag: CliFlagDefinition): string {
  const spelling = flag.takesValue ? `${flag.name} <value>` : flag.name
  const values = flag.values !== undefined ? ` (values: ${flag.values.join("|")})` : ""
  const scope = flag.startOnly === true && !flag.description.toLowerCase().includes("start only") ? " (start only)" : ""
  return `  ${spelling.padEnd(21)}${flag.description}${values}${scope}`
}

/**
 * Detailed help for one command: its usage line, the registry help lines,
 * subcommands when the first positional is closed, its flags (value-taking
 * flags render as `--flag <value>` with the closed value set when one
 * exists), and the global flags. Returns undefined for unknown names so the
 * caller can fall back to plain usage.
 */
export function renderCommandHelp(name: string): string | undefined {
  const command = findCommand(name)
  if (command === undefined) return undefined
  const [first, ...others] = command.helpLines
  if (first === undefined) return undefined
  const usage = first.trim().split(/\s{2,}/)[0]!.trim()
  const lines = [`Usage: gvozd ${usage}`, "", first, ...others]
  if (command.subcommands !== undefined) lines.push("", `Subcommands: ${command.subcommands.join(", ")}`)
  if (command.flags.length > 0) lines.push("", "Flags:", ...command.flags.map(formatHelpFlag))
  lines.push("", "Global flags:", ...GLOBAL_FLAGS.map(formatHelpFlag))
  return lines.join("\n")
}

export function buildHelp(): string {
  return [
    `Usage: gvozd <${COMMANDS.map((command) => command.name).join("|")}> [options]`,
    "",
    "Commands:",
    ...COMMANDS.flatMap((command) => command.helpLines),
    "",
    "Options:",
    ...GLOBAL_FLAGS.map((flag) => `  ${flag.name.padEnd(17)}${flag.description}`),
  ].join("\n")
}
