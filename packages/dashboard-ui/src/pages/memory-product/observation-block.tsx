import {
  Fragment,
  useState,
} from "react"
import { Ellipsis } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ObservationMarkdown } from "@/components/observation-markdown"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import type { MemoryAtlasObservation, MemoryWorkspaceObservation } from "@/lib/api"

import { ObservationMetadata } from "./observation-metadata"

interface ObservationBlockProps {
  observation: MemoryAtlasObservation | MemoryWorkspaceObservation
  query: string
  showScopeLabel?: boolean
}

export function ObservationBlock({
  observation,
  query,
  showScopeLabel = false,
}: ObservationBlockProps) {
  const [open, setOpen] = useState(false)

  return (
    <div data-observation-block={observation.id} className="space-y-2.5">
      {showScopeLabel ? (
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {formatScopeLabel(observation.scope)}
        </p>
      ) : null}
      <div className="space-y-2.5">
        <div className="flex items-start gap-1.5">
          <h3 className="min-w-0 flex-1 select-text text-base font-medium tracking-tight text-foreground">
            {renderHighlightedText(observation.title, query)}
          </h3>

          <div className="shrink-0">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Observation details"
                  className="size-7 rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <Ellipsis className="size-4" />
                </Button>
              </PopoverTrigger>

              <ObservationMetadata
                observation={observation}
                onRequestClose={() => {
                  setOpen(false)
                }}
              />
            </Popover>
          </div>
        </div>

        <ObservationMarkdown
          className="select-text leading-7"
          content={observation.content}
        />
      </div>
    </div>
  )
}

function renderHighlightedText(text: string, query: string) {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return text
  }

  const lowerQuery = trimmedQuery.toLowerCase()
  const pattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, "ig")
  const parts = text.split(pattern)

  return parts.map((part, index) => {
    if (part.toLowerCase() !== lowerQuery) {
      return <Fragment key={`${part}-${index}`}>{part}</Fragment>
    }

    return (
      <mark
        key={`${part}-${index}`}
        className="rounded-sm bg-primary/15 px-0.5 text-foreground"
      >
        {part}
      </mark>
    )
  })
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function formatScopeLabel(scope: MemoryAtlasObservation["scope"]) {
  switch (scope) {
    case "product":
      return "Product"
    case "suite":
      return "Suite"
    case "test":
      return "Test"
  }
}
