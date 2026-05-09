import { useState, useEffect } from "react"
import { normalizeTimestamp } from "@/lib/utils"

export function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() => {
    const start = new Date(normalizeTimestamp(startedAt)).getTime()
    return Math.max(0, Math.floor((Date.now() - start) / 1000))
  })

  useEffect(() => {
    const start = new Date(normalizeTimestamp(startedAt)).getTime()
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [startedAt])

  const min = Math.floor(elapsed / 60)
  const sec = elapsed % 60
  return <span className="text-blue-500 tabular-nums">{min}m {sec}s</span>
}
