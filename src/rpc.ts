import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { actionSchema, stateSchema } from "./model"

export const Inbox = Rpc.define({
  id: "opencode-inbox",
  methods: {
    snapshot: { input: z.object({}), output: stateSchema },
    act: { input: actionSchema, output: stateSchema },
  },
  events: { changed: { schema: z.object({ revision: z.number() }) } },
})
