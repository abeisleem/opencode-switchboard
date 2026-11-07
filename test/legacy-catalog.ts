/** The catalog method's answer from a server part older than 0.2.2, which lacks it: OpenCode's RPC error. */
export async function legacyCatalog(): Promise<never> {
  throw { type: "rpc.method_not_found", message: "Unknown RPC method: opencode-switchboard.catalog" }
}
