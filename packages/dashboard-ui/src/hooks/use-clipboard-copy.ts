// `copied` waits for the clipboard write to resolve; no clipboard or a rejection is `failed`.
// Either result returns to `idle` after a moment, so the next one is announced again.

import { useEffect, useRef, useState } from "react"

export type CopyStatus = "idle" | "copied" | "failed"

export function useClipboardCopy(): { status: CopyStatus; copy: (value: string) => void } {
  const [status, setStatus] = useState<CopyStatus>("idle")
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(reset.current) }, [])

  const settle = (result: CopyStatus) => {
    setStatus(result)
    reset.current = setTimeout(() => setStatus("idle"), 2000)
  }

  const copy = (value: string) => {
    clearTimeout(reset.current)
    const written = navigator.clipboard?.writeText(value)
    if (written === undefined) {
      settle("failed")
      return
    }
    void written.then(
      () => settle("copied"),
      () => settle("failed"),
    )
  }

  return { status, copy }
}
