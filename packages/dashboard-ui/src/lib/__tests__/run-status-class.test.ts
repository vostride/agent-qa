import { describe, expect, it } from "vitest"

const SERVER_CLASSES: Array<[string, string]> = [
  ["pending", "live"],
  ["running", "live"],
  ["passed", "pass"],
  ["healed", "pass"],
  ["failed", "fail"],
  ["timeout", "fail"],
  ["cancelled", "cancelled"],
]

describe("run status classes", () => {
  it("the UI classifier sorts the seven words as the server does", async () => {
    const status = (await import("@/lib/status")) as Record<string, unknown>
    expect(typeof status.runStatusClass, "lib/status exports runStatusClass").toBe("function")
    const runStatusClass = status.runStatusClass as (word: string) => string | undefined

    expect(SERVER_CLASSES.map(([word]) => [word, runStatusClass(word)])).toEqual(SERVER_CLASSES)
    for (const retired of ["flaky", "skipped", "queued", "completed", ""]) {
      expect(runStatusClass(retired), `"${retired}" has no run class`).toBeUndefined()
    }
  })
})
