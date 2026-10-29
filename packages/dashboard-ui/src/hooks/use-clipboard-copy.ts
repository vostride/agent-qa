// `copied` waits for the clipboard write to resolve; no clipboard or a rejection is `failed`.

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
