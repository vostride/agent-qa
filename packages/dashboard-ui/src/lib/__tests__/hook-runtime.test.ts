import { describe, expect, it } from "vitest"
import { IoLogoNodejs, IoLogoPython, IoTerminal } from "react-icons/io5"

import { BunRuntimeIcon } from "@/components/icons/bun-runtime-icon"
import { HOOK_RUNTIME_ICONS, HOOK_RUNTIME_META, getHookRuntimeMeta } from "@/lib/hook-runtime"

describe("hook runtime metadata", () => {
  it("locks the four-runtime dashboard contract and Bun-first metadata", () => {
    expect(HOOK_RUNTIME_ICONS.bun).toBe(BunRuntimeIcon)
    expect(HOOK_RUNTIME_ICONS.node).toBe(IoLogoNodejs)
    expect(HOOK_RUNTIME_ICONS.python).toBe(IoLogoPython)
    expect(HOOK_RUNTIME_ICONS.bash).toBe(IoTerminal)

    expect(Object.keys(HOOK_RUNTIME_META)).toEqual(["node", "bun", "python", "bash"])
    expect(getHookRuntimeMeta("node").icon).toBe(HOOK_RUNTIME_ICONS.node)
    expect(getHookRuntimeMeta("bun").icon).toBe(HOOK_RUNTIME_ICONS.bun)
    expect(getHookRuntimeMeta("bun")).toMatchObject({
      label: "Bun",
      shortLabel: "BUN",
      monacoLanguage: "typescript",
      extension: ".ts",
    })
    expect(getHookRuntimeMeta("python").icon).toBe(HOOK_RUNTIME_ICONS.python)
    expect(getHookRuntimeMeta("bash").icon).toBe(HOOK_RUNTIME_ICONS.bash)
  })

  it("uses starter snippets that write emitted variables to /tmp/agent-qa.env and show stdout/stderr examples", () => {
    expect(getHookRuntimeMeta("node").template).toContain("/tmp/agent-qa.env")
    expect(getHookRuntimeMeta("node").template).toContain("HOOK_STATUS=ready")
    expect(getHookRuntimeMeta("node").template).toContain("HOOK_RUNTIME=node")
    expect(getHookRuntimeMeta("node").template).toContain("console.log")
    expect(getHookRuntimeMeta("node").template).toContain("console.error")

    expect(getHookRuntimeMeta("bun").template).toContain("/tmp/agent-qa.env")
    expect(getHookRuntimeMeta("bun").template).toContain("HOOK_STATUS=ready")
    expect(getHookRuntimeMeta("bun").template).toContain("HOOK_RUNTIME=bun")
    expect(getHookRuntimeMeta("bun").template).toContain("console.log")
    expect(getHookRuntimeMeta("bun").template).toContain("console.error")

    expect(getHookRuntimeMeta("python").template).toContain("/tmp/agent-qa.env")
    expect(getHookRuntimeMeta("python").template).toContain("HOOK_STATUS=ready")
    expect(getHookRuntimeMeta("python").template).toContain("HOOK_RUNTIME=python")
    expect(getHookRuntimeMeta("python").template).toContain("print(")
    expect(getHookRuntimeMeta("python").template).toContain("file=sys.stderr")

    expect(getHookRuntimeMeta("bash").template).toContain("/tmp/agent-qa.env")
    expect(getHookRuntimeMeta("bash").template).toContain("HOOK_STATUS=ready")
    expect(getHookRuntimeMeta("bash").template).toContain("HOOK_RUNTIME=bash")
    expect(getHookRuntimeMeta("bash").template).toContain(">&2")

    expect(HOOK_RUNTIME_META.node.template).not.toContain("return context")
    expect(HOOK_RUNTIME_META.bun.template).not.toContain("return context")
    expect(HOOK_RUNTIME_META.python.template).not.toContain("return context")
    expect(HOOK_RUNTIME_META.bash.template).not.toContain("hook executed")
  })
})
