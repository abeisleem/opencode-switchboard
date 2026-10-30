import type { Plugin } from "@opencode/plugin/tui"
import type { Row, State } from "./model"

type Router = Plugin.Context["ui"]["router"]

/**
 * Where this client must go to show the shared selection, or undefined when its
 * route already shows that conversation family. A subagent session therefore
 * stays open instead of bouncing to its root, and no no-op navigation is issued.
 */
export function followRoute(
  route: ReturnType<Router["current"]>,
  selected: string | null,
  root: (sessionID: string) => string,
): Parameters<Router["navigate"]>[0] | undefined {
  const here = route.type === "session" ? root(route.sessionID) : null
  if (here === selected) return
  return selected ? { type: "session", sessionID: selected } : { type: "home" }
}

/**
 * Whether a newly accepted shared state navigates this client. The first state a client accepts
 * only syncs it; following it would jump a freshly started TUI to the last selected session.
 */
export function navigated(synced: boolean, previous: State, next: State) {
  return synced && next.navigation !== previous.navigation
}

export type SelectionMemory = { items: Row[]; key: string; index: number; scrollTop: number; owner?: symbol }

export function createSelectionMemory(): SelectionMemory {
  return { items: [], key: "", index: 0, scrollTop: 0 }
}

export function rowKey(row: Row) {
  return row.kind === "heading" ? `heading:${row.key}` : `session:${row.session.id}`
}

/** Preserve identity when possible; when it disappears, use its surviving neighbors. */
export function reconcileSelection(previous: Row[], next: Row[], selected: string, fallback = 0) {
  if (!next.length) return -1
  const indices = new Map(next.map((row, index) => [rowKey(row), index]))
  const surviving = indices.get(selected)
  if (surviving !== undefined) return surviving

  const before = previous.findIndex((row) => rowKey(row) === selected)
  const removed = previous[before]
  if (removed) {
    const neighbors = [...previous.slice(before + 1), ...previous.slice(0, before).reverse()]
    if (removed.kind === "session") {
      // Group headings can disappear too (e.g. removing the only Focus item).
      // Match neighboring sessions, rather than blindly reusing the old row index.
      const sibling = neighbors.find(
        (row) =>
          row.kind === "session" &&
          row.session.project === removed.session.project &&
          indices.has(rowKey(row)),
      )
      if (sibling) return indices.get(rowKey(sibling))!
      const parent = indices.get(`heading:${removed.session.project}`)
      if (parent !== undefined) return parent
    }
    if (removed.kind === "heading" && removed.depth === 0) {
      const project = neighbors.find(
        (row) => row.kind === "heading" && row.depth === 0 && indices.has(rowKey(row)),
      )
      if (project) return indices.get(rowKey(project))!
    }
  }
  return Math.max(0, Math.min(next.length - 1, before >= 0 ? before : fallback))
}
