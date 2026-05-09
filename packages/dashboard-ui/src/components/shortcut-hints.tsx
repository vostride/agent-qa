import { cn } from "@/lib/utils"

export function ShortcutKey({
  shortcut,
  className,
}: {
  shortcut: string
  className?: string
}) {
  return (
    <kbd
      className={cn(
        "text-[10px] font-mono px-1.5 py-0.5 rounded border bg-muted text-muted-foreground",
        className,
      )}
    >
      {shortcut}
    </kbd>
  )
}

export interface ShortcutHint {
  key: string
  label: string
}

export function ShortcutLegend({ hints }: { hints: ShortcutHint[] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
      {hints.map((hint) => (
        <div key={hint.key} className="contents">
          <ShortcutKey shortcut={hint.key} />
          <span className="text-xs text-muted-foreground">{hint.label}</span>
        </div>
      ))}
    </div>
  )
}
