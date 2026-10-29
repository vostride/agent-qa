// One copy-status pattern for every copy control (quick 261003-cpv, 432-UI-REVIEW fix 3, pillar 5).
//
// `copied` is set only after the clipboard write resolved. A missing clipboard or a rejected write is
// `failed`, which the control announces with the value spelled out so it can still be selected.
// Extracted from `RecordIdCopy`, whose pattern `IdBadge` lacked.

import { useEffect, useRef, useState } from "react"

export type CopyStatus = "idle" | "copied" | "failed"

export function useClipboardCopy(): { status: CopyStatus; copy: (value: string) => void } {
  const [status, setStatus] = useState<CopyStatus>("idle")
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(reset.current) }, [])

  const copy = (value: string) => {
    clearTimeout(reset.current)
    const written = navigator.clipboard?.writeText(value)
    if (written === undefined) {
      setStatus("failed")
      return
    }
    void written.then(
      () => {
        setStatus("copied")
        reset.current = setTimeout(() => setStatus("idle"), 2000)
      },
      () => { setStatus("failed") },
    )
  }

  return { status, copy }
}
