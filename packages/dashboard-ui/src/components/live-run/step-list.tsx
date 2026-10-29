import { LiveStepRowView } from '@/components/live-step-row'
import { liveRowShown } from '@/lib/live-step-row'
import type { MemberRow, LiveStepRow } from '@/lib/run-stream-reducer'

// Status-only and inert: the props carry no field for reasoning, and only rows with text are drawn.

/** The honest word for a live steps pane that has no row yet. */
export const STEPS_EMPTY_TEXT = 'waiting for the first step'

export interface StepListProps {
  members: readonly MemberRow[]
  steps: readonly LiveStepRow[]
  terminal: boolean
}

export function StepList({ members, steps, terminal }: StepListProps) {
  const memberIndices = [...new Set([...members.map((m) => m.testIndex), ...steps.map((s) => s.testIndex)])].sort(
    (a, b) => a - b,
  )
  const anyMemberSettled = members.some((member) => member.outcome !== undefined || member.note !== undefined)
  // The empty state is a claim about a LIVE stream that has produced no row. Once a member has
  // settled, `did not run` is the honest word and "waiting" would be a lie about a member that is
  // never going to start.
  const drawnRows = (testIndex: number) =>
    steps.filter((row) => row.testIndex === testIndex && liveRowShown(row))
  const drawnCount = steps.filter(liveRowShown).length
  const showEmpty = drawnCount === 0 && !anyMemberSettled && !terminal
  const showMemberHeaders = memberIndices.length > 1

  if (showEmpty) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p data-steps-empty className="p-6 text-sm text-muted-foreground">
          {STEPS_EMPTY_TEXT}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {memberIndices.map((testIndex) => {
        const member = members.find((item) => item.testIndex === testIndex)
        const rows = drawnRows(testIndex)
        return (
          <div key={testIndex} data-member={String(testIndex)}>
            {showMemberHeaders ? (
              <h3 className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs font-medium">
                <span className="min-w-0 truncate">{member?.name || `member ${String(testIndex)}`}</span>
                {member?.note !== undefined && (
                  <span data-member-note className="shrink-0 text-muted-foreground">
                    {member.note}
                  </span>
                )}
                {member?.outcome !== undefined && (
                  <span data-member-outcome={member.outcome} className="shrink-0 text-muted-foreground">
                    {member.outcome}
                  </span>
                )}
              </h3>
            ) : (
              member?.note !== undefined && (
                <p data-member-note className="px-3 py-2 text-sm text-muted-foreground">
                  {member.note}
                </p>
              )
            )}
            {rows.length > 0 && (
              <ul className="flex flex-col">
                {rows.map((row) => (
                  <LiveStepRowView key={`${String(row.testIndex)}:${String(row.stepIndex)}`} row={row} />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
