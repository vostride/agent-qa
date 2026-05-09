import { Link } from 'react-router'
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
import { generateTestId } from '@/lib/generate-test-id'
import { useTargets } from '@/hooks/use-targets'
import { useTargetDetails } from '@/hooks/use-target-details'

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

interface TestMetadataFormProps {
  name: string
  testId: string
  target: string
  context: string
  isCreateMode: boolean
  onChange: (field: string, value: string | string[]) => void
  disabled?: boolean
}

export function TestMetadataForm({
  name,
  testId,
  target,
  context,
  isCreateMode,
  onChange,
  disabled = false,
}: TestMetadataFormProps) {
  const { targets, isLoading: isLoadingTargets } = useTargets()
  const { targets: targetDetails } = useTargetDetails()
  const selectedDetail = target ? targetDetails[target] : undefined

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="test-name" className="text-xs">
          Test Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="test-name"
          value={name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="My Test"
          disabled={disabled}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="test-id" className="text-xs flex items-center gap-1">Test ID <InfoTip text="Unique identifier used for memory and analytics. Changing this breaks the association with past runs and observations." /></Label>
        {isCreateMode ? (
          <div className="flex items-center gap-2">
            <Input
              id="test-id"
              value={testId}
              readOnly
              disabled
              className="h-8 text-sm font-mono flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange('test-id', generateTestId())}
              aria-label="Generate new ID"
              disabled={disabled}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-[13px] font-mono text-muted-foreground">{testId || 'No ID assigned'}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="test-target" className="text-xs flex items-center gap-1">
          Target <span className="text-destructive">*</span> <InfoTip text="A registered app target from your workspace config. Defines where the test runs (web URL or mobile app)." />
        </Label>
        {!isLoadingTargets && targets.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No targets configured.{' '}
            <Link to="/config" className="text-primary underline underline-offset-4 hover:text-primary/80">
              Add targets in Settings
            </Link>
            .
          </p>
        ) : (
          <Select
            value={target || undefined}
            onValueChange={(val) => onChange('target', val)}
            disabled={disabled || isLoadingTargets}
          >
            <SelectTrigger className="w-full h-8 text-sm">
              <SelectValue placeholder="Select a target" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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

      <div className="space-y-1.5">
        <Label htmlFor="test-context" className="text-xs flex items-center gap-1">
          Context <InfoTip text="Additional instructions the AI agent receives before executing steps. Use this for login credentials, test-specific rules, or environment details." />
        </Label>
        <Textarea
          id="test-context"
          value={context}
          onChange={(e) => onChange('context', e.target.value)}
          placeholder="Additional instructions for the AI agent..."
          disabled={disabled}
          className="min-h-[60px] resize-none text-sm"
          rows={2}
        />
      </div>
    </div>
  )
}
