// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactConfigTab } from "@/components/run-detail/artifact-config-tab"
import type { RunArtifactResponse } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

function mount(response: RunArtifactResponse) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<ArtifactConfigTab response={response} />)
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

function makeRun() {
  return {
    id: "run-1",
    name: "Artifact config run",
    filePath: "tests/login.yaml",
    status: "passed",
    duration: 1200,
    attributes: {
      "agent-qa.trigger": "cli",
      "agent-qa.runner": "local",
    },
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.200Z",
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: "t_login",
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
    targetName: "local-chrome",
  }
}

function baseResponse(payload: Record<string, unknown>, missingSections: string[] = []): RunArtifactResponse {
  return {
    run: makeRun(),
    artifact: {
      runId: "run-1",
      kind: "test",
      schemaVersion: 1,
      payload: { schemaVersion: 1, ...payload },
      finalizedAt: "2026-04-18T00:00:01.200Z",
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:01.200Z",
    },
    children: [],
    missingSections,
  }
}

describe("ArtifactConfigTab", () => {
  it("renders run, config, effective config, test source, runtime, and raw labels", () => {
    mount(baseResponse({
      config: {
        rawConfigContent: "targets:\n  local-chrome:\n    platform: web",
        parsedConfig: { targets: ["local-chrome", "firefox"] },
        effectiveConfig: { target: "local-chrome", use: { browserName: "chromium" }, retries: 1 },
        envFile: { path: ".env", content: "A=B", variables: { A: "B" } },
        secretsFile: {
          path: ".secrets.local",
          status: "loaded",
          count: 1,
          variables: { loginPassword: "raw-secret-sentinel" },
          content: "loginPassword=raw-secret-sentinel",
        },
        cliVars: { BASE_URL: "https://example.test" },
        inlineVars: { USER: "demo" },
        hooks: [{ id: "h_setup", name: "Setup" }],
      },
      source: {
        kind: "test",
        testId: "t_login",
        name: "Login test",
        filePath: "tests/login.yaml",
        rawYaml: "name: Login test",
        loadStatus: "loaded",
        resolvedDefinition: { steps: ["open", "login"] },
      },
      runtime: { status: "passed", duration: 1200 },
      errors: [{ code: "WARN", phase: "runtime", message: "example warning" }],
    }))

    expect(container.textContent).toContain("Run Summary")
    expect(container.textContent).toContain("Artifact config run")
    expect(container.textContent).toContain("Global Config")
    expect(container.textContent).toContain("Raw global config")
    expect(container.textContent).toContain("Effective Config")
    expect(container.textContent).toContain("Source Snapshot")
    expect(container.textContent).toContain("Raw test YAML")
    expect(container.textContent).toContain("Runtime and Errors")
    expect(container.textContent).toContain("2 items")
    expect(container.textContent).toContain("example warning")
    expect(container.textContent).toContain("Secrets file")
    expect(container.textContent).toContain(".secrets.local")
    expect(container.textContent).toContain("loaded")
    expect(container.textContent).toContain("1 secret")
    expect(container.textContent).not.toContain("raw-secret-sentinel")
    expect(container.textContent).not.toContain("loginPassword")
  })

  it("renders ordered suite members including child run links and load errors", () => {
    const response = baseResponse({
      source: {
        kind: "suite",
        suiteId: "s_checkout",
        name: "Checkout suite",
        filePath: "suites/checkout.yaml",
        rawYaml: "name: Checkout suite",
        loadStatus: "loaded",
        resolvedDefinition: { tests: ["Login", "Checkout"] },
        members: [
          {
            index: 1,
            ref: { test: "checkout", id: "m_checkout" },
            testId: "t_checkout",
            name: "Checkout",
            filePath: "tests/checkout.yaml",
            loadStatus: "parse-error",
            error: { code: "PARSE", phase: "load", message: "bad yaml" },
          },
          {
            index: 0,
            ref: { test: "login", id: "m_login" },
            testId: "t_login",
            name: "Login",
            filePath: "tests/login.yaml",
            rawYaml: "name: Login",
            resolvedDefinition: { steps: ["open"] },
            loadStatus: "loaded",
            childRunId: "child-login",
          },
        ],
      },
    })
    response.artifact!.kind = "suite-parent"
    response.children = [{ run: { ...makeRun(), id: "child-login", testId: "t_login", name: "Login" }, artifact: null }]

    mount(response)

    expect(container.textContent).toContain("Raw suite YAML")
    expect(container.textContent).toContain("Suite Members")
    expect(container.textContent).toContain("Raw member YAML")

    const members = Array.from(container.querySelectorAll("[data-suite-member-index]"))
    expect(members.map((member) => member.getAttribute("data-suite-member-index"))).toEqual(["0", "1"])
    expect(members[0].textContent).toContain("Login")
    expect(members[1].textContent).toContain("Checkout")
    expect(members[1].textContent).toContain("parse-error")
    expect(members[1].textContent).toContain("bad yaml")

    const link = container.querySelector('a[href="/runs/child-login"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.textContent).toBe("child-login")
  })

  it("renders quiet missing config and source placeholders", () => {
    mount(baseResponse({}, ["config", "source"]))

    expect(container.textContent).toContain("Run Summary")
    expect(container.textContent).toContain("Config was not captured for this run.")
    expect(container.textContent).toContain("Source was not captured for this run.")
  })
})
