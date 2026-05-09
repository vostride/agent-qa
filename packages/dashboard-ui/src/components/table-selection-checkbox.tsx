import type { FocusEvent, MouseEvent } from "react"

import { Checkbox } from "@/components/ui/checkbox"

interface SelectionCheckboxCellProps {
  checked: boolean | "indeterminate"
  onCheckedChange: (checked: boolean) => void
  ariaLabel?: string
}

export function SelectionCheckboxCell({
  checked,
  onCheckedChange,
  ariaLabel,
}: SelectionCheckboxCellProps) {
  function handleHitAreaClick(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation()

    if (
      event.target instanceof Element &&
      event.target.closest('[data-slot="checkbox"]')
    ) {
      return
    }

    onCheckedChange(checked !== true)
  }

  function stopRowFocus(event: FocusEvent<HTMLDivElement>) {
    event.stopPropagation()
  }

  return (
    <div
      data-selection-checkbox-hit-area
      className="relative z-10 flex min-h-8 min-w-8 items-center justify-center -my-1 -mx-2 px-2 py-1"
      onPointerDown={(event) => event.stopPropagation()}
      onFocus={stopRowFocus}
      onClick={handleHitAreaClick}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        onClick={(event) => event.stopPropagation()}
        aria-label={ariaLabel ?? "Select row"}
      />
    </div>
  )
}
