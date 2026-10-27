// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConfigChange } from "@vostride/agent-qa-schema"

import { ApiError, applyConfigChanges, fetchConfig, fetchConfigRevision, undoConfigAction } from "@/lib/api"
import { FIELD_CHANGED_TEXT, REVISION_POLL_MS, SETTLE_DELAY_MS, UNDO_WINDOW_MS, undoLine } from "@/lib/config-copy"
import {
  CONFIG_DRAFTS_STORAGE_PREFIX,
  externalDraftFieldKey,
  useConfigAutosave,
  type ConfigAutosave,
  type ConfigFieldParse,
  type ConfigFieldRef,
} from "@/hooks/use-config-autosave"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = "/work/agent-qa.config.yaml"
const STORAGE_KEY = `${CONFIG_DRAFTS_STORAGE_PREFIX}${CONFIG_PATH}`

function answer(config: Record<string, unknown>, revision = "rev-1") {
  return { config, provider: null, revision, file: { path: CONFIG_PATH, lines: [] } }
}

const baseConfig = {
  workspace: { envFile: ".env.local" },
  use: { timeout: { step: "30s", test: "10m" }, browser: { headless: true } },
  registry: {
    llms: [{ name: "primary", provider: "openai-compatible", model: "gpt-4.1" }],
  },
}

const headless: ConfigFieldRef = { segments: ["use", "browser", "headless"], tab: "execution" }
const step: ConfigFieldRef = { segments: ["use", "timeout", "step"], tab: "execution" }
const envFile: ConfigFieldRef = { segments: ["workspace", "envFile"], tab: "project" }
const testTimeout: ConfigFieldRef = { segments: ["use", "timeout", "test"], tab: "execution" }
const accessHeader: ConfigFieldRef = {
  segments: ["registry", "llms", { name: "primary" }, "providerHeaders", "x-access"],
  tab: "models",
}
const maxActions: ConfigFieldRef = { segments: ["use", "planner", "maxActions"], tab: "models" }
const previousStepCount: ConfigFieldRef = { segments: ["use", "planner", "previousStepCount"], tab: "models" }

const DURATION = /^\d+(ms|s|m|h)$/
function durationParse(raw: string): ConfigFieldParse {
  return DURATION.test(raw) ? { valid: true, value: raw } : { valid: false, error: "Use a duration like 30s or 2m." }
}
function textParse(raw: string): ConfigFieldParse {
  return { valid: true, value: raw }
}

let hook: ConfigAutosave | undefined
/** Every status a render showed, so a cell can say a state never appeared. */
let seenStatuses: string[] = []
function Harness() {
  hook = useConfigAutosave()
  seenStatuses.push(hook.status.state)
  return null
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Harness />)
  })
  await flush()
  return hook!
}

async function unmount() {
  if (root) {
    await act(async () => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  hook = undefined
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function run(action: (h: ConfigAutosave) => void) {
  await act(async () => {
    action(hook!)
  })
  await flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function writeCalls() {
  return vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])
}

function storedText(): string {
  const parts: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!
    parts.push(key, localStorage.getItem(key) ?? "")
  }
  return parts.join("\n")
}

let visibility: DocumentVisibilityState = "visible"

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
}

beforeEach(() => {
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  vi.useFakeTimers()
  localStorage.clear()
  seenStatuses = []
  vi.mocked(fetchConfig).mockResolvedValue(answer(baseConfig) as never)
  // One fake server: the revision route answers whatever the last write landed, and each write
  // names the revision it merged onto (429-37), so every cell here stays on the trusted path.
  let serverRevision = "rev-1"
  vi.mocked(fetchConfigRevision).mockImplementation(async () => ({ revision: serverRevision }))
  vi.mocked(applyConfigChanges).mockImplementation(async () => {
    const baseRevision = serverRevision
    serverRevision = "rev-2"
    return { baseRevision, revision: serverRevision }
  })
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe("useConfigAutosave settle, write, drafts and retry (429-16 Task 1)", () => {
  it("ONE-WRITE-PER-SETTLE: a toggle writes at once, typing writes once after the pause, a blur writes at once", async () => {
    await mount()
    expect(hook!.load.kind).toBe("ready")

    await run((h) => {
      h.edit(headless, false, { valid: true, value: false })
      h.settle(headless)
    })
    expect(writeCalls()).toEqual([[{ op: "set", path: ["use", "browser", "headless"], value: false }]])

    for (const raw of [".e", ".en", ".env"]) {
      await run((h) => h.edit(envFile, raw, textParse(raw)))
      await advance(SETTLE_DELAY_MS / 4)
    }
    await advance(SETTLE_DELAY_MS - SETTLE_DELAY_MS / 4 - 1)
    expect(writeCalls()).toHaveLength(1)
    await advance(1)
    expect(writeCalls()).toHaveLength(2)
    expect(writeCalls()[1]).toEqual([{ op: "set", path: ["workspace", "envFile"], value: ".env" }])

    await run((h) => {
      h.edit(step, "45s", durationParse("45s"))
      h.settle(step)
    })
    expect(writeCalls()).toHaveLength(3)
    expect(writeCalls()[2]).toEqual([{ op: "set", path: ["use", "timeout", "step"], value: "45s" }])

    await advance(SETTLE_DELAY_MS * 3)
    expect(writeCalls()).toHaveLength(3)
    expect(hook!.valueOf(step)).toBe("45s")
  })

  it("ONE-WRITE-PER-SETTLE: an unset edit sends one unset change for that leaf", async () => {
    await mount()
    await run((h) => {
      h.edit(envFile, "", { valid: true, unset: true })
      h.settle(envFile)
    })
    expect(writeCalls()).toEqual([[{ op: "unset", path: ["workspace", "envFile"] }]])
  })

  it("INVALID-STAYS-DRAFT-NO-WRITE: an unparseable duration writes nothing, reads Not saved, and survives a reload", async () => {
    await mount()
    await run((h) => h.edit(step, "30 seconds", durationParse("30 seconds")))
    await run((h) => h.settle(step))
    await advance(SETTLE_DELAY_MS * 3)

    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(hook!.status.state).toBe("draft")
    expect(hook!.stateOf(step)).toBe("draft")
    expect(hook!.errorOf(step)).toBe("Use a duration like 30s or 2m.")
    expect(hook!.valueOf(step)).toBe("30 seconds")
    expect([...hook!.draftTabs]).toEqual(["execution"])
    expect(localStorage.getItem(STORAGE_KEY)).toContain("30 seconds")

    await unmount()
    await mount()

    expect(hook!.load.kind).toBe("ready")
    expect(hook!.valueOf(step)).toBe("30 seconds")
    expect(hook!.stateOf(step)).toBe("draft")
    expect(hook!.status.state).toBe("draft")
    expect([...hook!.draftTabs]).toEqual(["execution"])
    expect(hook!.valueOf(headless)).toBe(true)
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it("INVALID-STAYS-DRAFT-NO-WRITE: a stored draft equal to the file's value, or off-shape, is dropped on load", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [JSON.stringify(step.segments)]: { segments: step.segments, tab: "execution", raw: "30s" },
        [JSON.stringify(envFile.segments)]: { segments: envFile.segments, tab: "nowhere", raw: ".x" },
        junk: 42,
      }),
    )
    await mount()
    expect(hook!.stateOf(step)).toBe("clean")
    expect(hook!.stateOf(envFile)).toBe("clean")
    expect(hook!.valueOf(envFile)).toBe(".env.local")
    expect(hook!.status.state).toBe("idle")
  })

  it("FORCED-FAILURE-KEEPS-DRAFT: a refused write reads Couldn't save, keeps the value with its reason, and Retry re-sends once", async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      new ApiError(422, "Unprocessable Entity", {
        error: "validation_failed",
        issues: [{ path: ["use", "timeout", "step"], message: "Step timeout must be at least 1s." }],
      }),
    )
    await mount()
    await run((h) => {
      h.edit(step, "0s", durationParse("0s"))
      h.settle(step)
    })

    expect(writeCalls()).toHaveLength(1)
    expect(hook!.status.state).toBe("failed")
    expect(hook!.status.failingFieldKeys).toEqual([JSON.stringify(step.segments)])
    expect(hook!.stateOf(step)).toBe("failed")
    expect(hook!.errorOf(step)).toBe("Step timeout must be at least 1s.")
    expect(hook!.valueOf(step)).toBe("0s")
    expect(localStorage.getItem(STORAGE_KEY)).toContain("0s")

    await advance(SETTLE_DELAY_MS * 5)
    expect(hook!.status.state).toBe("failed")
    expect(writeCalls()).toHaveLength(1)

    await run((h) => h.retry())
    expect(writeCalls()).toHaveLength(2)
    expect(writeCalls()[1]).toEqual([{ op: "set", path: ["use", "timeout", "step"], value: "0s" }])
    expect(hook!.status.state).toBe("saved")
    expect(hook!.stateOf(step)).toBe("clean")
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("FORCED-FAILURE-KEEPS-DRAFT: a network failure keeps every carried value as a draft", async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await mount()
    await run((h) => {
      h.edit(headless, false, { valid: true, value: false })
      h.settle(headless)
    })
    expect(hook!.status.state).toBe("failed")
    expect(hook!.stateOf(headless)).toBe("draft")
    expect(hook!.valueOf(headless)).toBe(false)
  })

  it("RETRY-WHILE-SAVING-NO-DOUBLE-WRITE: Retry during a write starts nothing; later settles join the next write", async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      new ApiError(422, "Unprocessable Entity", {
        error: "validation_failed",
        issues: [{ path: ["use", "timeout", "step"], message: "Step timeout must be at least 1s." }],
      }),
    )
    await mount()
    await run((h) => {
      h.edit(step, "0s", durationParse("0s"))
      h.settle(step)
    })
    expect(hook!.status.state).toBe("failed")

    const flight = deferred<{ revision: string }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(flight.promise)
    await run((h) => {
      h.edit(headless, false, { valid: true, value: false })
      h.settle(headless)
    })
    expect(writeCalls()).toHaveLength(2)
    expect(writeCalls()[1]).toEqual([{ op: "set", path: ["use", "browser", "headless"], value: false }])
    expect(hook!.stateOf(headless)).toBe("saving")

    await run((h) => h.retry())
    await run((h) => h.retry())
    await run((h) => {
      h.edit(envFile, ".env", textParse(".env"))
      h.settle(envFile)
    })
    await advance(SETTLE_DELAY_MS * 2)
    expect(writeCalls()).toHaveLength(2)

    await act(async () => {
      flight.resolve({ revision: "rev-2" })
    })
    await flush()

    expect(writeCalls()).toHaveLength(3)
    expect(writeCalls()[2]).toEqual(
      expect.arrayContaining([
        { op: "set", path: ["use", "timeout", "step"], value: "0s" },
        { op: "set", path: ["workspace", "envFile"], value: ".env" },
      ]),
    )
    expect(writeCalls()[2]).toHaveLength(2)
    await advance(SETTLE_DELAY_MS * 2)
    expect(writeCalls()).toHaveLength(3)
  })
})

const editedOutside = {
  ...baseConfig,
  use: { timeout: { step: "2m", test: "20m" }, browser: { headless: false } },
}

describe("useConfigAutosave outside edits, explicit actions and Undo (429-16 Task 2)", () => {
  it("OUTSIDE-EDIT-MERGES-QUIETLY: a revision the page did not write re-reads the config and shows the new value", async () => {
    await mount()
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-9" })
    vi.mocked(fetchConfig).mockResolvedValue(answer(editedOutside, "rev-9") as never)

    await advance(REVISION_POLL_MS)

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.valueOf(headless)).toBe(false)
    expect(hook!.valueOf(step)).toBe("2m")
    expect(hook!.status.state).toBe("idle")
    expect(hook!.load.kind).toBe("ready")

    await advance(REVISION_POLL_MS * 3)
    expect(fetchConfig).toHaveBeenCalledTimes(2)
  })

  it("OWN-WRITE-NO-REFETCH: a write whose base is the page's own revision, then polls answering its result, re-reads nothing", async () => {
    await mount()
    vi.mocked(applyConfigChanges).mockResolvedValue({ baseRevision: "rev-1", revision: "rev-2" })
    await run((h) => {
      h.edit(headless, false, { valid: true, value: false })
      h.settle(headless)
    })
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-2" })

    await advance(REVISION_POLL_MS * 3)

    expect(vi.mocked(fetchConfigRevision).mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(hook!.valueOf(headless)).toBe(false)
  })

  // 429-37 CR-01: the outside edit lands at rev-9 and the page writes before any poll tick; the
  // write's answer names rev-9 as its base, which the page never read.
  async function interleavedOutsideEdit() {
    await mount()
    const merged = {
      ...baseConfig,
      use: { ...baseConfig.use, browser: { headless: false }, planner: { maxActions: 99, previousStepCount: 77 } },
    }
    vi.mocked(applyConfigChanges).mockResolvedValue({ baseRevision: "rev-9", revision: "rev-10" })
    vi.mocked(fetchConfig).mockResolvedValue(answer(merged, "rev-10") as never)
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-10" })
    const statuses: string[] = []
    await run((h) => {
      h.edit(headless, false, { valid: true, value: false })
      h.settle(headless)
    })
    statuses.push(hook!.status.state)
    await flush()
    statuses.push(hook!.status.state)
    return statuses
  }

  it("OUTSIDE-EDIT-INTERLEAVED-REREAD: a write that merged an outside edit re-reads at once, with no poll", async () => {
    const statuses = await interleavedOutsideEdit()

    expect(fetchConfigRevision).not.toHaveBeenCalled()
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.valueOf(previousStepCount)).toBe(77)
    expect(hook!.valueOf(maxActions)).toBe(99)
    expect(hook!.valueOf(headless)).toBe(false)
    expect(statuses).not.toContain("failed")
    expect(hook!.status.state).not.toBe("failed")
  })

  it("INTERLEAVED-EDIT-KEEPS-OUTSIDE-SIBLING: after the re-read, one planner leaf sends only itself", async () => {
    await interleavedOutsideEdit()
    vi.mocked(applyConfigChanges).mockClear()
    vi.mocked(applyConfigChanges).mockResolvedValue({ baseRevision: "rev-10", revision: "rev-11" })

    await run((h) => {
      h.edit(maxActions, 50, { valid: true, value: 50 })
      h.settle(maxActions)
    })

    expect(writeCalls()).toEqual([[{ op: "set", path: ["use", "planner", "maxActions"], value: 50 }]])
    expect(JSON.stringify(writeCalls())).not.toContain("previousStepCount")
    expect(hook!.valueOf(previousStepCount)).toBe(77)
  })

  // Deferred 429-28: an unset through a parent the config lacks leaves nothing to remove there,
  // and the changes after it in the same set still show at once.
  it("MIRROR-CONTINUES-PAST-MISSING-PARENT: a landed set shows every change after an unset whose parent is absent", async () => {
    await mount()
    const workers: ConfigFieldRef = { segments: ["use", "workers"], tab: "execution" }

    let landed = false
    await act(async () => {
      landed = await hook!.runExplicit([
        { op: "unset", path: ["use", "logCapture", "console"] },
        { op: "set", path: ["use", "workers"], value: 3 },
      ])
    })
    await flush()

    expect(landed).toBe(true)
    expect(hook!.valueOf(workers)).toBe(3)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it("POLL-ONLY-WHEN-VISIBLE: a hidden page never polls; becoming visible or focused polls at once", async () => {
    setVisibility("hidden")
    await mount()
    await advance(REVISION_POLL_MS * 4)
    expect(fetchConfigRevision).not.toHaveBeenCalled()

    setVisibility("visible")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush()
    expect(fetchConfigRevision).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await flush()
    expect(fetchConfigRevision).toHaveBeenCalledTimes(2)

    await advance(REVISION_POLL_MS)
    expect(fetchConfigRevision).toHaveBeenCalledTimes(3)

    setVisibility("hidden")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await advance(REVISION_POLL_MS * 4)
    expect(fetchConfigRevision).toHaveBeenCalledTimes(3)

    await unmount()
    setVisibility("visible")
    await advance(REVISION_POLL_MS * 4)
    expect(fetchConfigRevision).toHaveBeenCalledTimes(3)
  })

  it("REFRESH-NEVER-CLOBBERS-FOCUSED: an outside re-read keeps the focused field and every draft", async () => {
    await mount()
    await run((h) => h.setFocusedField(testTimeout))
    await run((h) => h.edit(step, "soon", durationParse("soon")))
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-9" })
    vi.mocked(fetchConfig).mockResolvedValue(answer(editedOutside, "rev-9") as never)

    await advance(REVISION_POLL_MS)

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.valueOf(headless)).toBe(false)
    expect(hook!.valueOf(testTimeout)).toBe("10m")
    expect(hook!.valueOf(step)).toBe("soon")
    expect(hook!.stateOf(step)).toBe("draft")

    await run((h) => h.setFocusedField(undefined))
    expect(hook!.valueOf(testTimeout)).toBe("20m")
    expect(hook!.valueOf(step)).toBe("soon")
  })

  it("REFRESH-NEVER-CLOBBERS-FOCUSED: a focused field's settled value survives a re-read until focus leaves", async () => {
    await mount()
    await run((h) => h.setFocusedField(envFile))
    await run((h) => {
      h.edit(envFile, ".env.ci", textParse(".env.ci"))
      h.settle(envFile)
    })
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-9" })
    vi.mocked(fetchConfig).mockResolvedValue(
      answer({ ...editedOutside, workspace: { envFile: ".env.other" } }, "rev-9") as never,
    )
    await advance(REVISION_POLL_MS)

    expect(hook!.valueOf(envFile)).toBe(".env.ci")
    await run((h) => h.setFocusedField(undefined))
    expect(hook!.valueOf(envFile)).toBe(".env.other")
  })

  it("UNDO-CALLS-SERVER: an explicit action writes undoable, offers Undo, and Undo restores through the server", async () => {
    vi.mocked(applyConfigChanges).mockResolvedValueOnce({
      revision: "rev-2",
      undo: { token: "tok-1", expiresAt: Date.now() + 30_000 },
    })
    vi.mocked(undoConfigAction).mockResolvedValue({ restored: true, revision: "rev-3" })
    await mount()
    const changes = [{ op: "unset" as const, path: ["registry", "llms", { name: "primary" }] }]

    await act(async () => {
      await hook!.runExplicit(changes, { kind: "delete-model", name: "primary" })
    })
    await flush()

    expect(applyConfigChanges).toHaveBeenCalledWith(changes, { undoable: true })
    expect(hook!.status.state).toBe("undo")
    expect(hook!.status.undo).toEqual({ line: undoLine("delete-model", "primary"), name: "primary", token: "tok-1" })

    vi.mocked(fetchConfig).mockResolvedValue(answer(baseConfig, "rev-3") as never)
    await act(async () => {
      await hook!.undo()
    })
    await flush()

    expect(undoConfigAction).toHaveBeenCalledWith("tok-1")
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.status.state).not.toBe("undo")
    expect(hook!.status.state).not.toBe("failed")
  })

  it("UNDO-CALLS-SERVER: the Undo line leaves after its window, and a refused Undo reads Couldn't save", async () => {
    vi.mocked(applyConfigChanges).mockResolvedValue({
      revision: "rev-2",
      undo: { token: "tok-2", expiresAt: Date.now() + 30_000 },
    })
    await mount()
    const changes = [{ op: "unset" as const, path: ["registry", "targets", "staging"] }]

    await act(async () => {
      await hook!.runExplicit(changes, { kind: "delete-target", name: "staging" })
    })
    expect(hook!.status.state).toBe("undo")
    await advance(UNDO_WINDOW_MS)
    expect(hook!.status.state).not.toBe("undo")

    await act(async () => {
      await hook!.runExplicit(changes, { kind: "delete-target", name: "staging" })
    })
    vi.mocked(undoConfigAction).mockRejectedValueOnce(new ApiError(409, "Conflict", { error: "undo_conflict" }))
    await act(async () => {
      await hook!.undo()
    })
    await flush()
    expect(undoConfigAction).toHaveBeenCalledWith("tok-2")
    expect(hook!.status.state).toBe("failed")
  })

  it("NOT-SAVED-GOES-TO-FIRST-DRAFT: the first draft by tab order is where Not saved goes", async () => {
    await mount()
    expect(hook!.goToFirstDraft()).toBeUndefined()

    await run((h) => h.edit(envFile, "  ", { valid: false, error: "Use a file path." }))
    await run((h) => h.edit(step, "soon", durationParse("soon")))

    expect(hook!.goToFirstDraft()).toEqual({ tab: "execution", fieldKey: JSON.stringify(step.segments) })
  })

  it("FILE-ISSUES-RECOVER-WITHOUT-RELOAD: a file that stops parsing shows the load error, and a fixed file returns by itself", async () => {
    await mount()
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-bad" })
    vi.mocked(fetchConfig).mockRejectedValue(
      new ApiError(409, "Conflict", { error: "file_invalid", message: "agent-qa.config.yaml line 3: bad indentation." }),
    )

    await advance(REVISION_POLL_MS)
    expect(hook!.load).toEqual({ kind: "error", reason: "agent-qa.config.yaml line 3: bad indentation" })
    expect(fetchConfig).toHaveBeenCalledTimes(2)

    await advance(REVISION_POLL_MS * 2)
    expect(fetchConfig).toHaveBeenCalledTimes(2)

    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-good" })
    vi.mocked(fetchConfig).mockResolvedValue(answer(editedOutside, "rev-good") as never)
    await advance(REVISION_POLL_MS)

    expect(hook!.load.kind).toBe("ready")
    expect(hook!.valueOf(step)).toBe("2m")
  })
})

describe("useConfigAutosave external drafts (429-25 Task 1)", () => {
  it("EXTERNAL-DRAFT-NOT-SAVED: an open add row marks its tab and reads Not saved until it goes, writing nothing", async () => {
    await mount()
    expect(hook!.status.state).toBe("idle")
    expect(hook!.draftTabs.has("models")).toBe(false)

    await run((h) => h.setExternalDraft("models", true))
    expect(hook!.status.state).toBe("draft")
    expect([...hook!.draftTabs]).toEqual(["models"])
    expect(hook!.goToFirstDraft()).toEqual({ tab: "models", fieldKey: externalDraftFieldKey("models") })
    await advance(SETTLE_DELAY_MS * 2)
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await run((h) => h.edit(step, "soon", durationParse("soon")))
    expect(hook!.goToFirstDraft()).toEqual({ tab: "models", fieldKey: externalDraftFieldKey("models") })

    await run((h) => h.setExternalDraft("models", false))
    expect([...hook!.draftTabs]).toEqual(["execution"])
    expect(hook!.goToFirstDraft()).toEqual({ tab: "execution", fieldKey: JSON.stringify(step.segments) })

    await run((h) => h.discard(step))
    expect(hook!.status.state).toBe("idle")
    expect(hook!.draftTabs.size).toBe(0)
    expect(storedText()).not.toContain("external:")
  })
})

describe("useConfigAutosave landed-write mirror for the new ops (429-45 Task 2)", () => {
  async function landExplicit(changes: ConfigChange[]) {
    let landed = false
    await act(async () => {
      landed = await hook!.runExplicit(changes)
    })
    await flush()
    return landed
  }

  function loadedConfig() {
    return hook!.load.kind === "ready" ? hook!.load.answer.config : undefined
  }

  it("MIRROR-APPLIES-NEW-OPS: on a trusted base, set-if-absent, move and expect show at once with no re-read", async () => {
    const proxyHeader = (name: string): ConfigFieldRef => ({
      segments: ["registry", "llms", { name: "proxy" }, "providerHeaders", name],
      tab: "models",
    })
    const cache: ConfigFieldRef = { segments: ["use", "cache"], tab: "execution" }
    const workers: ConfigFieldRef = { segments: ["use", "workers"], tab: "execution" }
    vi.mocked(fetchConfig).mockResolvedValue(
      answer({
        ...baseConfig,
        registry: {
          ...baseConfig.registry,
          llms: [
            ...baseConfig.registry.llms,
            {
              name: "proxy",
              provider: "openai-compatible",
              model: "gpt-4.1",
              providerHeaders: { "X-Org": "[secret:PW_441]" },
            },
          ],
        },
      }) as never,
    )
    await mount()

    expect(await landExplicit([{ op: "set-if-absent", path: ["use", "timeout", "test"], value: "20m" }])).toBe(true)
    expect(hook!.valueOf(testTimeout)).toBe("10m")

    expect(await landExplicit([{ op: "set-if-absent", path: ["use", "cache"], value: true }])).toBe(true)
    expect(hook!.valueOf(cache)).toBe(true)

    const headers = ["registry", "llms", { name: "proxy" }, "providerHeaders"] as const
    expect(
      await landExplicit([{ op: "move", from: [...headers, "X-Org"], path: [...headers, "X-Team"] }]),
    ).toBe(true)
    expect(hook!.valueOf(proxyHeader("X-Team"))).toBe("[secret:PW_441]")
    expect(hook!.valueOf(proxyHeader("X-Org"))).toBeUndefined()
    expect(JSON.stringify(loadedConfig())).not.toContain("X-Org")

    const before = JSON.stringify(loadedConfig())
    expect(await landExplicit([{ op: "expect", path: ["use", "timeout", "test"], value: "10m" }])).toBe(true)
    expect(JSON.stringify(loadedConfig())).toBe(before)
    expect(
      await landExplicit([
        { op: "expect", path: ["use", "timeout", "test"], value: "10m" },
        { op: "set", path: ["use", "workers"], value: 3 },
      ]),
    ).toBe(true)
    expect(hook!.valueOf(workers)).toBe(3)
    expect(hook!.valueOf(testTimeout)).toBe("10m")

    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  // 429-42: completing use.browser.headless over a root use.headless keeps the owner's value, not
  // the default, so the mirror cannot know what landed and must read it.
  it("MIRROR-LEGACY-HEADLESS-REREADS: set-if-absent of browser headless over a root use.headless re-reads the file", async () => {
    const legacy = { ...baseConfig, use: { timeout: baseConfig.use.timeout, headless: false } }
    const moved = { ...baseConfig, use: { timeout: baseConfig.use.timeout, browser: { headless: false } } }
    vi.mocked(fetchConfig).mockResolvedValueOnce(answer(legacy) as never)
    vi.mocked(fetchConfig).mockResolvedValue(answer(moved, "rev-2") as never)
    await mount()

    expect(await landExplicit([{ op: "set-if-absent", path: ["use", "browser", "headless"], value: true }])).toBe(true)
    await flush()

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.valueOf(headless)).toBe(false)
  })
})

describe("useConfigAutosave computed writes (429-46 Task 1 · CR-01)", () => {
  const patternsPath = ["workspace", "testMatch"]
  const patterns: ConfigFieldRef = { segments: patternsPath, tab: "project" }

  function withPatterns(list: string[]) {
    return { ...baseConfig, workspace: { ...baseConfig.workspace, testMatch: list } }
  }

  function fieldChanged() {
    return new ApiError(409, "Conflict", { error: "field_changed", path: patternsPath })
  }

  /** Adds one pattern to whatever list the config it is handed holds, stating that list first. */
  function addPattern(name: string) {
    return vi.fn((config: Record<string, unknown>): ConfigChange[] => {
      const block = config.workspace as { testMatch?: string[] } | undefined
      const read = block?.testMatch ?? []
      return [
        { op: "expect", path: patternsPath, value: read },
        { op: "set", path: patternsPath, value: [...read, name] },
      ]
    })
  }

  it("COMPUTED-WRITE-MERGES-OUTSIDE-EDIT: a field_changed refusal re-reads, recomputes and lands on the file's list", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(withPatterns(["a", "b"])) as never)
    await mount()
    const first = deferred<never>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(first.promise)
    vi.mocked(applyConfigChanges).mockResolvedValueOnce({ baseRevision: "rev-5", revision: "rev-6" })
    vi.mocked(fetchConfig).mockResolvedValue(answer(withPatterns(["a", "b", "d"]), "rev-5") as never)
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-6" })
    const compute = addPattern("c")

    let landing!: Promise<boolean>
    await act(async () => {
      landing = hook!.runComputed(compute)
    })
    expect(hook!.status.state).toBe("saving")

    await act(async () => {
      first.reject(fieldChanged())
    })
    await flush()

    expect(await landing).toBe(true)
    expect(writeCalls()).toEqual([
      [
        { op: "expect", path: patternsPath, value: ["a", "b"] },
        { op: "set", path: patternsPath, value: ["a", "b", "c"] },
      ],
      [
        { op: "expect", path: patternsPath, value: ["a", "b", "d"] },
        { op: "set", path: patternsPath, value: ["a", "b", "d", "c"] },
      ],
    ])
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(hook!.valueOf(patterns)).toEqual(["a", "b", "d", "c"])
    expect(hook!.status.state).toBe("saved")
    expect(seenStatuses).toContain("saving")
    expect(seenStatuses).not.toContain("failed")
  })

  it("COMPUTED-WRITE-MERGES-OUTSIDE-EDIT: an empty change set writes nothing", async () => {
    await mount()
    let landed = false
    await act(async () => {
      landed = await hook!.runComputed(() => [])
    })
    await flush()

    expect(landed).toBe(true)
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(hook!.status.state).toBe("idle")
  })

  it("COMPUTED-WRITE-GIVES-UP-HONESTLY: a second field_changed reads Couldn't save, and Retry recomputes from a fresh read", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(withPatterns(["a", "b"])) as never)
    await mount()
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(fieldChanged()).mockRejectedValueOnce(fieldChanged())
    vi.mocked(fetchConfig).mockResolvedValue(answer(withPatterns(["a", "b", "d"]), "rev-5") as never)
    const compute = addPattern("c")

    let landed = true
    await act(async () => {
      landed = await hook!.runComputed(compute)
    })
    await flush()

    expect(landed).toBe(false)
    expect(writeCalls()).toHaveLength(2)
    expect(hook!.status.state).toBe("failed")
    expect(hook!.status.message).toBe(FIELD_CHANGED_TEXT)
    expect(hook!.valueOf(patterns)).toEqual(["a", "b", "d"])

    vi.mocked(fetchConfig).mockResolvedValue(answer(withPatterns(["a", "b", "d", "e"]), "rev-7") as never)
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: "rev-8" })
    vi.mocked(applyConfigChanges).mockResolvedValueOnce({ baseRevision: "rev-7", revision: "rev-8" })
    const readsBefore = vi.mocked(fetchConfig).mock.calls.length
    compute.mockClear()

    await run((h) => h.retry())

    expect(fetchConfig).toHaveBeenCalledTimes(readsBefore + 1)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(compute.mock.calls[0]![0]).toEqual(withPatterns(["a", "b", "d", "e"]))
    expect(writeCalls()).toHaveLength(3)
    expect(writeCalls()[2]).toEqual([
      { op: "expect", path: patternsPath, value: ["a", "b", "d", "e"] },
      { op: "set", path: patternsPath, value: ["a", "b", "d", "e", "c"] },
    ])
    expect(hook!.status.state).toBe("saved")
  })
})

describe("useConfigAutosave a Retry with nothing to send (429-53 · WR-06)", () => {
  function writeFailed() {
    return new ApiError(500, "Internal Server Error", {
      error: "write_failed",
      message: "The config file could not be written.",
    })
  }

  it("EMPTY-RETRY-NEVER-SAVING: a failed computed model delete, then Retry, ends idle with nothing in flight", async () => {
    await mount()
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(writeFailed())
    // The shape of model-row.tsx deleteModel: once the delete settles, Retry computes nothing.
    let settled = false
    const compute = vi.fn((): ConfigChange[] =>
      settled ? [] : [{ op: "unset", path: ["registry", "llms", { name: "primary" }] }],
    )

    let landed = true
    await act(async () => {
      landed = await hook!.runComputed(compute, { kind: "delete-model", name: "primary" })
    })
    settled = true
    await flush()

    expect(landed).toBe(false)
    expect(hook!.status.state).toBe("failed")
    expect(writeCalls()).toHaveLength(1)

    const mark = seenStatuses.length
    await run((h) => h.retry())
    await advance(60_000)

    expect(hook!.status.state).toBe("idle")
    expect(seenStatuses.slice(mark)).not.toContain("saving")
    expect(seenStatuses.slice(mark)).not.toContain("saved")
    expect(writeCalls()).toHaveLength(1)
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it("EMPTY-RETRY-NEVER-SAVING: a failed keyless explicit delete, then Retry, ends idle with nothing in flight", async () => {
    await mount()
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(writeFailed())

    let landed = true
    await act(async () => {
      landed = await hook!.runExplicit([{ op: "unset", path: ["registry", "targets", "staging"] }], {
        kind: "delete-target",
        name: "staging",
      })
    })
    await flush()

    expect(landed).toBe(false)
    expect(hook!.status.state).toBe("failed")
    expect(writeCalls()).toHaveLength(1)

    const readsBefore = vi.mocked(fetchConfig).mock.calls.length
    const mark = seenStatuses.length
    await run((h) => h.retry())
    await advance(60_000)

    expect(hook!.status.state).toBe("idle")
    expect(seenStatuses.slice(mark)).not.toContain("saving")
    expect(seenStatuses.slice(mark)).not.toContain("saved")
    expect(writeCalls()).toHaveLength(1)
    expect(vi.mocked(fetchConfig).mock.calls.length).toBeGreaterThan(readsBefore)
  })
})

// 441-40 (D-29): the editor has no masks of its own. A field the server showed through the declared
// mask is never sent unless the person edits it, and a landed write is mirrored as written.
describe("C441-CONFIG", () => {
  const MARKER = "[secret:PW_441]"
  const buildTag: ConfigFieldRef = { segments: ["use", "buildTag"], tab: "execution" }
  const workers: ConfigFieldRef = { segments: ["use", "workers"], tab: "execution" }

  it("the editor does not write back a field it showed masked", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(
      answer({ ...baseConfig, use: { ...baseConfig.use, buildTag: MARKER, workers: 2 } }) as never,
    )
    await mount()
    expect(hook!.valueOf(buildTag)).toBe(MARKER)

    await run((h) => {
      h.edit(workers, 4, { valid: true, value: 4 })
      h.settle(workers)
    })

    expect(writeCalls()).toEqual([[{ op: "set", path: ["use", "workers"], value: 4 }]])
    expect(hook!.valueOf(workers)).toBe(4)
    expect(hook!.valueOf(buildTag)).toBe(MARKER)

    await run((h) => {
      h.edit(step, "45s", durationParse("45s"))
      h.settle(step)
    })

    expect(writeCalls()).toHaveLength(2)
    expect(writeCalls()[1]).toEqual([{ op: "set", path: ["use", "timeout", "step"], value: "45s" }])
    expect(JSON.stringify(writeCalls())).not.toContain("[secret:")
    expect(JSON.stringify(writeCalls())).not.toContain("buildTag")
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it("a landed write shows the value as written, whatever its path", async () => {
    await mount()
    let landed = false
    await act(async () => {
      landed = await hook!.runExplicit([{ op: "set", path: [...accessHeader.segments], value: "AKIA-NEW-1" }])
    })
    await flush()

    expect(landed).toBe(true)
    expect(hook!.valueOf(accessHeader)).toBe("AKIA-NEW-1")
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })
})
