import { expect, test } from "bun:test"
import { actionErrorText, errorDetails, errorText, isTransportError } from "../src/error-text"

/** The host client's transport failure, shaped as OpenCode 2.2.5's `ClientError`. */
function transportError(code = "ECONNRESET") {
  const cause = new TypeError(`${code}: The socket connection was closed unexpectedly`)
  return Object.assign(new Error(`Transport: ${cause.message}`, { cause }), {
    name: "ClientError",
    reason: "Transport",
  })
}

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

test("a lost connection is recognized by the client error's reason, not its message", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) {
    expect(isTransportError(transportError(code))).toBe(true)
    // A refresh keeps the full message for the details dialog; a change says it did not happen.
    expect(errorText(transportError(code))).toBe(
      `Transport: ${code}: The socket connection was closed unexpectedly`,
    )
    expect(actionErrorText(transportError(code))).toBe("Not saved: no connection to the server")
  }
  const others: unknown[] = [
    new Error("Transport: ECONNRESET: lookalike message"),
    Object.assign(new Error("UnexpectedStatus: 500"), { name: "ClientError", reason: "UnexpectedStatus" }),
    { type: "rpc.internal", message: "RPC call failed" },
    { type: "rpc.unavailable", message: "RPC is unavailable: opencode-switchboard" },
    "Transport",
    null,
    undefined,
  ]
  for (const cause of others) {
    expect(isTransportError(cause)).toBe(false)
    expect(actionErrorText(cause)).toBe(errorText(cause))
  }
})
