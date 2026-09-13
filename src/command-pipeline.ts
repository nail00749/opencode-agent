/**
 * Splits a compound shell command line into top-level segments for
 * permission dry-running. Understands the common separators agents emit
 * (`;`, `&&`, `||`, `|`, newlines) while ignoring separators inside quotes.
 * Environment assignments before a command (`FOO=1 git diff`) stay part of
 * the segment so resource matching can apply env-prefix rules.
 */
export function splitCommandPipeline(input: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | undefined
  let escaped = false

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ""
  }

  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = undefined
      else if (!quote) quote = character
      current += character
      continue
    }
    if (quote) {
      current += character
      continue
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
