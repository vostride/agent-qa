// The dashboard renders a denial's plain reason only. 2026-10-01: there is no remedy
// vocabulary to project, so the block has one line and no way to grow a suggested command.
//
// 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW pillars 2-3): a refusal is a hard stop, so it wears the
// destructive token the hook dialogs' error boxes use, not a raw warning amber, and an icon marks it
// as a refusal. The icon is aria-hidden and adds no text: the reason is the whole of what it says.

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
