import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

interface StatCardProps {
  label: string
  value: string
  numericValue?: number
  decimalPlaces?: number
  prefix?: string
  suffix?: string
  description?: string
  icon?: LucideIcon
}

export function StatCard({
  label,
  value,
  numericValue,
  decimalPlaces = 0,
  prefix,
  suffix,
  description,
  icon: Icon,
}: StatCardProps) {
  return (
    <Card className="py-0 gap-0">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="size-4 text-muted-foreground" />}
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
        </div>
        <div className="text-3xl font-bold mt-1">
          {numericValue != null ? (
            <span>{prefix}{numericValue.toFixed(decimalPlaces)}{suffix}</span>
          ) : (
            value
          )}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  )
}
