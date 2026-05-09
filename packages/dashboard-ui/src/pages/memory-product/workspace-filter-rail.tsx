import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type {
  WorkspaceConfidenceFilter,
  WorkspaceDateBasis,
  WorkspaceDateWindow,
  WorkspaceFilters,
} from "./workspace-model"

interface WorkspaceFilterRailProps {
  filters: WorkspaceFilters
  onConfidenceChange: (confidence: WorkspaceConfidenceFilter) => void
  onDateBasisChange: (basis: WorkspaceDateBasis) => void
  onDateWindowChange: (window: WorkspaceDateWindow) => void
  showHeading?: boolean
}

const CONFIDENCE_LABELS: Record<WorkspaceConfidenceFilter, string> = {
  any: "Any (0.00 - 1.00)",
  high: "High (0.75 - 1.00)",
  medium: "Medium (0.50 - 0.74)",
  low: "Low (0.00 - 0.49)",
}

const DATE_BASIS_LABELS: Record<WorkspaceDateBasis, string> = {
  last_confirmed: "Last confirmed",
  updated: "Updated",
  created: "Created",
}

const DATE_WINDOWS: WorkspaceDateWindow[] = ["all", "7d", "30d", "90d"]

export function WorkspaceFilterRail({
  filters,
  onConfidenceChange,
  onDateBasisChange,
  onDateWindowChange,
  showHeading = true,
}: WorkspaceFilterRailProps) {
  return (
    <aside
      data-workspace-filter-rail="true"
      className="space-y-4"
    >
      {showHeading ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Filters
        </p>
      ) : null}

      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Confidence</p>
          <Select
            onValueChange={(value) =>
              onConfidenceChange(value as WorkspaceConfidenceFilter)
            }
          >
            <SelectTrigger className="w-full justify-between bg-background/70">
              <SelectValue placeholder={CONFIDENCE_LABELS[filters.confidence]} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{CONFIDENCE_LABELS.any}</SelectItem>
              <SelectItem value="high">{CONFIDENCE_LABELS.high}</SelectItem>
              <SelectItem value="medium">{CONFIDENCE_LABELS.medium}</SelectItem>
              <SelectItem value="low">{CONFIDENCE_LABELS.low}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">Date</p>
          <Select
            onValueChange={(value) =>
              onDateBasisChange(value as WorkspaceDateBasis)
            }
          >
            <SelectTrigger className="w-full justify-between bg-background/70">
              <SelectValue placeholder={DATE_BASIS_LABELS[filters.dateBasis]} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="last_confirmed">Last confirmed</SelectItem>
              <SelectItem value="updated">Updated</SelectItem>
              <SelectItem value="created">Created</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex flex-wrap gap-2">
            {DATE_WINDOWS.map((window) => (
              <Button
                key={window}
                type="button"
                variant={filters.dateWindow === window ? "default" : "outline"}
                size="xs"
                aria-pressed={filters.dateWindow === window}
                onClick={() => onDateWindowChange(window)}
              >
                {window === "all" ? "All time" : window}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
