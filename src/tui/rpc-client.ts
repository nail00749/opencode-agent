/**
 * Calls a no-payload RPC with an explicit object. OpenCode 2.0.2 requires an
 * input schema while newer clients omit `undefined` from the request body;
 * sending `{}` works across the supported 2.0.x line.
 */
export function callNoPayloadRpc<Output>(
  method: (input: Record<string, never>) => Promise<Output>,
): Promise<Output> {
  return method({})
}

export interface RetryRpcOptions {
  attempts?: number
  delay?: (milliseconds: number) => Promise<void>
}

export async function retryRpc<Output>(
  operation: () => Promise<Output | undefined>,
  options: RetryRpcOptions = {},
): Promise<Output | undefined> {
  const attempts = Math.max(1, options.attempts ?? 6)
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const output = await operation()
      if (output !== undefined) return output
    } catch (error) {
      lastError = error
    }
    if (attempt + 1 < attempts) await delay(Math.min(200 * 2 ** attempt, 1_600))
  }
  if (lastError !== undefined) throw lastError
  return undefined
}
