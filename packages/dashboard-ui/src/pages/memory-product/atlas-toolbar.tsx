import { useState, type RefObject } from "react"
import { ChevronsUpDown, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

import type { AtlasFilters } from "./atlas-types"

interface AtlasToolbarProps {
  filters: AtlasFilters
  hasActiveFilters: boolean
  onClearFilters: () => void
  onFreshnessChange: (value: AtlasFilters["freshness"]) => void
  onQueryChange: (value: string) => void
  onScopeChange: (value: AtlasFilters["scope"]) => void
  onSortChange: (value: AtlasFilters["sort"]) => void
  onSourceChange: (value: AtlasFilters["source"]) => void
  onTrustChange: (value: AtlasFilters["trust"]) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  sources: string[]
}

export function AtlasToolbar({
  filters,
  hasActiveFilters,
  onClearFilters,
  onFreshnessChange,
  onQueryChange,
  onScopeChange,
  onSortChange,
  onSourceChange,
  onTrustChange,
  searchInputRef,
  sources,
}: AtlasToolbarProps) {
  const [sourceOpen, setSourceOpen] = useState(false)

  return (
    <div className="rounded-xl border bg-card/35 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <Input
          ref={searchInputRef}
          placeholder="Search this memory..."
          value={filters.query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="w-full md:max-w-[240px]"
        />

        <Select
          value={filters.scope}
          onValueChange={(value) => onScopeChange(value as AtlasFilters["scope"])}
        >
          <SelectTrigger className="w-full md:w-[140px]">
            <SelectValue placeholder="All scopes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="suite">Suite</SelectItem>
            <SelectItem value="test">Test</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.freshness}
          onValueChange={(value) => onFreshnessChange(value as AtlasFilters["freshness"])}
        >
          <SelectTrigger className="w-full md:w-[170px]">
            <SelectValue placeholder="All freshness" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All freshness</SelectItem>
            <SelectItem value="confirmed-7d">Confirmed in last 7d</SelectItem>
            <SelectItem value="confirmed-30d">Confirmed in last 30d</SelectItem>
            <SelectItem value="older-or-unconfirmed">Older or unconfirmed</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.trust}
          onValueChange={(value) => onTrustChange(value as AtlasFilters["trust"])}
        >
          <SelectTrigger className="w-full md:w-[140px]">
            <SelectValue placeholder="Any trust" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any trust</SelectItem>
            <SelectItem value="high">High trust</SelectItem>
            <SelectItem value="medium">Medium trust</SelectItem>
            <SelectItem value="low">Low trust</SelectItem>
          </SelectContent>
        </Select>

        <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={filters.source === "all" ? "outline" : "secondary"}
              className={cn(
                "h-9 w-full justify-between md:w-[180px]",
                filters.source === "all"
                  ? "text-muted-foreground"
                  : "font-mono text-xs text-foreground",
              )}
            >
              <span className="truncate">
                {filters.source === "all" ? "All sources" : filters.source}
              </span>
              <ChevronsUpDown className="size-4 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <Command>
              <CommandInput placeholder="Search sources..." />
              <CommandList className="max-h-64">
                <CommandEmpty>No sources match this memory.</CommandEmpty>
                <CommandGroup>
                  {sources.map((source) => (
                    <CommandItem
                      key={source}
                      value={source}
                      onSelect={() => {
                        onSourceChange(source)
                        setSourceOpen(false)
                      }}
                    >
                      <span className="truncate font-mono text-xs">{source}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Select
          value={filters.sort}
          onValueChange={(value) => onSortChange(value as AtlasFilters["sort"])}
        >
          <SelectTrigger className="w-full md:w-[170px]">
            <SelectValue placeholder="Atlas order" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="atlas">Atlas order</SelectItem>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="recently-confirmed">Recently confirmed</SelectItem>
            <SelectItem value="highest-trust">Highest trust</SelectItem>
            <SelectItem value="most-contradicted">Most contradicted</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            className="h-9 justify-start md:ml-auto"
            onClick={onClearFilters}
          >
            <X className="size-4" />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  )
}
