// A refusal shows its plain reason only, in the destructive token, beside an aria-hidden icon.

import { Ban } from "lucide-react"

export function DenialBlock({ neutralReason }: { neutralReason: string }) {
  return (
    <div
      data-entry="denial"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
    >
      <Ban className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <p className="text-foreground">{neutralReason}</p>
    </div>
  )
}
