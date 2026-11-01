import { initialState, reduce, type Action, type State } from "./model"
import { readState } from "./migrate"

export function createInboxStore(
  storage: { get(key: string): Promise<unknown>; set(key: string, value: State): Promise<void> },
  apply: (state: State, action: Action) => State | Promise<State> = reduce,
) {
  let queue: Promise<unknown> = Promise.resolve()
  async function snapshot() {
    const saved = await storage.get("inbox-v1")
    return saved === undefined ? initialState() : readState(saved)
  }
  function act(action: Action) {
    const result = queue.then(async () => {
      const current = await snapshot()
      const next = await apply(current, action)
      // An action that changes nothing (e.g. key repeat on a fold) returns the same state; skip the write.
      if (next !== current) await storage.set("inbox-v1", next)
      return next
    })
    queue = result.catch(() => {})
    return result
  }
  return { snapshot, act }
}
