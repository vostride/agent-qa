import type { MemoryInvalidFile, MemoryWorkspaceObservation } from "@/lib/api"

export type WorkspaceConfidenceFilter = "any" | "high" | "medium" | "low"
export type WorkspaceDateBasis = "last_confirmed" | "updated" | "created"
export type WorkspaceDateWindow = "all" | "7d" | "30d" | "90d"

export interface WorkspaceFilters {
  confidence: WorkspaceConfidenceFilter
  dateBasis: WorkspaceDateBasis
  dateWindow: WorkspaceDateWindow
}

export type WorkspaceSectionId = "product" | "suite" | "test"

export interface WorkspaceDocumentObservation {
  anchorId: string
  id: string
  observation: MemoryWorkspaceObservation
}

export interface WorkspaceGroup {
  anchorId: string
  id: string
  title: string | null
  observations: WorkspaceDocumentObservation[]
}

export interface WorkspaceSection {
  anchorId: string
  groups: WorkspaceGroup[]
  id: WorkspaceSectionId
  title: string
}

export interface WorkspaceOutlineNode {
  anchorId: string
  children: WorkspaceOutlineNode[]
  id: string
  title: string
}

export interface WorkspaceDocument {
  outline: WorkspaceOutlineNode[]
  productKey: string
  sections: WorkspaceSection[]
}

const SECTION_ORDER: Array<{ id: WorkspaceSectionId; title: string }> = [
  { id: "product", title: "Product" },
  { id: "suite", title: "Suite" },
  { id: "test", title: "Test" },
]

export const DEFAULT_WORKSPACE_FILTERS: WorkspaceFilters = {
  confidence: "any",
  dateBasis: "last_confirmed",
  dateWindow: "all",
}

export function buildWorkspaceDocument(
  productKey: string,
  observations: MemoryWorkspaceObservation[],
): WorkspaceDocument {
  const sections = SECTION_ORDER.map(({ id, title }) => ({
    anchorId: `memory-section-${id}`,
    groups: buildSectionGroups(
      id,
      productKey,
      observations.filter((observation) => observation.scope === id),
    ),
    id,
    title,
  }))

  return {
    outline: buildWorkspaceOutline(sections),
    productKey,
    sections,
  }
}

export function applyWorkspaceFilters(
  observations: MemoryWorkspaceObservation[],
  filters: WorkspaceFilters,
  now: Date,
) {
  return observations.filter(
    (observation) =>
      matchesConfidence(observation, filters.confidence) &&
      matchesDateWindow(observation, filters.dateBasis, filters.dateWindow, now),
  )
}

export function listWorkspaceOutlineAnchorIds(outline: WorkspaceOutlineNode[]): string[] {
  return outline.flatMap((node) => [node.anchorId, ...listWorkspaceOutlineAnchorIds(node.children)])
}

export function serializeWorkspaceMarkdown(
  document: WorkspaceDocument,
  invalidFiles: MemoryInvalidFile[] = [],
) {
  const lines: string[] = [`# Memory: ${document.productKey}`, ""]

  if (invalidFiles.length > 0) {
    lines.push(
      `> ${invalidFiles.length} invalid memory file${invalidFiles.length === 1 ? "" : "s"} hidden from this workspace.`,
      `> ${invalidFiles.map((file) => file.filename).join(", ")}`,
      "",
    )
  }

  for (const section of document.sections) {
    lines.push(`## ${section.title}`, "")

    if (section.id === "product") {
      for (const entry of section.groups[0]?.observations ?? []) {
        lines.push(`### ${entry.observation.title}`, "", entry.observation.content, "")
      }
      continue
    }

    for (const group of section.groups) {
      if (group.title) {
        lines.push(`### ${group.title}`, "")
      }

      for (const entry of group.observations) {
        lines.push(`#### ${entry.observation.title}`, "", entry.observation.content, "")
      }
    }
  }

  return lines.join("\n").trim()
}

function buildSectionGroups(
  sectionId: WorkspaceSectionId,
  productKey: string,
  observations: MemoryWorkspaceObservation[],
): WorkspaceGroup[] {
  const sortedObservations = [...observations].sort(compareObservationsDescending)

  if (sectionId === "product") {
    return sortedObservations.length > 0
      ? [
          {
            anchorId: `memory-group-product-${slugify(productKey)}`,
            id: productKey,
            title: null,
            observations: sortedObservations.map(toWorkspaceObservation),
          },
        ]
      : []
  }

  const groups = new Map<
    string,
    {
      title: string
      observations: MemoryWorkspaceObservation[]
    }
  >()

  for (const observation of sortedObservations) {
    const groupId = observation.scopeRef?.id ?? observation.scopeId
    const existing = groups.get(groupId)

    if (existing) {
      existing.observations.push(observation)
      continue
    }

    groups.set(groupId, {
      title: observation.scopeRef?.label ?? observation.scopeId,
      observations: [observation],
    })
  }

  return [...groups.entries()]
    .map(([id, group]) => ({
      anchorId: `memory-group-${sectionId}-${slugify(id)}`,
      id,
      title: group.title,
      observations: group.observations
        .sort(compareObservationsDescending)
        .map(toWorkspaceObservation),
    }))
    .sort(compareGroupsDescending)
}

function buildWorkspaceOutline(sections: WorkspaceSection[]): WorkspaceOutlineNode[] {
  return sections.map((section) => ({
    anchorId: section.anchorId,
    children:
      section.id === "product"
        ? (section.groups[0]?.observations ?? []).map((entry) => ({
            anchorId: entry.anchorId,
            children: [],
            id: entry.observation.id,
            title: entry.observation.title,
          }))
        : section.groups.map((group) => ({
            anchorId: group.anchorId,
            children: group.observations.map((entry) => ({
              anchorId: entry.anchorId,
              children: [],
              id: entry.observation.id,
              title: entry.observation.title,
            })),
            id: group.id,
            title: group.title ?? section.title,
          })),
    id: section.id,
    title: section.title,
  }))
}

function compareGroupsDescending(left: WorkspaceGroup, right: WorkspaceGroup) {
  const leftNewest = left.observations[0]?.observation
  const rightNewest = right.observations[0]?.observation

  if (leftNewest && rightNewest) {
    const dateComparison = compareObservationsDescending(leftNewest, rightNewest)
    if (dateComparison !== 0) {
      return dateComparison
    }
  }

  return (left.title ?? "").localeCompare(right.title ?? "")
}

function compareObservationsDescending(
  left: MemoryWorkspaceObservation,
  right: MemoryWorkspaceObservation,
) {
  return (
    compareIsoDescending(left.last_confirmed, right.last_confirmed) ||
    compareIsoDescending(left.updated, right.updated) ||
    left.title.localeCompare(right.title)
  )
}

function compareIsoDescending(left: string, right: string) {
  return right.localeCompare(left)
}

function matchesConfidence(
  observation: MemoryWorkspaceObservation,
  confidence: WorkspaceConfidenceFilter,
) {
  switch (confidence) {
    case "any":
      return true
    case "high":
      return observation.trust >= 0.75
    case "medium":
      return observation.trust >= 0.5 && observation.trust < 0.75
    case "low":
      return observation.trust < 0.5
  }
}

function matchesDateWindow(
  observation: MemoryWorkspaceObservation,
  dateBasis: WorkspaceDateBasis,
  dateWindow: WorkspaceDateWindow,
  now: Date,
) {
  if (dateWindow === "all") {
    return true
  }

  const basisValue = observation[dateBasis]
  const basisTime = new Date(basisValue).getTime()
  if (Number.isNaN(basisTime)) {
    return false
  }

  const cutoff = new Date(now)
  const days = getWindowDays(dateWindow)
  cutoff.setDate(cutoff.getDate() - days)

  return basisTime >= cutoff.getTime()
}

function getWindowDays(dateWindow: Exclude<WorkspaceDateWindow, "all">) {
  switch (dateWindow) {
    case "7d":
      return 7
    case "30d":
      return 30
    case "90d":
      return 90
  }
}

function toWorkspaceObservation(
  observation: MemoryWorkspaceObservation,
): WorkspaceDocumentObservation {
  return {
    anchorId: `memory-observation-${slugify(observation.id)}`,
    id: observation.id,
    observation,
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
