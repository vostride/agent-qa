import type { ReactNode, RefObject } from "react"
import { BrainCircuit } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import type { MemoryProductDetail } from "@/lib/api"
import { formatDateShort } from "@/lib/utils"

import type { AtlasSection } from "./atlas-types"
import { ObservationBlock } from "./observation-block"

interface AtlasArticleProps {
  articleRef: RefObject<HTMLElement | null>
  detail: MemoryProductDetail
  query: string
  sections: AtlasSection[]
  toolbar: ReactNode
  visibleCount: number
}

export function AtlasArticle({
  articleRef,
  detail,
  query,
  sections,
  toolbar,
  visibleCount,
}: AtlasArticleProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">
        <Value>{detail.observationCount}</Value> observations{" "}
        <span aria-hidden="true">·</span>{" "}
        Product <Value>{detail.scopeCounts.product}</Value> / Suite{" "}
        <Value>{detail.scopeCounts.suite}</Value> / Test <Value>{detail.scopeCounts.test}</Value>{" "}
        <span aria-hidden="true">·</span>{" "}
        Last confirmed <Value>{detail.freshness ? formatDateShort(detail.freshness) : "Not confirmed yet"}</Value>{" "}
        <span aria-hidden="true">·</span>{" "}
        <Value>{detail.sourceCoverage}</Value> source test{detail.sourceCoverage === 1 ? "" : "s"}
      </p>

      {toolbar}

      <p className="text-sm text-muted-foreground">
        {" "}
        {visibleCount} of {detail.observationCount} observations{" "}
      </p>

      <article ref={articleRef} className="max-w-4xl space-y-12 pb-16">
        {detail.observationCount === 0 ? (
          <EmptyAtlasState
            title="No memory in this product yet"
            description="This product doesn't have cataloged observations in this workspace yet. Run tests or suites with memory enabled, then reopen this atlas."
            icon={<BrainCircuit className="size-5" />}
          />
        ) : null}

        {detail.observationCount > 0 && sections.length === 0 ? (
          <EmptyAtlasState
            title="No observations match these filters"
            description="Clear one or more filters or search terms to return to the full atlas."
          />
        ) : null}

        {sections.map((section) => (
          <section key={section.id} className="space-y-5">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                {section.title}
              </h2>
            </div>

            <div className="space-y-6">
              {section.items.map((observation, index) => {
                const previousScope = section.items[index - 1]?.scope
                const showScopeSubhead =
                  section.id === "remaining-memory" && previousScope !== observation.scope

                return (
                  <div key={observation.id} className="space-y-4">
                    {index > 0 && !showScopeSubhead ? (
                      <Separator className="bg-border/60" />
                    ) : null}

                    {showScopeSubhead ? (
                      <div className="space-y-4">
                        {index > 0 ? <Separator className="bg-border/60" /> : null}
                        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          {formatScopeLabel(observation.scope)}
                        </p>
                      </div>
                    ) : null}

                    <ObservationBlock
                      observation={observation}
                      query={query}
                      showScopeLabel={section.id !== "remaining-memory" && observation.scope !== "product"}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </article>
    </div>
  )
}

function EmptyAtlasState({
  description,
  icon,
  title,
}: {
  description: string
  icon?: ReactNode
  title: string
}) {
  return (
    <div className="rounded-2xl border bg-card/35 px-6 py-12 text-center">
      {icon ? (
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

function Value({ children }: { children: ReactNode }) {
  return <span className="font-medium tabular-nums text-foreground">{children}</span>
}

function formatScopeLabel(scope: AtlasSection["items"][number]["scope"]) {
  switch (scope) {
    case "product":
      return "Product"
    case "suite":
      return "Suite"
    case "test":
      return "Test"
  }
}
