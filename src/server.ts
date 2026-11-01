import { Plugin } from "@opencode/plugin"
import { Switchboard } from "./rpc"
import { createInboxStore } from "./store"
import { reduce, type Admission } from "./model"

export default Plugin.define({
  id: "opencode-switchboard",
  async setup(ctx) {
    const store = createInboxStore(ctx.storage, async (state, action) => {
      let admission: Admission | undefined
      // A new project starts empty; a saved one restores its own membership.
      if (action.type === "project-open")
        admission = { project: action.project, name: action.name, sessions: [] }
      // Removing a row also handles native deletion, after the session no longer exists.
      if ("sessionID" in action && action.type !== "session-remove") {
        const session = await ctx.session.get({ sessionID: action.sessionID })
        if (session.parentID) throw new Error("Switchboard actions require a root session")
        if (
          (action.type === "read" || action.type === "visit") &&
          action.observed > (session.time.idle ?? 0)
        ) {
          throw new Error("Cannot acknowledge a result that has not completed")
        }
        // Visiting or organizing a session lists it in its project, opening the project if needed.
        if (action.type === "visit" || action.type === "place") {
          const project = session.projectID === "global" ? session.location.directory : session.projectID
          admission = {
            project,
            name:
              state.projects[project]?.name ??
              session.location.directory.split("/").filter(Boolean).at(-1) ??
              project,
            sessions: [session.id],
          }
        }
      }
      return reduce(state, action, admission)
    })
    const registration = await ctx.rpc.register(Switchboard, {
      snapshot: () => store.snapshot(),
      act: async (action) => {
        const next = await store.act(action)
        await registration.events.emit("changed", { revision: next.revision })
        return next
      },
    })
  },
})
