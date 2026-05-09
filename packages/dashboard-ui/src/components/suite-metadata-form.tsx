import { Link } from 'react-router'
import { useRef, useState } from 'react'
import { RefreshCw, Info, Globe, Smartphone } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { generateSuiteId } from '@/lib/generate-suite-id'
import { useTargets } from '@/hooks/use-targets'
import { useTargetDetails } from '@/hooks/use-target-details'
import { StepPillPreview, hasTemplateVars } from '@/components/step-pill-preview'
import { useStepAutocomplete } from '@/components/step-autocomplete'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[250px] text-[13px]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

interface SuiteMetadataFormProps {
  name: string
  suiteId: string
  target: string
  context: string
  isCreateMode: boolean
  suggestions: VariableSuggestion[]
  hookLabels?: Record<string, string>
  onChange: (field: string, value: string | string[]) => void
  disabled?: boolean
}

export function SuiteMetadataForm({
  name,
  suiteId,
  target,
  context,
  isCreateMode,
  suggestions,
  hookLabels = {},
  onChange,
  disabled = false,
}: SuiteMetadataFormProps) {
  const { targets, isLoading: isLoadingTargets } = useTargets()
  const { targets: targetDetails } = useTargetDetails()
  const selectedDetail = target ? targetDetails[target] : undefined
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursorPos, setCursorPos] = useState(0)

  const autocomplete = useStepAutocomplete({
    text: context,
    cursorPos,
    suggestions,
    anchorRef: textareaRef,
    onInsert: (fullSyntax, start, end) => {
      const next = context.slice(0, start) + fullSyntax + context.slice(end)
      onChange('context', next)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
  })

  const hasTargets = !isLoadingTargets && targets.length > 0

  return (
    <div className="space-y-3">
      {/* Suite Name */}
      <div className="space-y-1.5">
        <Label htmlFor="suite-name" className="text-xs flex items-center gap-1">
          Suite Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="suite-name"
          value={name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="My Suite"
          required
          disabled={disabled}
          className="h-8 text-sm"
        />
      </div>

      {/* Suite ID */}
      <div className="space-y-1.5">
        <Label htmlFor="suite-id" className="text-xs flex items-center gap-1">
          Suite ID <InfoTip text="Unique identifier used for memory and analytics. Changing this breaks the association with past runs and observations." />
        </Label>
        {isCreateMode ? (
          <div className="relative">
            <Input
              id="suite-id"
              value={suiteId}
              readOnly
              disabled
              className="h-8 text-sm font-mono pr-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange('suite-id', generateSuiteId())}
              aria-label="Generate new ID"
              disabled={disabled}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-[13px] font-mono text-muted-foreground">
            {suiteId || 'No ID assigned'}
          </p>
        )}
      </div>

      {/* Target */}
      <div className="space-y-1.5">
        <Label htmlFor="suite-target" className="text-xs flex items-center gap-1">
          Target <span className="text-destructive">*</span> <InfoTip text="A registered app target from your workspace config. Defines where the suite runs (web URL or mobile app)." />
        </Label>
        {hasTargets ? (
          <Select
            value={target || undefined}
            onValueChange={(val) => onChange('target', val)}
            disabled={disabled}
          >
            <SelectTrigger id="suite-target" className="w-full h-8 text-sm">
              <SelectValue placeholder="Select a target" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : !isLoadingTargets ? (
          <p className="text-[13px] text-muted-foreground">
            No targets configured.{' '}
            <Link to="/config" className="text-primary underline underline-offset-4 hover:text-primary/80">
              Add targets in Settings.
            </Link>
          </p>
        ) : null}
        {selectedDetail && (
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground mt-1.5">
            {selectedDetail.platform === 'web'
              ? <Globe className="h-3.5 w-3.5 shrink-0" />
              : <Smartphone className="h-3.5 w-3.5 shrink-0" />}
            <span className="text-muted-foreground/70 uppercase text-[11px] tracking-wider shrink-0">{selectedDetail.platform}</span>
            <span className="font-mono truncate">
              {selectedDetail.product && <span className="mr-1.5">{selectedDetail.product}</span>}
              {selectedDetail.platform === 'web' && selectedDetail.url}
              {selectedDetail.platform === 'android' && `${selectedDetail.appPackage}${selectedDetail.appActivity ? ` / ${selectedDetail.appActivity}` : ''}`}
              {selectedDetail.platform === 'ios' && selectedDetail.bundleId}
            </span>
          </div>
        )}
      </div>

      {/* Context */}
      <div className="space-y-1.5">
        <Label htmlFor="suite-context" className="text-xs flex items-center gap-1">
          Context <InfoTip text="Additional instructions passed to every test in this suite before its own context. Use this for suite-wide setup notes or shared preconditions." />
        </Label>
        <div className="relative">
          <Textarea
            ref={textareaRef}
            id="suite-context"
            value={context}
            onChange={(e) => {
              onChange('context', e.target.value)
              setCursorPos(e.target.selectionStart ?? 0)
            }}
            onKeyDown={(e) => { if (autocomplete.handleKeyDown(e)) return }}
            onBlur={() => setTimeout(() => autocomplete.setVisible(false), 150)}
            placeholder="Additional instructions applied to every test in this suite..."
            disabled={disabled}
            className="min-h-[60px] resize-none text-sm"
            rows={2}
          />
          {autocomplete.dropdown}
        </div>
        {hasTemplateVars(context) && (
          <StepPillPreview text={context} hookLabels={hookLabels} />
        )}
      </div>
    </div>
  )
}
