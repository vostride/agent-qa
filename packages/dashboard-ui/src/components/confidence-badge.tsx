import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface ConfidenceBadgeProps {
  confidence: number
}

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  const pct = Math.round(confidence * 100)

  const colorClass =
    pct > 80
      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
      : pct >= 50
        ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
        : "bg-red-500/10 text-red-500 border-red-500/20"

  return (
    <Badge variant="outline" className={cn("text-xs font-mono", colorClass)}>
      {pct}%
    </Badge>
  )
}
