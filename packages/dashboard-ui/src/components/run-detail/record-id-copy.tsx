// The check shows only after the write resolves; a failure is announced and spells the id out.

import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useClipboardCopy } from "@/hooks/use-clipboard-copy"
import { RECORD_ID_COPIED_TEXT, copyRecordIdLabel, recordIdCopyFailedText } from "@/lib/knowledge-view"

export function RecordIdCopy({ id, className }: { id: string; className?: string }) {
  const { status, copy } = useClipboardCopy()

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-record-id-copy
        data-copy-status={status}
        aria-label={copyRecordIdLabel(id)}
        onClick={() => copy(id)}
        className={`shrink-0 align-middle ${className ?? ""}`}
      >
        {status === "copied"
          ? <Check className="size-3.5 text-success" aria-hidden="true" />
          : <Copy className="size-3.5" aria-hidden="true" />}
      </Button>
      <span data-record-id-copy-status role="status" aria-live="polite" className="sr-only">
        {status === "copied" ? RECORD_ID_COPIED_TEXT : status === "failed" ? recordIdCopyFailedText(id) : ""}
      </span>
    </>
  )
}
