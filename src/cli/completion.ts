// Shell tab-completion for `gvozd`, generated from the command registry
// (`src/cli/command-registry.ts`). Minimal templates, no wrapper functions:
// each emitter prints one script driven by the same command/flag/value data,
// and `suggestCompletion` emulates a Tab press for tests and smoke checks.

import { COMMANDS, GLOBAL_FLAGS, findCommand } from "./command-registry"

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const

export type CompletionShell = (typeof COMPLETION_SHELLS)[number]

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value)
}

function quoteList(values: readonly string[]): string {
  return values.join(" ")
}

function commandFlags(name: string): string[] {
  const command = findCommand(name)
  const flags = [...(command?.flags.map((flag) => flag.name) ?? []), ...GLOBAL_FLAGS.map((flag) => flag.name)]
  return [...new Set(flags)].sort()
}

/** Emulate one Tab press: `words` are the argv after `gvozd`, last is partial. */
export function suggestCompletion(words: readonly string[]): string[] {
  const commandNames = COMMANDS.map((command) => command.name)
  if (words.length <= 1) {
    const prefix = words[0] ?? ""
    if (prefix.startsWith("-")) return [...allKnownFlags()].filter((flag) => flag.startsWith(prefix)).sort()
    return commandNames.filter((name) => name.startsWith(prefix)).sort()
  }
  const [commandName, ...rest] = words
  const command = findCommand(commandName!)
  if (!command) return []
  const partial = rest[rest.length - 1] ?? ""
  const before = rest.slice(0, -1)
  if (partial.startsWith("--")) {
    const eq = partial.indexOf("=")
    if (eq !== -1) {
      const flag = command.flags.find((candidate) => candidate.name === partial.slice(0, eq))
      if (flag?.takesValue && flag.values) {
        return flag.values.filter((value) => value.startsWith(partial.slice(eq + 1))).sort()
      }
      return []
    }
    return availableFlags(commandName!, before).filter((flag) => flag.startsWith(partial)).sort()
  }
  if (partial.startsWith("-")) {
    return availableFlags(commandName!, before).filter((flag) => flag.startsWith(partial)).sort()
  }
  const prev = before[before.length - 1]
  const prevFlag = command.flags.find((flag) => flag.name === prev)
  if (prevFlag?.takesValue && prevFlag.values) {
    return prevFlag.values.filter((value) => value.startsWith(partial)).sort()
  }
  const positionals = positionalArgs(commandName!, before)
  if (positionals.length === 0 && command.subcommands) {
    return command.subcommands.filter((sub) => sub.startsWith(partial)).sort()
  }
  return []
}

function allKnownFlags(): Set<string> {
  const names = new Set<string>(GLOBAL_FLAGS.map((flag) => flag.name))
  for (const command of COMMANDS) {
    for (const flag of command.flags) names.add(flag.name)
  }
  return names
}

function availableFlags(commandName: string, before: readonly string[]): string[] {
  const command = findCommand(commandName)
  if (!command) return []
  let flags = [...command.flags]
  // Goal measure/verify flags are start-only user input (see parseGoalArgs):
  // hide them once the action is known to be status or stop.
  if (commandName === "goal") {
    const action = positionalArgs(commandName, before)[0]
    if (action !== undefined && action !== "start") flags = flags.filter((flag) => !flag.startOnly)
  }
  return [...new Set([...flags.map((flag) => flag.name), ...GLOBAL_FLAGS.map((flag) => flag.name)])]
}

/** Non-flag tokens before the cursor, skipping values of takesValue flags. */
function positionalArgs(commandName: string, before: readonly string[]): string[] {
  const command = findCommand(commandName)
  const positionals: string[] = []
  let skipNext = false
  for (const token of before) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (token.startsWith("-")) {
      const eq = token.indexOf("=")
      const flag = command?.flags.find((candidate) => candidate.name === (eq === -1 ? token : token.slice(0, eq)))
      if (flag?.takesValue && eq === -1) skipNext = true
      continue
    }
    positionals.push(token)
  }
  return positionals
}

function valueFlagsOf(name: string): { name: string; values: readonly string[] }[] {
  return (findCommand(name)?.flags ?? []).filter((flag) => flag.takesValue && flag.values).map((flag) => ({ name: flag.name, values: flag.values! }))
}

export function renderBashCompletion(): string {
  const commands = COMMANDS.map((command) => command.name).join(" ")
  const arms = COMMANDS.map((command) => {
    const flags = commandFlags(command.name).join(" ")
    const lines = [`    ${command.name})`, `      local flags="${flags}"`]
    for (const flag of valueFlagsOf(command.name)) {
      lines.push(`      if [[ "$cur" == ${flag.name}=* ]]; then`)
      lines.push(`        COMPREPLY=($(compgen -W "${quoteList(flag.values)}" -- "\${cur#${flag.name}=}"))`)
      lines.push(`        return 0`)
      lines.push(`      fi`)
    }
    const valueCases = valueFlagsOf(command.name)
    if (valueCases.length > 0) {
      lines.push(`      case "$prev" in`)
      for (const flag of valueCases) {
        lines.push(`        ${flag.name}) COMPREPLY=($(compgen -W "${quoteList(flag.values)}" -- "$cur")); return 0 ;;`)
      }
      lines.push(`      esac`)
    }
    if (command.subcommands) {
      lines.push(`      if [[ $COMP_CWORD -eq 2 && "$cur" != -* ]]; then`)
      lines.push(`        COMPREPLY=($(compgen -W "${quoteList(command.subcommands)}" -- "$cur"))`)
      lines.push(`        return 0`)
      lines.push(`      fi`)
    }
    lines.push(`      COMPREPLY=($(compgen -W "$flags" -- "$cur"))`)
    lines.push(`      return 0`)
    lines.push(`      ;;`)
    return lines.join("\n")
  }).join("\n")
  return [
    `_gvozd() {`,
    `  local cur prev cmd`,
    `  cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    `  if [[ $COMP_CWORD -eq 1 ]]; then`,
    `    COMPREPLY=($(compgen -W "${commands}" -- "$cur"))`,
    `    return 0`,
    `  fi`,
    `  cmd="\${COMP_WORDS[1]}"`,
    `  case "$cmd" in`,
    arms,
    `  esac`,
    `}`,
    `complete -F _gvozd gvozd`,
  ].join("\n")
}

export function renderZshCompletion(): string {
  const commands = COMMANDS.map((command) => `${command.name}:${command.helpLines[0]?.trim().slice(0, 60) ?? command.name}`).join(" ")
  const arms = COMMANDS.map((command) => {
    const flags = command.flags.map((flag) => (flag.takesValue && flag.values ? `'${flag.name}=[${flag.description}]:value:(${quoteList(flag.values)})'` : `'${flag.name}[${flag.description}]'`)).join(" ")
    const subs = command.subcommands ? ` _describe 'subcommand' '(${quoteList(command.subcommands)})'` : ""
    return `    ${command.name}) _arguments ${flags} '*: :->args'${subs} ;;`
  }).join("\n")
  return [
    `#compdef gvozd`,
    `_gvozd() {`,
    `  local context state line`,
    `  if (( CURRENT == 2 )); then`,
    `    _describe 'command' '(${commands})'`,
    `    return`,
    `  fi`,
    `  case "$words[2]" in`,
    arms,
    `  esac`,
    `}`,
    `_gvozd "$@"`,
  ].join("\n")
}

export function renderFishCompletion(): string {
  const lines = [`complete -c gvozd -n '__fish_use_subcommand' -f -a "${COMMANDS.map((c) => c.name).join(" ")}"`]
  for (const command of COMMANDS) {
    const seen = `__fish_seen_subcommand_from ${command.name}`
    for (const flag of command.flags) {
      const values = flag.takesValue && flag.values ? ` -x -a "${quoteList(flag.values)}"` : flag.takesValue ? " -x" : ""
      lines.push(`complete -c gvozd -n '${seen}' -f -l "${flag.name.slice(2)}" -d "${flag.description}"${values}`)
    }
    if (command.subcommands) {
      lines.push(`complete -c gvozd -n '${seen}' -f -a "${quoteList(command.subcommands)}"`)
    }
  }
  return lines.join("\n")
}

export function renderCompletion(shell: CompletionShell): string {
  if (shell === "bash") return renderBashCompletion()
  if (shell === "zsh") return renderZshCompletion()
  return renderFishCompletion()
}
