import { useState } from "react"
import { Check, Copy } from "lucide-react"

export function IdBadge({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const truncated = value.length > 16 ? value.slice(0, 16) + '\u2026' : value
  const handleCopy = () => {
    navigator.clipboard.writeText(value).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted/50 text-muted-foreground hover:text-foreground border border-border/50 transition-colors cursor-pointer"
    >
      <span className="opacity-60">{label}:</span>
      <span>{truncated}</span>
      {copied ? <Check className="h-2.5 w-2.5 text-emerald-400" /> : <Copy className="h-2.5 w-2.5 opacity-40" />}
    </button>
  )
}
