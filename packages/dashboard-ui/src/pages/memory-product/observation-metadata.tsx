import { PopoverContent } from "@/components/ui/popover"
import type {
  MemoryAtlasObservation,
  MemoryObservationReference,
  MemoryWorkspaceObservation,
} from "@/lib/api"
import { formatDateShort } from "@/lib/utils"

interface ObservationMetadataProps {
  observation: MemoryAtlasObservation | MemoryWorkspaceObservation
  onRequestClose?: () => void
}

export function ObservationMetadata({
  observation,
  onRequestClose,
}: ObservationMetadataProps) {
  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={10}
      className="w-fit min-w-[22rem] max-w-[calc(100vw-2rem)] space-y-4 rounded-xl border border-border/70 bg-popover p-5 shadow-xl"
      onEscapeKeyDown={() => onRequestClose?.()}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div className="space-y-3">
        {isWorkspaceObservation(observation) && observation.scopeRef ? (
          <ReferenceRow label="Scope reference" reference={observation.scopeRef} />
        ) : null}
        {isWorkspaceObservation(observation) && observation.sourceTestRef ? (
          <ReferenceRow label="Source test" reference={observation.sourceTestRef} />
        ) : (
          <MetadataRow label="Source test" value={observation.source_test} mono />
        )}
        <MetadataRow label="Trust" value={observation.trust.toFixed(2)} mono />
        <MetadataRow
          label="Created"
          value={formatDateShort(observation.created)}
          mono
        />
        {isWorkspaceObservation(observation) ? (
          <MetadataRow
            label="Updated"
            value={formatDateShort(observation.updated)}
            mono
          />
        ) : null}
        <MetadataRow
          label="Last confirmed"
          value={formatDateShort(observation.last_confirmed)}
          mono
        />
        {!isWorkspaceObservation(observation) && observation.scope !== "product" ? (
          <MetadataRow label="Scope id" value={observation.scopeId} mono />
        ) : null}
      </div>
    </PopoverContent>
  )
}

function ReferenceRow({
  label,
  reference,
}: {
  label: string
  reference: MemoryObservationReference
}) {
  const content = (
    <span className="block min-w-0 space-y-1 text-right">
      <span className="block text-sm leading-tight text-foreground">
        {reference.label}
      </span>
      {reference.targetName ? (
        <span className="block break-words font-mono text-[11px] leading-tight text-muted-foreground">
          {reference.targetName}
        </span>
      ) : null}
    </span>
  )

  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-4 text-sm">
      <span className="pt-0.5 text-xs text-muted-foreground">{label}</span>
      {reference.href ? (
        <a href={reference.href} className="block min-w-0 text-right hover:underline">
          {content}
        </a>
      ) : (
        content
      )}
    </div>
  )
}

function MetadataRow({
  label,
  mono = false,
  value,
}: {
  label: string
  mono?: boolean
  value: string
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-4 text-sm">
      <span className="pt-0.5 text-xs text-muted-foreground">{label}</span>
      <span
        className={
          mono
            ? "min-w-0 break-words text-right font-mono text-[13px] text-foreground"
            : "min-w-0 break-words text-right text-sm text-foreground"
        }
      >
        {value}
      </span>
    </div>
  )
}

function isWorkspaceObservation(
  observation: MemoryAtlasObservation | MemoryWorkspaceObservation,
): observation is MemoryWorkspaceObservation {
  return "updated" in observation
}
