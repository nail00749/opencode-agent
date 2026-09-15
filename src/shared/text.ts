const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Truncates `value` to at most `maxBytes` without splitting a UTF-8 tail loose. */
export function boundedOutput(value: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8")
}

/** Accumulates a stream chunk into `current` while the byte budget allows. */
export function appendBounded(current: string, chunk: Buffer, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  const used = Buffer.byteLength(current)
  if (used >= maxBytes) return current
  const remaining = maxBytes - used
  return current + chunk.subarray(0, remaining).toString("utf8")
}

/** Splits command output into trimmed, nonempty lines (CRLF safe). */
export function outputLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}