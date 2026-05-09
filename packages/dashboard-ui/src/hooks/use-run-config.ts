import { useState, useEffect } from "react"
import { fetchConfig } from "@/lib/api"

interface RunConfig {
  defaultRunMode: "local" | "farm"
  hasFarm: boolean
  isLoading: boolean
}

let cached: { defaultRunMode: "local" | "farm"; hasFarm: boolean } | null = null
let pendingPromise: Promise<void> | null = null

export function useRunConfig(): RunConfig {
  const [config, setConfig] = useState<RunConfig>(() =>
    cached
      ? { ...cached, isLoading: false }
      : { defaultRunMode: "local", hasFarm: false, isLoading: true },
  )

  useEffect(() => {
    if (cached) {
      setConfig({ ...cached, isLoading: false })
      return
    }

    if (!pendingPromise) {
      pendingPromise = fetchConfig()
        .then((res) => {
          const cfg = res.config as Record<string, unknown>
          const farm = cfg.farm as Record<string, unknown> | undefined
          cached = {
            defaultRunMode:
              (cfg.defaultRunMode as string) === "farm" ? "farm" : "local",
            hasFarm: !!(farm?.provider),
          }
        })
        .catch(() => {
          cached = { defaultRunMode: "local", hasFarm: false }
        })
        .finally(() => {
          pendingPromise = null
        })
    }

    pendingPromise.then(() => {
      setConfig({ ...cached!, isLoading: false })
    })
  }, [])

  return config
}
