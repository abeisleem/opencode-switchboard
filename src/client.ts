import { z } from "zod"

/**
 * Per-TUI client state: how this TUI shows the shared switchboard. It never reaches the server.
 *
 * While a TUI runs, its client state lives in memory. A change is also saved with `ctx.storage.store`, only as
 * the default for the next start. That store is a file on the TUI's machine, live-synced across every TUI there,
 * so a TUI reads it once, at startup, and ignores later updates from the others.
 *
 * TUIs of different releases on one machine share the saved default, so reading it must never fail:
 * - Every field has a default, and an unknown value falls back to it. Adding a view, or a new field with a
 *   default, needs no migration.
 * - Changing what an existing field means needs a new field name instead; the old one is then ignored.
 * - Unknown keys are ignored, so an older release reads a newer release's default.
 * - `version` is for a breaking change that cannot follow these rules. Bump it only then: a release reading a
 *   version it does not know uses the defaults.
 */

/** The panel's views. Only "projects" exists so far; #53 adds others. */
export const views = ["projects"] as const
export type View = (typeof views)[number]

export const clientStateSchema = z.object({
  version: z.literal(1).default(1),
  // A view this release does not know, e.g. one saved by a newer release, falls back to "projects".
  view: z.enum(views).catch("projects"),
})
export type ClientState = z.infer<typeof clientStateSchema>

export function defaultClientState(): ClientState {
  return { version: 1, view: "projects" }
}

/** Reads a saved client state. It never throws: a missing or corrupt value yields the defaults. */
export function readClientState(value: unknown): ClientState {
  const result = clientStateSchema.safeParse(value)
  return result.success ? result.data : defaultClientState()
}

/** The parts of the TUI plugin's `ctx.storage` that client state uses. */
type ClientStorage = {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  memory<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

/**
 * This TUI's client state. The saved default seeds the memory entry when this TUI first creates it; a plugin
 * reload keeps the live state, and later saves by other TUIs on this machine never reach it.
 */
export function createClientState(storage: ClientStorage) {
  const [saved, save] = storage.store<Record<string, unknown>>("client", { initial: {} })
  const [live, update] = storage.memory("client", { initial: { state: readClientState(saved) } })
  return {
    /** The live client state, in memory. */
    get state(): ClientState {
      return live.state
    },
    /** Changes this TUI's view and saves it as the default for the next start. Views arrive with #53. */
    async setView(view: View) {
      if (live.state.view === view) return
      update((draft) => {
        draft.state = { ...draft.state, view }
      })
      // Edit the saved draft in place, so keys a newer release wrote stay.
      await save((draft) => {
        draft.version = 1
        draft.view = view
      })
    },
  }
}
