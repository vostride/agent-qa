import { useMemo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { pillBgColor, SOURCE_LABELS } from '@/components/run-detail/step-name-pills'
import { cn } from '@/lib/utils'

interface AuthoringSegment {
  type: 'text' | 'pill'
  value?: string
  namespace?: string
  varName?: string
  templateSyntax?: string
}

const templateRe = /\{\{(\w+):([^}]*(?:\{[^}]*\}[^}]*)*)\}\}/g

function parseAuthoringSegments(text: string): AuthoringSegment[] {
  const segments: AuthoringSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const re = new RegExp(templateRe.source, templateRe.flags)

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({
      type: 'pill',
      namespace: match[1],
      varName: match[2],
      templateSyntax: match[0],
    })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments
}

export function hasTemplateVars(text: string): boolean {
  return /\{\{\w+:/.test(text)
}

function stripTemplateQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

interface StepPillPreviewProps {
  text: string
  envValues?: Record<string, string>
  hookLabels?: Record<string, string>
}

export function StepPillPreview({ text, envValues, hookLabels }: StepPillPreviewProps) {
  const segments = useMemo(() => parseAuthoringSegments(text), [text])

  if (segments.length === 0 || segments.every((s) => s.type === 'text')) return null

  return (
    <div className="flex flex-wrap items-center gap-0.5 text-[13px] text-muted-foreground leading-relaxed">
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (() => {
          const rawValue = seg.varName ?? ''
          const normalizedValue = seg.namespace === 'runHook'
            ? stripTemplateQuotes(rawValue)
            : rawValue
          const displayValue = seg.namespace === 'runHook'
            ? hookLabels?.[normalizedValue] ?? normalizedValue
            : rawValue

          return (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className={cn('rounded-sm px-1 py-px cursor-default text-foreground', pillBgColor(seg.namespace))}
                  aria-label={`variable: ${displayValue}`}
                >
                  {displayValue}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <div className="space-y-1">
                  <div className="text-xs font-medium">{displayValue}</div>
                  {seg.namespace === 'runHook' && (
                    <div className="text-[10px] font-mono text-muted-foreground">{normalizedValue}</div>
                  )}
                  <div className="text-[10px] font-mono text-muted-foreground">{seg.templateSyntax}</div>
                  {envValues?.[rawValue] && (
                    <div className="text-xs text-muted-foreground truncate">
                      {envValues[rawValue]}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {SOURCE_LABELS[seg.namespace ?? ''] ?? seg.namespace}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })(),
      )}
    </div>
  )
}
