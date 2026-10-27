// ONE SECRET VALUE (429-19 · D-08, D-17 · UI-SPEC S8, E11).
//
// The server's text is shown verbatim, already through the declared mask; there is no reveal
// (441-49, D-29). Editing is replace-only: the input starts empty and is never given the shown
// text, so a mask can never be written back. Secrets never autosave.

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { ConfigPathSegment } from "@vostride/agent-qa-schema"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConfigAutosaveContext } from "@/hooks/use-config-autosave"
import {
  KEEP_CURRENT_VALUE_LABEL,
  REPLACE_VALUE_LABEL,
  SAVE_VALUE_LABEL,
  keepValueName,
  replaceValueName,
  saveValueName,
} from "@/lib/config-copy"

export interface SecretValueTarget {
  segments: readonly ConfigPathSegment[]
  /** The leaf's schema pattern, for example registry.llms[].providerHeaders.* */
  pattern: string
}

export interface SecretValueProps {
  field: SecretValueTarget
  label: string
  maskedText: string
}

export function SecretValue({ field, label, maskedText }: SecretValueProps) {
  const autosave = useConfigAutosaveContext()
  const [replacing, setReplacing] = useState(false)
  const [typed, setTyped] = useState("")
  const [saving, setSaving] = useState(false)
  const mounted = useRef(false)
  const focusReplaceNext = useRef(false)
  const replaceButton = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (replacing) {
      input.current?.focus()
    } else if (focusReplaceNext.current) {
      focusReplaceNext.current = false
      replaceButton.current?.focus()
    }
  }, [replacing])

  function startReplace() {
    setTyped("")
    setReplacing(true)
  }

  function closeReplace() {
    setTyped("")
    focusReplaceNext.current = true
    setReplacing(false)
  }

  async function save() {
    if (typed === "" || saving) return
    setSaving(true)
    const landed = await autosave.runExplicit([{ op: "set", path: [...field.segments], value: typed }])
    if (!mounted.current) return
    setSaving(false)
    if (landed) closeReplace()
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      closeReplace()
    }
  }

  return (
    <div className="space-y-1">
      <div data-secret-field data-field-path={field.pattern} className="flex max-w-md items-center gap-1">
        {replacing ? (
          <>
            <Input
              ref={input}
              type="password"
              autoComplete="off"
              aria-label={label}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={keyDown}
              className="h-8 min-w-0 flex-1 font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={saveValueName(label)}
              disabled={typed === "" || saving}
              onClick={() => void save()}
            >
              {SAVE_VALUE_LABEL}
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label={keepValueName(label)} onClick={closeReplace}>
              {KEEP_CURRENT_VALUE_LABEL}
            </Button>
          </>
        ) : (
          <>
            <code className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">{maskedText}</code>
            <Button
              ref={replaceButton}
              type="button"
              variant="outline"
              size="xs"
              aria-label={replaceValueName(label)}
              onClick={startReplace}
            >
              {REPLACE_VALUE_LABEL}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
