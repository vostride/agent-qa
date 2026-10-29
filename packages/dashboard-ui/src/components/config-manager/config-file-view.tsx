// The whole file as the server masked it; the page never decides masking and has no reveal.

import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useConfigAutosaveContext } from "@/hooks/use-config-autosave"
import { CONFIG_FILE_NOTE, COPY_PATH_LABEL, COPY_STATUS_WORDS } from "@/lib/config-copy"

type CopyStatus = "idle" | "copied" | "failed"

const COPIED_VISIBLE_MS = 2_000

function CopyPathButton({ path }: { path: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle")
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])

  function copy() {
    clearTimeout(reset.current)
    setStatus("idle")
    const written = navigator.clipboard?.writeText(path)
    if (written === undefined) {
      setStatus("failed")
      return
    }
    void written.then(
      () => {
        setStatus("copied")
        reset.current = setTimeout(() => setStatus("idle"), COPIED_VISIBLE_MS)
      },
      () => setStatus("failed"),
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={COPY_PATH_LABEL}
        data-copy-status={status}
        onClick={copy}
      >
        {status === "copied" ? (
          <Check data-copy-icon="check" className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy data-copy-icon="copy" className="size-3.5" aria-hidden="true" />
        )}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "idle" ? "" : COPY_STATUS_WORDS[status]}
      </span>
    </>
  )
}

export function ConfigFileView() {
  const autosave = useConfigAutosaveContext()
  if (autosave.load.kind !== "ready") return null
  const { path, lines } = autosave.load.answer.file

  return (
    <>
      {path === null ? null : (
        <div className="flex items-center gap-1">
          <code data-config-file-path className="min-w-0 font-mono text-xs wrap-anywhere">
            {path}
          </code>
          <CopyPathButton path={path} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{CONFIG_FILE_NOTE}</p>
      <div data-config-file-view className="overflow-x-auto rounded-md border border-border bg-muted/40 p-4">
        <ol className="font-mono text-xs whitespace-pre">
          {lines.map((line) => (
            <li key={line.n} data-line={line.n}>
              {line.text}
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}
