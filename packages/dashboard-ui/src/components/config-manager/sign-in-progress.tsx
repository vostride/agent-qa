// The typed code lives in this component's state only and is sent once.

import { useId, useState } from "react"
import { ExternalLink, LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SignInFlow } from "@/hooks/use-sign-in-flow"
import {
  ADD_FLOW_FIELD_LABELS,
  CANCEL_SIGN_IN_LABEL,
  CONNECTING_LABEL,
  CONNECT_LABEL,
  SIGN_IN_TIMED_OUT_TEXT,
  SIGN_IN_WAITING_LABEL,
  SIGN_IN_WAITING_TEXT,
  signInFailedText,
} from "@/lib/config-copy"
import type { TestResult } from "@/lib/config-tabs"

/** A sign-in is under way: waiting for the provider page, or for the code it shows. */
export function signInActive(flow: SignInFlow): boolean {
  return flow.state === "waiting" || flow.state === "awaiting-code" || flow.exchanging
}

/** The connection line a sign-in that didn't finish leaves behind; the test's own line otherwise. */
export function signInLine(flow: SignInFlow): { state: TestResult; sentence: string } | undefined {
  if (flow.state === "failed") return { state: "failed", sentence: signInFailedText(flow.reason ?? "") }
  if (flow.state === "timed-out") return { state: "failed", sentence: SIGN_IN_TIMED_OUT_TEXT }
  return undefined
}

interface SignInButtonProps {
  flow: SignInFlow
  label: string
  variant: "default" | "outline"
  size: "default" | "sm"
  onStart: () => void
  [data: `data-${string}`]: boolean | string | undefined
}

/** Opens the provider page; while it waits for the page it reads Waiting for sign-in… and is aria-disabled. */
export function SignInButton({ flow, label, variant, size, onStart, ...rest }: SignInButtonProps) {
  const waiting = flow.state === "waiting"
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-disabled={waiting ? true : undefined}
      onClick={() => {
        if (!waiting && !flow.exchanging) onStart()
      }}
      {...rest}
    >
      {waiting ? (
        <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <ExternalLink className="size-3.5" aria-hidden="true" />
      )}
      {waiting ? SIGN_IN_WAITING_LABEL : label}
    </Button>
  )
}

function CancelLink({ flow }: { flow: SignInFlow }) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      data-cancel-sign-in
      className="h-auto px-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      onClick={flow.cancel}
    >
      {CANCEL_SIGN_IN_LABEL}
    </Button>
  )
}

/** The waiting line (browser-poll) or the code field and its Connect (manual-code); nothing otherwise. */
export function SignInProgress({ flow }: { flow: SignInFlow }) {
  const inputId = useId()
  const [code, setCode] = useState("")

  if (flow.state === "waiting" && flow.mode !== "manual-code") {
    return (
      <p data-sign-in-waiting className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>{SIGN_IN_WAITING_TEXT}</span>
        <CancelLink flow={flow} />
      </p>
    )
  }

  if (flow.state !== "awaiting-code") return null

  async function submit() {
    if (code.trim() === "" || flow.exchanging) return
    const typed = code
    setCode("")
    await flow.submitCode(typed)
  }

  return (
    <div data-sign-in-code className="space-y-2">
      <Label htmlFor={inputId}>{ADD_FLOW_FIELD_LABELS.signInCode}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={code}
          readOnly={flow.exchanging}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            }
          }}
          className="w-full max-w-md font-mono"
        />
        <Button
          type="button"
          data-sign-in-code-connect
          aria-disabled={flow.exchanging ? true : undefined}
          onClick={() => void submit()}
        >
          {flow.exchanging ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}
          {flow.exchanging ? CONNECTING_LABEL : CONNECT_LABEL}
        </Button>
      </div>
      <CancelLink flow={flow} />
    </div>
  )
}
