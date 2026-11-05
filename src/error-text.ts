/**
 * Failures that deserve their own wording, tried in order before the generic rules: `text` replaces the error in
 * the footer, and the details dialog adds `hint` below it. Add an entry for each failure the panel should explain.
 */
const known: { matches: (cause: unknown) => boolean; text: string; hint?: string }[] = [
  {
    // The host's RPC client returns this when the plugin's server part is not loaded, e.g. after it failed to load.
    matches: (cause) => field(cause, "type") === "rpc.unavailable",
    text: "Switchboard server part not loaded",
    hint:
      "The panel cannot read or save its state without the switchboard's server part. Check the OpenCode server " +
      'log for "failed to load plugin", fix the cause, and restart the OpenCode server.',
  },
]

function field(cause: unknown, key: string): unknown {
  return typeof cause === "object" && cause !== null && key in cause
    ? (cause as Record<string, unknown>)[key]
    : undefined
}

/**
 * Whether a request failed because this TUI could not reach the OpenCode server: the connection was reset,
 * refused, or timed out. The host's client rejects with a `ClientError` whose `reason` is "Transport"; its message
 * and `cause` carry the code (ECONNRESET, ECONNREFUSED, ETIMEDOUT).
 */
export function isTransportError(cause: unknown) {
  return field(cause, "reason") === "Transport"
}

/** The muted footer line while refreshes fail for lack of a connection, a condition that fixes itself. */
export const RECONNECTING = "Reconnecting…"

/** Text for a failed change: as `errorText`, but a lost connection says the change did not happen. */
export function actionErrorText(cause: unknown) {
  return isTransportError(cause) ? "Not saved: no connection to the server" : errorText(cause)
}

/** JSON for an object, writing repeated references and bigints out instead of throwing. */
function json(value: object) {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`
    if (typeof item !== "object" || item === null) return item
    if (seen.has(item)) return "[Circular]"
    seen.add(item)
    return item
  })
}

/**
 * Readable text for anything thrown or rejected, never "[object Object]". RPC failures arrive as plain
 * `{ type, message }` objects, not `Error`s.
 */
export function errorText(cause: unknown): string {
  const match = known.find((entry) => entry.matches(cause))
  if (match) return match.text
  let text: string | undefined
  if (cause instanceof Error) text = cause.message || cause.name
  else if (typeof cause === "object" && cause !== null) {
    const message = field(cause, "message")
    const type = field(cause, "type")
    if (typeof message === "string") text = typeof type === "string" ? `${type}: ${message}` : message
    else {
      try {
        text = json(cause)
      } catch {}
      text ??= String(cause)
    }
  } else text = String(cause)
  return text || "Unknown error"
}

/** The details dialog's text: each distinct message once, followed by its hint when it has one. */
export function errorDetails(messages: readonly string[]): string {
  return [...new Set(messages.filter(Boolean))]
    .map((message) => {
      const hint = known.find((entry) => entry.text === message)?.hint
      return hint ? `${message}\n${hint}` : message
    })
    .join("\n\n")
}
