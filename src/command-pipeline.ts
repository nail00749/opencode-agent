/**
 * Splits a compound shell command line into top-level segments for
 * permission dry-running. Understands the common separators agents emit
 * (`;`, `&&`, `||`, `|`, newlines) while ignoring separators inside quotes.
 * Environment assignments before a command (`FOO=1 git diff`) stay part of
 * the segment so resource matching can apply env-prefix rules.
 *
 * This is intentionally not a complete shell parser. It tracks quoting,
 * heredoc bodies, and command-substitution boundaries so separators inside
 * those constructs do not become misleading top-level dry-run rows.
 */
export function splitCommandPipeline(input: string): string[] {
  const segments: string[] = []
  let current = ""
  let escaped = false
  type Quote = "\"" | "'"
  interface SubstitutionContext {
    closer?: ")" | "`"
    quote?: Quote
    parenDepth: number
  }
  // Each substitution has its own quote state. This matters for constructs
  // such as `"$(printf '%s' value)"`, where the outer double quote remains
  // open while quotes inside the substitution are parsed independently.
  const contexts: SubstitutionContext[] = [{ parenDepth: 0 }]
  // Heredoc state: once started, everything until the closing marker line is
  // one segment; separators inside a heredoc body are literal text.
  let heredoc: { marker: string; stripTabs: boolean } | undefined

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ""
  }

  const at = (index: number): string => input[index] ?? ""

  for (let index = 0; index < input.length; index++) {
    const character = input[index]

    // Inside a heredoc body only the marker line terminates it.
    if (heredoc) {
      if (character === "\n") {
        const line = current.slice(current.lastIndexOf("\n") + 1).replace(/\r$/, "")
        const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line
        if (candidate === heredoc.marker) {
          heredoc = undefined
          current += character
          flush()
          continue
        }
      }
      current += character
      continue
    }

    const context = contexts[contexts.length - 1]!
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && context.quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (context.quote === character) context.quote = undefined
      else if (!context.quote) context.quote = character
      current += character
      continue
    }
    if (context.quote === "'") {
      current += character
      continue
    }

    if (character === "$" && at(index + 1) === "(") {
      contexts.push({ closer: ")", parenDepth: 0 })
      current += "$("
      index++
      continue
    }
    if (character === "`") {
      if (context.closer === "`") contexts.pop()
      else contexts.push({ closer: "`", parenDepth: 0 })
      current += character
      continue
    }
    if (context.closer === ")" && character === "(") {
      context.parenDepth++
      current += character
      continue
    }
    if (context.closer === ")" && character === ")") {
      if (context.parenDepth > 0) context.parenDepth--
      else contexts.pop()
      current += character
      continue
    }
    if (contexts.length > 1 || context.quote) {
      current += character
      continue
    }

    // Heredocs use `<<` or `<<-`; `<<<` is a here-string and has no marker.
    if (character === "<" && at(index - 1) !== "<" && at(index + 1) === "<" && at(index + 2) !== "<") {
      let cursor = index + 2
      const stripTabs = input[cursor] === "-"
      if (stripTabs) cursor++
      let marker = ""
      while (cursor < input.length && /[ \t]/.test(input[cursor]!)) cursor++
      if (input[cursor] === '"' || input[cursor] === "'") {
        const closeQuote = input[cursor]!
        cursor++
        while (cursor < input.length && input[cursor] !== closeQuote) marker += input[cursor++]
        if (input[cursor] === closeQuote) cursor++
      } else {
        while (cursor < input.length && !/[\s;|&<>()]/.test(input[cursor]!)) marker += input[cursor++]
      }
      if (marker) {
        heredoc = { marker, stripTabs }
        current += input.slice(index, cursor)
        index = cursor - 1
        continue
      }
    }
    if (character === ";" || character === "\n") {
      flush()
      continue
    }
    if (character === "&" || character === "|") {
      flush()
      if (input[index + 1] === character) index++
      continue
    }
    current += character
  }
  flush()
  return segments
}
