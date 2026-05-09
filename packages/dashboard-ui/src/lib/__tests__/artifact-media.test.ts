import { describe, expect, it } from "vitest"

import { resolveScreenshotSrc, resolveVideoSrc } from "@/lib/artifact-media"

describe("artifact media resolvers", () => {
  it("resolves canonical screenshot paths", () => {
    expect(resolveScreenshotSrc("run_1/0-Step.png")).toBe("/api/screenshots/run_1/0-Step.png")
  })

  it("preserves external screenshot sources", () => {
    expect(resolveScreenshotSrc("data:image/png;base64,abc")).toBe("data:image/png;base64,abc")
    expect(resolveScreenshotSrc("https://example.com/shot.png")).toBe("https://example.com/shot.png")
  })

  it("uses the last two screenshot path segments for legacy paths", () => {
    expect(resolveScreenshotSrc("screens/run_1/0-Step.png")).toBe("/api/screenshots/run_1/0-Step.png")
  })

  it("resolves canonical video paths", () => {
    expect(resolveVideoSrc("run_1", "run_1/recording.webm")).toBe("/api/videos/run_1/recording.webm")
  })

  it("falls back to run-id URLs for flat legacy video filenames", () => {
    expect(resolveVideoSrc("run_1", "recording.webm")).toBe("/api/videos/run_1/recording.webm")
  })

  it("does not expose local absolute external video paths", () => {
    expect(resolveVideoSrc("run_1", "/tmp/outside.webm")).toBe(null)
  })
})
