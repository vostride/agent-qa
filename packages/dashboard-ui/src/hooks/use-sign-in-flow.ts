// Poll timers live in refs and clear on every exit; the manual code passes once to `submitCode`.

import { useCallback, useEffect, useRef, useState } from "react"

import { exchangePluginAuthCode, pollPluginAuthResult, startPluginAuth } from "@/lib/api"

export type SignInState = "idle" | "waiting" | "awaiting-code" | "completed" | "timed-out" | "failed"

export type SignInMode = "browser-poll" | "manual-code"

export interface SignInCompletion {
  provider: string
  name: string
  created: boolean
}

export interface SignInFlowOptions {
  onCompleted?: (completion: SignInCompletion) => void
}

export interface SignInFlow {
  state: SignInState
  mode?: SignInMode
  /** Why the sign-in didn't finish, when state is failed. */
  reason?: string
  /** The server's refusal code, when the start or the exchange was refused. */
  code?: string
  /** Whether the sign-in created the credential under its name (Plan 09's answer). */
  created?: boolean
  exchanging: boolean
  start: (provider: string, name: string) => Promise<void>
  submitCode: (code: string) => Promise<void>
  cancel: () => void
}

export const SIGN_IN_POLL_INTERVAL_MS = 2000
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

interface Session {
  provider: string
  name: string
  sessionId: string
  created: boolean
}

interface Snapshot {
  state: SignInState
  mode?: SignInMode
  reason?: string
  code?: string
  created?: boolean
}

const FALLBACK_REASON = "the sign-in could not be completed."

function failureOf(error: unknown): { reason: string; code?: string } {
  const payload = (error as { payload?: Record<string, unknown> | null } | null)?.payload
  const code = payload && typeof payload.error === "string" ? payload.error : undefined
  const message = payload && typeof payload.message === "string" ? payload.message : undefined
  const reason = message ?? (error instanceof Error && error.message !== "" ? error.message : FALLBACK_REASON)
  return { reason, ...(code === undefined ? {} : { code }) }
}

export function useSignInFlow(options: SignInFlowOptions = {}): SignInFlow {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: "idle" })
  const [exchanging, setExchanging] = useState(false)
  const interval = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const session = useRef<Session | undefined>(undefined)
  // Each start, cancel and unmount moves the generation on, so an answer from an older flow is ignored.
  const generation = useRef(0)
  const polling = useRef(false)
  const onCompleted = useRef(options.onCompleted)

  useEffect(() => {
    onCompleted.current = options.onCompleted
  })

  const clearTimers = useCallback(() => {
    if (interval.current !== undefined) window.clearInterval(interval.current)
    if (timeout.current !== undefined) window.clearTimeout(timeout.current)
    interval.current = undefined
    timeout.current = undefined
    polling.current = false
  }, [])

  useEffect(() => {
    return () => {
      generation.current += 1
      clearTimers()
      session.current = undefined
    }
  }, [clearTimers])

  const complete = useCallback(
    (done: Session) => {
      clearTimers()
      session.current = undefined
      setSnapshot({ state: "completed", created: done.created })
      onCompleted.current?.({ provider: done.provider, name: done.name, created: done.created })
    },
    [clearTimers],
  )

  const fail = useCallback(
    (failure: { reason: string; code?: string }) => {
      clearTimers()
      session.current = undefined
      setSnapshot({ state: "failed", ...failure })
    },
    [clearTimers],
  )

  const start = useCallback(
    async (provider: string, name: string) => {
      clearTimers()
      generation.current += 1
      const id = generation.current
      session.current = undefined
      setExchanging(false)
      setSnapshot({ state: "waiting" })
      let started: Awaited<ReturnType<typeof startPluginAuth>>
      try {
        started = await startPluginAuth(provider, name)
      } catch (error) {
        if (generation.current === id) fail(failureOf(error))
        return
      }
      if (generation.current !== id) return
      const current: Session = { provider, name, sessionId: started.sessionId, created: started.created === true }
      session.current = current
      window.open(started.authorizeUrl, "_blank", "noopener,noreferrer")

      if (started.mode === "manual-code") {
        setSnapshot({ state: "awaiting-code", mode: "manual-code", created: current.created })
        return
      }

      setSnapshot({ state: "waiting", mode: "browser-poll", created: current.created })
      interval.current = setInterval(() => {
        if (polling.current) return
        polling.current = true
        pollPluginAuthResult(provider, current.sessionId).then(
          (result) => {
            polling.current = false
            if (generation.current !== id) return
            if (result.status === "completed") complete(current)
            else if (result.status === "error") fail({ reason: result.error ?? FALLBACK_REASON })
          },
          () => {
            // A poll that could not reach the server is retried on the next tick.
            polling.current = false
          },
        )
      }, SIGN_IN_POLL_INTERVAL_MS)
      timeout.current = setTimeout(() => {
        if (generation.current !== id) return
        clearTimers()
        session.current = undefined
        setSnapshot({ state: "timed-out", mode: "browser-poll" })
      }, SIGN_IN_TIMEOUT_MS)
    },
    [clearTimers, complete, fail],
  )

  const submitCode = useCallback(
    async (code: string) => {
      const current = session.current
      const trimmed = code.trim()
      if (current === undefined || trimmed === "") return
      const id = generation.current
      setExchanging(true)
      try {
        await exchangePluginAuthCode(current.provider, current.sessionId, trimmed)
      } catch (error) {
        if (generation.current !== id) return
        setExchanging(false)
        fail(failureOf(error))
        return
      }
      if (generation.current !== id) return
      setExchanging(false)
      complete(current)
    },
    [complete, fail],
  )

  const cancel = useCallback(() => {
    generation.current += 1
    clearTimers()
    session.current = undefined
    setExchanging(false)
    setSnapshot({ state: "idle" })
  }, [clearTimers])

  return { ...snapshot, exchanging, start, submitCode, cancel }
}
