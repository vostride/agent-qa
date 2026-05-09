import { Label } from "@/components/ui/label"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

export interface ConfigSectionProps {
  getIn: (path: string[]) => unknown
  onChange: (path: string[], value: unknown) => void
  onDelete: (path: string[]) => void
  disabled: boolean
}

const PLATFORMS = [
  { value: "web", label: "Web" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
]

export function PlatformSection({
  getIn,
  onChange,
  onDelete,
}: ConfigSectionProps) {
  const platform = getIn(["config", "platform"]) as string | undefined

  function handleChange(value: string) {
    const prev = platform
    onChange(["config", "platform"], value)

    if (prev === "web" && value !== "web") {
      onDelete(["config", "browser"])
    }
    if ((prev === "android" || prev === "ios") && value === "web") {
      onDelete(["config", "device"])
    }
  }

  return (
    <div className="space-y-2">
      <Label>Platform</Label>
      <Select value={platform ?? ""} onValueChange={handleChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select platform" />
        </SelectTrigger>
        <SelectContent>
          {PLATFORMS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
