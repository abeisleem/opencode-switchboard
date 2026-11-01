import type { Row, State } from "./model"

/**
 * The sessions this TUI has shown, newest first, kept in TUI memory: each TUI has its own current session, and
 * the server never learns it. `current` is the conversation this TUI shows, or showed last before going home.
 */
export type SessionHistory = { current: string | null; recent: string[] }

export function createSessionHistory(): SessionHistory {
  return { current: null, recent: [] }
}

/** Records a session this TUI shows. History is bounded; an open session can outlive its entry. */
export function recordShown(history: SessionHistory, id: string) {
  history.current = id
  history.recent = [id, ...history.recent.filter((item) => item !== id)].slice(0, 50)
}

/**
 * Where this TUI goes after its current session's row closes: the most recent session still open, else the
 * first open one, else nowhere (home).
 */
export function fallbackSession(state: State, recent: string[], closed: string) {
  const open = new Set(
    Object.values(state.projects)
      .filter((project) => project.open)
      .flatMap((project) => project.sessions),
  )
  open.delete(closed)
  return recent.find((id) => open.has(id)) ?? open.values().next().value ?? null
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
