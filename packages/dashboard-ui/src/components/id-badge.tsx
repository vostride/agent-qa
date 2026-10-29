// The badge reports a copy only once the clipboard write resolves, via `RecordIdCopy`'s hook.

import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useClipboardCopy } from "@/hooks/use-clipboard-copy"

export function copyIdBadgeLabel(label: string, value: string): string {
  return `Copy ${label}: ${value}`
}

export const ID_BADGE_COPIED_TEXT = "Copied to the clipboard"

export function idBadgeCopyFailedText(value: string): string {
  return `Could not copy — select the id to copy it: ${value}`
}

export function IdBadge({ label, value }: { label: string; value: string }) {
  const { status, copy } = useClipboardCopy()
  const truncated = value.length > 16 ? value.slice(0, 16) + '…' : value
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-id-badge
        data-copy-status={status}
        aria-label={copyIdBadgeLabel(label, value)}
        onClick={() => copy(value)}
        className="border border-border/50 bg-muted/50 font-mono font-normal text-muted-foreground hover:text-foreground"
      >
        <span className="opacity-60">{label}:</span>
        <span>{truncated}</span>
        {status === "copied"
          ? <Check className="size-3.5 text-success" aria-hidden="true" />
          : <Copy className="size-3.5 opacity-40" aria-hidden="true" />}
      </Button>
      <span data-id-badge-status role="status" aria-live="polite" className="sr-only">
        {status === "copied" ? ID_BADGE_COPIED_TEXT : status === "failed" ? idBadgeCopyFailedText(value) : ""}
      </span>
    </>
  )
}
