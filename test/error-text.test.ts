import { expect, test } from "bun:test"
import { errorDetails, errorText } from "../src/error-text"

test("errorText reads RPC failures, errors, objects, and primitives without [object Object]", () => {
  const circular: Record<string, unknown> = { code: 7 }
  circular.self = circular
  const cases: [unknown, string][] = [
    [{ type: "rpc.internal", message: "RPC call failed" }, "rpc.internal: RPC call failed"],
    [{ message: "no type" }, "no type"],
    [new Error("boom"), "boom"],
    [new TypeError(""), "TypeError"],
    [{ code: 7 }, '{"code":7}'],
    [circular, '{"code":7,"self":"[Circular]"}'],
    [{ size: 10n }, '{"size":"10n"}'],
    ["plain text", "plain text"],
    [42, "42"],
    [null, "null"],
    [undefined, "undefined"],
    ["", "Unknown error"],
  ]
  for (const [cause, expected] of cases) {
    expect(errorText(cause)).toBe(expected)
    expect(errorText(cause)).not.toContain("[object Object]")
  }
})

test("errorText says the server part is not loaded for rpc.unavailable", () => {
  const unavailable = { type: "rpc.unavailable", message: "RPC is unavailable: opencode-switchboard" }
  expect(errorText(unavailable)).toBe("Switchboard server part not loaded")
  // The details dialog says where to look.
  expect(errorDetails([errorText(unavailable)])).toContain('"failed to load plugin"')
})

test("errorDetails shows each distinct message once", () => {
  expect(errorDetails(["rpc.internal: RPC call failed", "", "rpc.internal: RPC call failed", "other"])).toBe(
    "rpc.internal: RPC call failed\n\nother",
  )
  expect(errorDetails(["", ""])).toBe("")
})
