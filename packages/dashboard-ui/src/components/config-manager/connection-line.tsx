// A failed test shows the server's classifier sentence as given; none is spelled here.

import { CircleCheck, CircleX, LoaderCircle } from "lucide-react"

import { TEST_RESULT_TEXT } from "@/lib/config-copy"
import type { TestResult } from "@/lib/config-tabs"
import { cn } from "@/lib/utils"

interface ConnectionLineProps {
  state: TestResult
  /** The server's sentence for a failed test. */
  sentence?: string
}

function Glyph({ state }: { state: TestResult }) {
  switch (state) {
    case "testing":
      return <LoaderCircle className="size-3.5 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />
    case "connected":
    case "connected-without-key":
      return <CircleCheck className="size-3.5 text-emerald-500" aria-hidden="true" />
    case "failed":
      return <CircleX className="size-3.5 text-destructive" aria-hidden="true" />
  }
}

export function ConnectionLine({ state, sentence }: ConnectionLineProps) {
  const text = state === "failed" ? sentence : TEST_RESULT_TEXT[state]
  return (
    <div
      data-test-result={state}
      role="status"
      aria-live="polite"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <Glyph state={state} />
      </span>
      <p
        className={cn(
          "break-words",
          state === "testing" && "text-muted-foreground",
          state === "failed" ? "text-destructive" : state !== "testing" && "text-foreground",
        )}
      >
        {text}
      </p>
    </div>
  )
}
