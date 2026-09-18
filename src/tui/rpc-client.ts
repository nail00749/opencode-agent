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
