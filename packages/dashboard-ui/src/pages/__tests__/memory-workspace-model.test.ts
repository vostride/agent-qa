import { describe, expect, it } from "vitest"

import type { MemoryWorkspaceObservation } from "@/lib/api"
import {
  applyWorkspaceFilters,
  buildWorkspaceDocument,
  DEFAULT_WORKSPACE_FILTERS,
  serializeWorkspaceMarkdown,
} from "@/pages/memory-product/workspace-model"

function makeObservation(
  overrides: Partial<MemoryWorkspaceObservation> &
    Pick<MemoryWorkspaceObservation, "id" | "content" | "updated">,
): MemoryWorkspaceObservation {
  const { id, content, updated, ...rest } = overrides

  return {
    id,
    title: `Observation: ${content}`,
    content,
    trust: 0.6,
    created: "2026-04-01T09:00:00.000Z",
    updated,
    last_confirmed: "2026-04-05T09:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_shared",
    scope: "product",
    scopeId: "alpha-product",
    scopeRef: null,
    sourceTestRef: {
      kind: "source_test",
      id: "t_shared",
      label: "Shared source",
      targetName: "alpha-target",
      href: "/test/t_shared",
    },
    ...rest,
  }
}

const FIXTURE: MemoryWorkspaceObservation[] = [
  makeObservation({
    id: "obs-product-newest",
    title: "Atlas heading: raw product key stays canonical",
    content: "Product memory",
    trust: 0.92,
    updated: "2026-04-22T09:00:00.000Z",
    last_confirmed: "2026-04-22T09:00:00.000Z",
  }),
  makeObservation({
    id: "obs-suite-checkout",
    title: "Suite metadata: anchors stay subtle for readers",
    content: "Suite memory",
    scope: "suite",
    scopeId: "suite_checkout",
    trust: 0.74,
    updated: "2026-04-21T09:00:00.000Z",
    last_confirmed: "2026-04-21T09:00:00.000Z",
    scopeRef: {
      kind: "suite",
      id: "suite_checkout",
      label: "Checkout suite",
      targetName: "alpha-target",
      href: "/suite/suite_checkout",
    },
  }),
  makeObservation({
    id: "obs-suite-search",
    title: "Local filters: section bucketing happens after filtering",
    content: "Another suite memory",
    scope: "suite",
    scopeId: "suite_search",
    trust: 0.42,
    updated: "2026-04-20T09:00:00.000Z",
    last_confirmed: "2026-04-20T09:00:00.000Z",
    scopeRef: {
      kind: "suite",
      id: "suite_search",
      label: "Search suite",
      targetName: "alpha-target",
      href: "/suite/suite_search",
    },
  }),
  makeObservation({
    id: "obs-test-regression",
    title: "Fallback sorting: contradicted note says atlas sections disappear",
    content: "Test memory",
    scope: "test",
    scopeId: "t_memory_regression",
    trust: 0.81,
    updated: "2026-04-23T09:00:00.000Z",
    last_confirmed: "2026-04-23T09:00:00.000Z",
    scopeRef: {
      kind: "test",
      id: "t_memory_regression",
      label: "Memory regression",
      targetName: "alpha-target",
      href: "/test/t_memory_regression",
    },
  }),
  makeObservation({
    id: "obs-test-shortcuts",
    title: "Keyboard shortcuts: slash focuses atlas search",
    content: "Keyboard shortcut memory",
    scope: "test",
    scopeId: "t_keyboard_shortcuts",
    trust: 0.35,
    updated: "2026-04-22T08:00:00.000Z",
    last_confirmed: "2026-04-22T08:00:00.000Z",
    scopeRef: {
      kind: "test",
      id: "t_keyboard_shortcuts",
      label: "Keyboard shortcuts smoke",
      targetName: "alpha-target",
      href: "/test/t_keyboard_shortcuts",
    },
  }),
]

describe("workspace model", () => {
  it("emits fixed Product -> Suite -> Test sections with grouped suite/test entities and stable anchors", () => {
    const document = buildWorkspaceDocument("alpha-product", FIXTURE)

    expect(document.sections.map((section) => section.id)).toEqual([
      "product",
      "suite",
      "test",
    ])
    expect(document.sections.map((section) => section.anchorId)).toEqual([
      "memory-section-product",
      "memory-section-suite",
      "memory-section-test",
    ])

    expect(document.sections[0]?.groups).toHaveLength(1)
    expect(document.sections[0]?.groups[0]).toMatchObject({
      title: null,
      observations: [
        {
          id: "obs-product-newest",
          anchorId: "memory-observation-obs-product-newest",
        },
      ],
    })

    expect(document.sections[1]?.groups.map((group) => group.title)).toEqual([
      "Checkout suite",
      "Search suite",
    ])
    expect(document.sections[1]?.groups[0]?.anchorId).toBe("memory-group-suite-suite-checkout")

    expect(document.sections[2]?.groups.map((group) => group.title)).toEqual([
      "Memory regression",
      "Keyboard shortcuts smoke",
    ])
    expect(document.sections[2]?.groups[0]?.anchorId).toBe("memory-group-test-t-memory-regression")
  })

  it("builds an outline that shows product titles directly and nests suite/test observations under entity groups", () => {
    const document = buildWorkspaceDocument("alpha-product", FIXTURE)

    expect(document.outline.map((node) => node.title)).toEqual([
      "Product",
      "Suite",
      "Test",
    ])

    expect(document.outline[0]?.children.map((node) => node.title)).toEqual([
      "Atlas heading: raw product key stays canonical",
    ])
    expect(document.outline[1]?.children.map((node) => node.title)).toEqual([
      "Checkout suite",
      "Search suite",
    ])
    expect(document.outline[1]?.children[0]?.children.map((node) => node.title)).toEqual([
      "Suite metadata: anchors stay subtle for readers",
    ])
    expect(document.outline[2]?.children[0]?.children.map((node) => node.title)).toEqual([
      "Fallback sorting: contradicted note says atlas sections disappear",
    ])
  })

  it("applies confidence and date filters without changing canonical section ordering", () => {
    const now = new Date("2026-04-23T12:00:00.000Z")
    const highConfidenceDocument = buildWorkspaceDocument(
      "alpha-product",
      applyWorkspaceFilters(FIXTURE, {
        ...DEFAULT_WORKSPACE_FILTERS,
        confidence: "high",
      }, now),
    )

    expect(highConfidenceDocument.sections.map((section) => section.id)).toEqual([
      "product",
      "suite",
      "test",
    ])
    expect(highConfidenceDocument.sections[0]?.groups[0]?.observations.map((entry) => entry.id)).toEqual([
      "obs-product-newest",
    ])
    expect(highConfidenceDocument.sections[1]?.groups).toHaveLength(0)
    expect(highConfidenceDocument.sections[2]?.groups.map((group) => group.title)).toEqual([
      "Memory regression",
    ])

    expect(
      applyWorkspaceFilters(FIXTURE, {
        ...DEFAULT_WORKSPACE_FILTERS,
        dateBasis: "created",
        dateWindow: "7d",
      }, now),
    ).toHaveLength(0)
    expect(
      applyWorkspaceFilters(FIXTURE, {
        ...DEFAULT_WORKSPACE_FILTERS,
        dateBasis: "updated",
        dateWindow: "7d",
      }, now),
    ).toHaveLength(FIXTURE.length)
    expect(
      applyWorkspaceFilters(FIXTURE, {
        ...DEFAULT_WORKSPACE_FILTERS,
        dateBasis: "last_confirmed",
        dateWindow: "7d",
      }, now).map((observation) => observation.id),
    ).toContain("obs-test-regression")
  })

  it("serializes the full canonical page as markdown with invalid-file summary and grouped headings", () => {
    const markdown = serializeWorkspaceMarkdown(
      buildWorkspaceDocument("alpha-product", FIXTURE),
      [
        {
          scope: "test",
          scopeId: "t_memory_regression",
          filename: "obs_legacy-titleless.md",
          code: "parse_error",
          message: "Invalid observation frontmatter: title is required.",
        },
      ],
    )

    expect(markdown).toContain("# Memory: alpha-product")
    expect(markdown).toContain("> 1 invalid memory file hidden from this workspace.")
    expect(markdown).toContain("## Product")
    expect(markdown).toContain("### Atlas heading: raw product key stays canonical")
    expect(markdown).toContain("## Suite")
    expect(markdown).toContain("### Checkout suite")
    expect(markdown).toContain("#### Suite metadata: anchors stay subtle for readers")
    expect(markdown).toContain("## Test")
    expect(markdown).toContain("### Memory regression")
    expect(markdown).toContain("#### Fallback sorting: contradicted note says atlas sections disappear")
  })
})
