/**
 * Shared request plumbing for the /api/agent/* routes (SPEC 8.3): JSON body
 * reading, UUID validation, and the JSON error shape. Kept together so the
 * error contract stays uniform: `{"error": message}` with the same status
 * codes the login and keepalive routes use (401 unauthorized, 400 bad
 * request, 404 not found).
 */

/** Response with the API-wide error shape. */
export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/**
 * The request body as a JSON object, or null when the body is absent,
 * malformed JSON, or not an object. The routes answer 400 in that case.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Track ids are UUIDs; validating before the query turns a bad id into a 400 instead of a database cast error. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
