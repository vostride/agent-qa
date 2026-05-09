import { useEffect, useRef, type MutableRefObject } from "react"

import { cn } from "@/lib/utils"

import type { WorkspaceDocument, WorkspaceOutlineNode } from "./workspace-model"

interface WorkspaceOutlineProps {
  activeAnchorId?: string | null
  document: WorkspaceDocument
  onNavigate: (anchorId: string) => void
  showHeading?: boolean
}

export function WorkspaceOutline({
  activeAnchorId = null,
  document,
  onNavigate,
  showHeading = true,
}: WorkspaceOutlineProps) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [activeAnchorId])

  return (
    <aside
      data-workspace-outline="true"
      className="space-y-3"
    >
      {showHeading ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          On this page
        </p>
      ) : null}
      <nav aria-label="Page outline">
        <ul className="space-y-1">
          {document.outline.map((node) =>
            renderOutlineNode(node, 0, activeAnchorId, onNavigate, activeItemRef),
          )}
        </ul>
      </nav>
    </aside>
  )
}

function renderOutlineNode(
  node: WorkspaceOutlineNode,
  depth: number,
  activeAnchorId: string | null,
  onNavigate: (anchorId: string) => void,
  activeItemRef: MutableRefObject<HTMLButtonElement | null>,
) {
  const isActive = activeAnchorId === node.anchorId

  return (
    <li key={node.anchorId} className="space-y-1">
      <button
        type="button"
        ref={isActive ? activeItemRef : null}
        data-workspace-outline-item={node.anchorId}
        data-active={isActive ? "true" : undefined}
        aria-current={isActive ? "location" : undefined}
        className={cn(
          "block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-foreground",
          depth === 0 ? "font-medium text-foreground" : "text-muted-foreground",
          depth === 1 ? "pl-4" : "",
          depth >= 2 ? "pl-6 text-[13px]" : "",
          isActive ? "bg-accent text-foreground" : "",
        )}
        onClick={() => onNavigate(node.anchorId)}
      >
        {node.title}
      </button>
      {node.children.length > 0 ? (
        <ul className="space-y-1">
          {node.children.map((child) =>
            renderOutlineNode(child, depth + 1, activeAnchorId, onNavigate, activeItemRef),
          )}
        </ul>
      ) : null}
    </li>
  )
}
