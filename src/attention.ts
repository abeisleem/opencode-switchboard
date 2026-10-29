export type Attention = {
  approvals: string[]
  questions: string[]
  unavailable?: "missing" | "stale"
  errors: string[]
}

type Requests = { data: { sessionID: string }[] }

// A failed read is unknown, not an empty queue. Preserve each last-good half
// independently so a permission failure cannot discard successful form data.
export async function readAttention(
  readPermissions: () => Promise<Requests>,
  readForms: () => Promise<Requests>,
  previous?: Attention,
): Promise<Attention> {
  const results = await Promise.allSettled([readPermissions(), readForms()])
  const next: Attention = {
    approvals: previous?.approvals ?? [],
    questions: previous?.questions ?? [],
    errors: [],
  }
  for (const [index, result] of results.entries()) {
    const key = index === 0 ? "approvals" : "questions"
    if (result.status === "fulfilled") {
      next[key] = result.value.data.map((request) => request.sessionID)
      continue
    }
    const error: unknown = result.reason
    const missing =
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "LocationNotFoundError"
    if (missing && next.unavailable !== "stale") next.unavailable = "missing"
    if (!missing) next.unavailable = "stale"
    next.errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return next
}
