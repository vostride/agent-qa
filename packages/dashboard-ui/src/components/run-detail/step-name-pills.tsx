import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { DisplayStep } from "@/lib/display-step"

export const SOURCE_LABELS: Record<string, string> = {
  env: 'env (.env file)',
  inline: 'inline (test config)',
  suite: 'suite (suite config)',
  cli: 'cli (--var flag)',
  capture: 'capture (captured from screen)',
  hook: 'hook (hook output)',
  step: 'step (set by agent)',
  runJS: 'runJS (inline JavaScript)',
  runHook: 'runHook uses the stable hook ID from the configured hooks file',
  secret: 'secret (runtime only)',
}

export function pillBgColor(source: string | undefined): string {
  switch (source) {
    case 'env': return 'bg-blue-500/15 border border-blue-500/20'
    case 'capture': return 'bg-emerald-500/15 border border-emerald-500/20'
    case 'cli': return 'bg-purple-500/15 border border-purple-500/20'
    case 'inline': return 'bg-amber-500/15 border border-amber-500/20'
    case 'suite': return 'bg-cyan-500/15 border border-cyan-500/20'
    case 'hook': return 'bg-orange-500/15 border border-orange-500/20'
    case 'step': return 'bg-teal-500/15 border border-teal-500/20'
    case 'runJS': return 'bg-yellow-500/15 border border-yellow-500/20'
    case 'runHook': return 'bg-orange-600/15 border border-orange-600/20'
    case 'secret': return 'bg-rose-500/15 border border-rose-500/20'
    default: return 'bg-accent/20 border border-accent/20'
  }
}

interface TextSegment { type: 'text'; value: string }
interface PillSegment {
  type: 'pill'
  resolvedValue: string
  varName: string
  namespace: string
  templateSyntax: string
}
type Segment = TextSegment | PillSegment

export function parseRedactedSecretSegments(value: string): Segment[] {
  const markerRe = /\[secret:(\w+)\]/g
  const segments: Segment[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = markerRe.exec(value)) !== null) {
    const [marker, varName] = match
    if (match.index > lastIdx) {
      segments.push({ type: 'text', value: value.slice(lastIdx, match.index) })
    }
    segments.push({
      type: 'pill',
      resolvedValue: marker,
      varName,
      namespace: 'secret',
      templateSyntax: `{{secret:${varName}}}`,
    })
    lastIdx = match.index + marker.length
  }

  if (lastIdx < value.length) {
    segments.push({ type: 'text', value: value.slice(lastIdx) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', value }]
}

export function parseSegments(
  original: string,
  resolved: string,
  variableSnapshot: Record<string, { value: string; source: string }> | null
): Segment[] {
  // Collect all template markers from original, in order
  const templateRe = /\{\{(\w+):([^}]*(?:\{[^}]*\}[^}]*)*)\}\}/g
  type Marker = { index: number; fullMatch: string; namespace: string; key: string }
  const markers: Marker[] = []
  let m: RegExpExecArray | null
  while ((m = templateRe.exec(original)) !== null) {
    markers.push({ index: m.index, fullMatch: m[0], namespace: m[1], key: m[2] })
  }

  if (markers.length === 0) {
    return resolved.length > 0 ? [{ type: 'text', value: resolved }] : []
  }

  // Build ordered chunks from the original: literal text + template markers
  type Chunk =
    | { kind: 'literal'; text: string }
    | { kind: 'env'; varName: string; templateSyntax: string }
    | { kind: 'secret'; varName: string; templateSyntax: string }
    | { kind: 'other'; templateSyntax: string }
  const chunks: Chunk[] = []
  let lastIdx = 0
  for (const mk of markers) {
    if (mk.index > lastIdx) {
      chunks.push({ kind: 'literal', text: original.slice(lastIdx, mk.index) })
    }
    if (mk.namespace === 'env') {
      chunks.push({ kind: 'env', varName: mk.key, templateSyntax: mk.fullMatch })
    } else if (mk.namespace === 'secret') {
      chunks.push({ kind: 'secret', varName: mk.key, templateSyntax: mk.fullMatch })
    } else {
      chunks.push({ kind: 'other', templateSyntax: mk.fullMatch })
    }
    lastIdx = mk.index + mk.fullMatch.length
  }
  if (lastIdx < original.length) {
    chunks.push({ kind: 'literal', text: original.slice(lastIdx) })
  }

  // Walk through chunks, consuming the resolved string using known values
  const segments: Segment[] = []
  let pos = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    if (chunk.kind === 'literal') {
      const idx = resolved.indexOf(chunk.text, pos)
      if (idx >= 0) {
        // Any resolved text before this literal (from a preceding non-env template)
        if (idx > pos) {
          segments.push({ type: 'text', value: resolved.slice(pos, idx) })
        }
        if (chunk.text.length > 0) {
          segments.push({ type: 'text', value: chunk.text })
        }
        pos = idx + chunk.text.length
      }
    } else if (chunk.kind === 'env') {
      const snapshotValue = variableSnapshot?.[chunk.varName]?.value ?? null
      const searchTarget = snapshotValue ?? chunk.templateSyntax
      const idx = resolved.indexOf(searchTarget, pos)
      if (idx >= 0) {
        if (idx > pos) {
          segments.push({ type: 'text', value: resolved.slice(pos, idx) })
        }
        if (snapshotValue === null) {
          segments.push({ type: 'text', value: chunk.templateSyntax })
        } else {
          segments.push({
            type: 'pill',
            resolvedValue: searchTarget,
            varName: chunk.varName,
            namespace: 'env',
            templateSyntax: chunk.templateSyntax,
          })
        }
        pos = idx + searchTarget.length
      }
    } else if (chunk.kind === 'secret') {
      const marker = `[secret:${chunk.varName}]`
      const markerIdx = resolved.indexOf(marker, pos)
      const templateIdx = resolved.indexOf(chunk.templateSyntax, pos)
      const searchTarget = markerIdx >= 0 && (templateIdx === -1 || markerIdx <= templateIdx)
        ? marker
        : chunk.templateSyntax
      const idx = resolved.indexOf(searchTarget, pos)
      if (idx >= 0) {
        if (idx > pos) {
          segments.push({ type: 'text', value: resolved.slice(pos, idx) })
        }
        segments.push({
          type: 'pill',
          resolvedValue: marker,
          varName: chunk.varName,
          namespace: 'secret',
          templateSyntax: chunk.templateSyntax,
        })
        pos = idx + searchTarget.length
      } else {
        segments.push({
          type: 'pill',
          resolvedValue: marker,
          varName: chunk.varName,
          namespace: 'secret',
          templateSyntax: chunk.templateSyntax,
        })
      }
    } else if (chunk.kind === 'other') {
      let endIdx = resolved.length
      for (let j = i + 1; j < chunks.length; j++) {
        const next = chunks[j]
        if (next.kind === 'literal') {
          const litIdx = resolved.indexOf(next.text, pos)
          if (litIdx >= 0) { endIdx = litIdx; break }
        } else if (next.kind === 'env') {
          const sv = variableSnapshot?.[next.varName]?.value
          if (sv) {
            const svIdx = resolved.indexOf(sv, pos)
            if (svIdx >= 0) { endIdx = svIdx; break }
          }
        } else if (next.kind === 'secret') {
          const marker = `[secret:${next.varName}]`
          const markerIdx = resolved.indexOf(marker, pos)
          const templateIdx = resolved.indexOf(next.templateSyntax, pos)
          const nextIdx = markerIdx >= 0 && (templateIdx === -1 || markerIdx <= templateIdx)
            ? markerIdx
            : templateIdx
          if (nextIdx >= 0) { endIdx = nextIdx; break }
        }
      }
      const resolvedValue = resolved.slice(pos, endIdx)
      const nsMatch = chunk.templateSyntax.match(/^\{\{(\w+):(.+)\}\}$/)
      const namespace = nsMatch?.[1] ?? 'unknown'
      const key = nsMatch?.[2] ?? chunk.templateSyntax
      segments.push({
        type: 'pill',
        resolvedValue,
        varName: key,
        namespace,
        templateSyntax: chunk.templateSyntax,
      })
      pos = endIdx
    }
  }

  if (pos < resolved.length) {
    segments.push({ type: 'text', value: resolved.slice(pos) })
  }

  return segments
}

export function StepNameWithPills({ step }: { step: DisplayStep }) {
  const segments = step.originalStepName
    ? parseSegments(step.originalStepName, step.name, step.variableSnapshot)
    : parseRedactedSecretSegments(step.name)

  return (
    <span className="flex-1 min-w-0 text-sm break-all">
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>

        const snapshot = step.variableSnapshot?.[seg.varName]
        const sourceLabel = snapshot ? SOURCE_LABELS[snapshot.source] ?? snapshot.source : SOURCE_LABELS[seg.namespace] ?? seg.namespace

        return (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span
                className={cn("rounded-sm px-1 py-px cursor-default", pillBgColor(snapshot?.source ?? seg.namespace))}
                aria-label={`variable: ${seg.varName}`}
              >
                {seg.resolvedValue}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="space-y-1">
                <div className="text-xs font-medium">{seg.varName}</div>
                <div className="text-[10px] font-mono text-muted-foreground">{seg.templateSyntax}</div>
                <div className="text-xs text-muted-foreground truncate">{seg.resolvedValue}</div>
                <div className="text-xs text-muted-foreground">{sourceLabel}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </span>
  )
}
