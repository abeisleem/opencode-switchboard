import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { actionSchema, stateSchema } from "./model"

/** The fields of a root session that a panel row uses; see `loadCatalog`. */
export const catalogSessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  projectID: z.string(),
  directory: z.string(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
  idle: z.number().optional(),
  viewed: z.number().optional(),
  archived: z.number().optional(),
})
export type CatalogSession = z.infer<typeof catalogSessionSchema>

export const Switchboard = Rpc.define({
  id: "opencode-switchboard",
  methods: {
    snapshot: { input: z.object({}), output: stateSchema },
    act: { input: actionSchema, output: stateSchema },
    /**
     * Since 0.2.2; an older server part answers `rpc.method_not_found`. Reads sessions in-process, in one request:
     * `sessions` returns the requested IDs that name root sessions, and lists the others as `missing` (deleted,
     * never created, or a subagent). `roots` maps each ID in the input's `roots` to its root session's ID, and
     * leaves out an ID whose session or parent chain no longer exists.
     */
    catalog: {
      input: z.object({ sessions: z.array(z.string()), roots: z.array(z.string()).default([]) }),
      output: z.object({
        sessions: z.array(catalogSessionSchema),
        missing: z.array(z.string()),
        roots: z.record(z.string(), z.string()),
      }),
    },
  },
  events: { changed: { schema: z.object({ revision: z.number() }) } },
})
