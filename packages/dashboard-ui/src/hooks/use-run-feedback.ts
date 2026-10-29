import { useEffect, useId, useRef, useState } from 'react'
import type { Mark, RunDetailProjection } from '@vostride/agent-qa-schema'
import type { FeedbackComposerProps } from '@/components/run-detail/feedback-composer'
import type { FeedbackEntryButtonProps } from '@/components/run-detail/feedback-entry'
import type { StepTreeFeedback } from '@/components/run-detail/step-tree'
import {
  fetchMarkPreview,
  fetchMarksHistory,
  type MarkPreviewRead,
  type MarksHistoryRead,
} from '@/lib/api'
import type { MarkDenial, OnMark } from '@/lib/analysis-view'
import {
  DRAFT_KEPT_STATUS,
  EMPTY_DRAFT,
  PREVIEW_DEBOUNCE_MS,
  SENDING_STATUS,
  feedbackAddress,
  feedbackEntryLabel,
  feedbackPreviewState,
  feedbackRecordedText,
  feedbackTargetView,
  formatMarkTime,
  hasUniqueAddress,
  isDraftEmpty,
  pinnedTargetText,
  previewInputFor,
  previewRequestKey,
  resolveHeaderFeedbackTarget,
  submitBlockedReason,
  switchTargetLabel,
  unsentDraftLabel,
  type FeedbackComposerState,
  type FeedbackDraft,
  type FeedbackPlace,
  type FeedbackTarget,
} from '@/lib/feedback-view'
import { memberDisplayName, memberHandleLabel } from '@/lib/run-detail-view'
import { runDetailStepKey, type Selection } from '@/lib/selection'

interface UseRunFeedbackInput {
  runId: string | undefined
  runStatus: string | undefined
  detail: RunDetailProjection | null | undefined
  onMark: OnMark
  markPending: boolean
  selectedStep: { testIndex: number; stepIndex: number } | null
  memberFilter: number | undefined
  /** The page's denial, addressed; shown only on the composer address it names. */
  markDenial?: MarkDenial & FeedbackTarget
  /** The page's guarded runs.detail re-read, called on every open (a mark written elsewhere shows). */
  reloadDetail?: () => Promise<unknown>
  /** The page's selection setter; Show step selects a step without re-targeting. */
  setSelection?: (next: Selection | null) => void
  beforeOpen?: () => void
}

// The local announcement, kept per address so re-targeting shows each address its own.
interface AddressOutcome {
  state: FeedbackComposerState
  status: string
}

const COMPOSING: AddressOutcome = { state: 'composing', status: '' }

function targetOfAddress(address: string): FeedbackTarget {
  const [testIndex, stepIndex] = address.split(':')
  return stepIndex === 'run' ? { testIndex: Number(testIndex) } : { testIndex: Number(testIndex), stepIndex: Number(stepIndex) }
}

/** The last read that landed, with the request key, address and kind it was computed for. */
interface LandedPreview {
  key: string
  address: string
  kind: Mark
  read: MarkPreviewRead
}

// Drafts live above the composer so they survive it closing; nothing is fetched on mount.
export function useRunFeedback({
  runId,
  runStatus,
  detail,
  onMark,
  markPending,
  selectedStep,
  memberFilter,
  markDenial,
  reloadDetail,
  setSelection,
  beforeOpen,
}: UseRunFeedbackInput) {
  const baseId = useId()
  const composerId = `${baseId}-feedback`
  const headingId = `${baseId}-feedback-heading`
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<FeedbackTarget | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyMap<string, FeedbackDraft>>(() => new Map())
  const [landed, setLanded] = useState<LandedPreview>()
  const requestedKey = useRef<string | undefined>(undefined)
  const [retrying, setRetrying] = useState(false)
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, AddressOutcome>>(() => new Map())
  // Each retained address keeps its own denial.
  const [denials, setDenials] = useState<ReadonlyMap<string, MarkDenial>>(() => new Map())
  const [focusRequest, setFocusRequest] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const previewGeneration = useRef(0)
  const [history, setHistory] = useState<MarksHistoryRead>()
  const historyGeneration = useRef(0)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const submission = useRef<object | undefined>(undefined)
  const runRef = useRef(runId)
  const detailRef = useRef(detail)
  useEffect(() => { detailRef.current = detail }, [detail])
  useEffect(() => { if (focusRequest > 0) headingRef.current?.focus() }, [focusRequest])
  useEffect(() => {
    if (markDenial === undefined) return
    setDenials((previous) =>
      new Map(previous).set(feedbackAddress(markDenial), { reason: markDenial.reason }),
    )
  }, [markDenial])

  useEffect(() => {
    runRef.current = runId
    previewGeneration.current += 1
    historyGeneration.current += 1
    setHistory(undefined)
    clearTimeout(previewTimer.current)
    submission.current = undefined
    opener.current = null
    setOpen(false)
    setTarget(null)
    setDrafts(new Map())
    setLanded(undefined)
    requestedKey.current = undefined
    setRetrying(false)
    setOutcomes(new Map())
    setDenials(new Map())
    return () => {
      previewGeneration.current += 1
      historyGeneration.current += 1
      clearTimeout(previewTimer.current)
    }
  }, [runId])

  // No live push: a read for an earlier open or target is dropped when it lands.
  const readHistory = () => {
    const requestRunId = runRef.current
    if (requestRunId === undefined) return
    const generation = ++historyGeneration.current
    void fetchMarksHistory(requestRunId).then((read) => {
      if (historyGeneration.current !== generation || runRef.current !== requestRunId) return
      setHistory(read)
    })
  }

  const address = target === null ? undefined : feedbackAddress(target)
  const draft = (address === undefined ? undefined : drafts.get(address)) ?? EMPTY_DRAFT
  const { state, status } = (address === undefined ? undefined : outcomes.get(address)) ?? COMPOSING
  // While the mark is in flight the draft it sends stays as sent.
  const busy = state === 'submitting'
  const setOutcome = (key: string, next: AddressOutcome) => setOutcomes((previous) => new Map(previous).set(key, next))
  const currentKey = target === null || draft.kind === undefined ? '' : previewRequestKey({ kind: draft.kind, ...target })
  // This address's last read stays on screen while its re-fetch runs, so the section never blanks.
  const shown = landed !== undefined && landed.address === address ? landed : undefined
  const landedOutcome = shown === undefined ? undefined : shown.read.kind === 'read' ? shown.read.result.kind : 'failed'
  const previewCurrent = shown !== undefined && currentKey !== '' && shown.key === currentKey
  const addressable = target === null || hasUniqueAddress(detail, target.testIndex)
  const previewState = !addressable ? 'idle' : feedbackPreviewState({ kind: draft.kind, landed: shown?.read })
  const previewFailure = shown?.read.kind === 'failed' ? shown.read.reason : undefined
  const previewUpdating =
    (previewState !== 'idle' && previewState !== 'loading' && !previewCurrent) || (retrying && previewState === 'failed')
  const submitReason = submitBlockedReason({
    noUniqueAddress: !addressable,
    kind: draft.kind,
    currentKey,
    landedKey: shown?.key,
    landedOutcome,
    inFlight: markPending || state === 'submitting',
  })

  // Every scheduled fetch takes a new generation, so an answer for anything earlier is dropped.
  const schedulePreview = (
    next: FeedbackTarget,
    kind: Mark,
    delay: number = PREVIEW_DEBOUNCE_MS,
  ) => {
    clearTimeout(previewTimer.current)
    setRetrying(false)
    const generation = ++previewGeneration.current
    const key = previewRequestKey({ kind, ...next })
    requestedKey.current = key
    // A test `onMark` would refuse is never previewed either.
    if (!hasUniqueAddress(detailRef.current, next.testIndex)) return
    const fire = () => {
      if (previewGeneration.current !== generation) return
      const requestRunId = runRef.current
      const previewMember = detailRef.current?.members.find((entry) => entry.testIndex === next.testIndex)
      if (requestRunId === undefined || previewMember === undefined) return
      const requestAddress = feedbackAddress(next)
      void fetchMarkPreview(requestRunId, previewInputFor(previewMember, next, kind)).then((read) => {
        if (previewGeneration.current !== generation || runRef.current !== requestRunId) return
        setRetrying(false)
        setLanded({ key, address: requestAddress, kind, read })
      })
    }
    if (delay === 0) fire()
    else previewTimer.current = setTimeout(fire, delay)
  }

  // Retry asks again for the form as it is, at once; the failed block stays, busy, until it lands.
  const retryPreview = () => {
    if (target === null || draft.kind === undefined || busy) return
    schedulePreview(target, draft.kind, 0)
    setRetrying(true)
  }

  // A request key that was not asked for yet is fetched; a note never changes the key.
  useEffect(() => {
    if (!open || target === null || draft.kind === undefined || busy) return
    if (requestedKey.current === currentKey) return
    schedulePreview(target, draft.kind)
    // schedulePreview reads the latest render; the request key is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentKey])

  // Re-activating the entry already open keeps it open and refocuses the heading.
  const openFeedback = (next: FeedbackTarget, openerElement: HTMLElement) => {
    beforeOpen?.()
    opener.current = openerElement
    void reloadDetail?.().catch(() => undefined)
    readHistory()
    const nextAddress = feedbackAddress(next)
    if (address !== nextAddress) {
      previewGeneration.current += 1
      const kind = drafts.get(nextAddress)?.kind
      if (kind === undefined) clearTimeout(previewTimer.current)
      else schedulePreview(next, kind)
    }
    setTarget(next)
    setOpen(true)
    setFocusRequest((count) => count + 1)
  }

  // The composer moves to another test's address; the page's member filter and selection stay.
  const retarget = (next: FeedbackTarget) => {
    const nextAddress = feedbackAddress(next)
    if (state === 'submitting' || nextAddress === address) return
    previewGeneration.current += 1
    setTarget(next)
    setFocusRequest((count) => count + 1)
    readHistory()
    const kind = drafts.get(nextAddress)?.kind
    if (kind === undefined) clearTimeout(previewTimer.current)
    else schedulePreview(next, kind)
  }

  // Closing keeps drafts; focus returns to the opener, else the header entry, else the active tab.
  const close = () => {
    setOpen(false)
    const back = opener.current?.isConnected
      ? opener.current
      : (document.querySelector<HTMLElement>('[data-feedback-entry="test"]') ??
        document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))
    back?.focus()
  }

  // A form edit returns the address to composing.
  const composeAt = (key: string) => {
    setOutcome(key, COMPOSING)
  }

  const editNote = (note: string) => {
    if (address === undefined || busy) return
    setDrafts((previous) => new Map(previous).set(address, { ...(previous.get(address) ?? EMPTY_DRAFT), note }))
    composeAt(address)
  }

  const choose = (kind: Mark) => {
    if (target === null || address === undefined || busy) return
    setDrafts((previous) => new Map(previous).set(address, { ...(previous.get(address) ?? EMPTY_DRAFT), kind }))
    composeAt(address)
    schedulePreview(target, kind)
  }

  const submit = async () => {
    if (target === null || address === undefined || draft.kind === undefined || submitReason !== '' || submission.current) return
    const request = {}
    const submitted = target
    submission.current = request
    setOutcome(address, { state: 'submitting', status: SENDING_STATUS })
    setDenials((previous) => {
      const next = new Map(previous)
      next.delete(address)
      return next
    })
    try {
      const result = await onMark(submitted.testIndex, submitted.stepIndex, draft.kind, draft.note || undefined)
      if (submission.current !== request) return
      if (result === 'refreshed') {
        setDrafts((previous) => {
          const next = new Map(previous)
          next.delete(address)
          return next
        })
        setLanded(undefined)
        setOutcome(address, { state: 'recorded', status: '' })
        readHistory()
      } else if (result === 'retained') {
        setOutcome(address, { state: 'retained', status: DRAFT_KEPT_STATUS })
      } else {
        setOutcome(address, COMPOSING)
      }
    } finally {
      if (submission.current === request) submission.current = undefined
    }
  }

  // The receipt is read from the refreshed projection, never from the POST's answer.
  const recordedMark = state !== 'recorded' || target === null
    ? undefined
    : detail?.members.find((entry) => entry.testIndex === target.testIndex)
      ?.marks?.find((entry) => entry.stepIndex === target.stepIndex)
  const statusText = state === 'recorded' ? (recordedMark === undefined ? '' : feedbackRecordedText(recordedMark.disposition)) : status

  // An earlier mark's time is its history entry's own, absent until history holds it.
  const historyEntries = history?.kind === 'read' && history.result.kind === 'history' ? history.result.entries : []
  const timeFor = (markId: string) => formatMarkTime(historyEntries.find((entry) => entry.markId === markId)?.markedAt)

  const view = target === null ? undefined : feedbackTargetView({ detail, target, runStatus })
  const members = detail?.members ?? []
  const testSwitcher = target === null || target.stepIndex !== undefined || members.length <= 1
    ? undefined
    : {
        value: target.testIndex,
        options: members.map((entry) => ({
          testIndex: entry.testIndex,
          label: `${memberDisplayName(entry)} ${memberHandleLabel(entry.testIndex)}`,
        })),
        onChange: (testIndex: number) => retarget({ testIndex }),
      }

  // Only an explicit act sets the target; the selection it opened from may move on.
  const suite = (detail?.members.length ?? 0) > 1
  const placeMember = (testIndex: number) =>
    suite ? (members.find((entry) => entry.testIndex === testIndex) ?? { testIndex }) : undefined
  const viewing = selectedStep
  const showPinned = target !== null && viewing !== null && (
    target.stepIndex === undefined ? viewing.testIndex !== target.testIndex : feedbackAddress(viewing) !== address
  )
  const pinned = !showPinned || target === null || viewing === null
    ? undefined
    : {
        text: pinnedTargetText(
          { stepIndex: viewing.stepIndex, member: placeMember(viewing.testIndex) },
          { stepIndex: target.stepIndex, member: placeMember(target.testIndex) },
        ),
        switchLabel: switchTargetLabel(
          target.stepIndex === undefined
            ? { member: placeMember(viewing.testIndex) }
            : { stepIndex: viewing.stepIndex, member: viewing.testIndex === target.testIndex ? undefined : placeMember(viewing.testIndex) },
        ),
        onSwitch: () => retarget(target.stepIndex === undefined ? { testIndex: viewing.testIndex } : viewing),
      }

  const placeOf = (other: FeedbackTarget): FeedbackPlace => ({
    stepIndex: other.stepIndex,
    member: other.stepIndex !== undefined && other.testIndex === target?.testIndex ? undefined : placeMember(other.testIndex),
  })

  const unsentDrafts = [...drafts]
    .filter(([key, entry]) => key !== address && !isDraftEmpty(entry))
    .map(([key]) => {
      const other = targetOfAddress(key)
      return { address: key, label: unsentDraftLabel(placeOf(other)), onOpen: () => retarget(other) }
    })

  const denial = state === 'retained' && address !== undefined ? denials.get(address) : undefined

  const composer: FeedbackComposerProps | undefined = !open || target === null || address === undefined || view === undefined
    ? undefined
    : {
        composerId,
        headingId,
        heading: view.heading,
        scopeLine: view.scopeLine,
        state,
        scope: target.stepIndex === undefined ? 'test' : 'step',
        target: address,
        outcomeClass: view.outcomeClass,
        selected: draft.kind,
        onChoose: choose,
        noUniqueAddress: !addressable,
        testSwitcher,
        pinned,
        unsentDrafts,
        note: draft.note,
        onNoteChange: editNote,
        previewState,
        previewCurrent,
        previewRead: shown?.read.kind === 'read' ? shown.read.result : undefined,
        previewUpdating,
        previewFailure,
        onPreviewRetry: retryPreview,
        timeFor,
        history: {
          read: history,
          detail,
          newMarkId: recordedMark?.markId,
          onRetry: readHistory,
        },
        stepCount: view.stepCount,
        testId: members.find((entry) => entry.testIndex === target.testIndex)?.testId,
        onShowStep: (stepIndex: number) => {
          setSelection?.({ type: 'step', stepId: runDetailStepKey(target.testIndex, stepIndex) })
        },
        submitReason,
        onSubmit: () => { void submit() },
        status: statusText,
        denial,
        headingRef,
        onClose: close,
      }

  // One test-level door per page; absent until the target member's marks land, never disabled.
  const headerTarget = resolveHeaderFeedbackTarget({ detail, selectedStep, memberFilter, runStatus })
  const headerMember = headerTarget === undefined
    ? undefined
    : detail?.members.find((entry) => entry.testIndex === headerTarget.testIndex)
  const headerMark = headerMember?.marks?.find((entry) => entry.stepIndex === undefined)
  const headerEntry: Omit<FeedbackEntryButtonProps, 'scope'> | undefined =
    headerTarget === undefined || headerMember?.marks === undefined
      ? undefined
      : {
          label: feedbackEntryLabel({
            scope: 'test',
            ...(suite ? { memberName: memberDisplayName(headerMember), handle: memberHandleLabel(headerMember.testIndex) } : {}),
            ...(headerMark === undefined ? {} : { markedChoice: headerMark.kind }),
          }),
          target: feedbackAddress(headerTarget),
          marked: headerMark !== undefined,
          expanded: open && target?.stepIndex === undefined,
          controls: composerId,
          onOpen: (openerElement: HTMLElement) => openFeedback(headerTarget, openerElement),
        }

  const openStepFeedback = (testIndex: number, stepIndex: number, openerElement: HTMLElement) =>
    openFeedback({ testIndex, stepIndex }, openerElement)

  // The step door on the row owning the selection opens the composer on that row's step.
  const tree: StepTreeFeedback = {
    composerId,
    expandedAddress: open && target?.stepIndex !== undefined ? address : undefined,
    onOpenStep: openStepFeedback,
  }

  return { open, target, composerId, openFeedback, openStepFeedback, retarget, composer, headerEntry, tree }
}
