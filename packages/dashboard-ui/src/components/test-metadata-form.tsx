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
import { Trans, useTranslation } from '@/i18n'

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
  const { t } = useTranslation()
  const { targets, isLoading: isLoadingTargets } = useTargets()
  const { targets: targetDetails } = useTargetDetails()
  const selectedDetail = target ? targetDetails[target] : undefined

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="test-name" className="text-xs">
          {t('editor.forms.testName')} <span className="text-destructive">*</span>
        </Label>
        <Input
          id="test-name"
          value={name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder={t('editor.forms.testNamePlaceholder')}
          disabled={disabled}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="test-id" className="text-xs flex items-center gap-1">{t('editor.forms.testId')} <InfoTip text={t('editor.forms.testIdHelp')} /></Label>
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
              aria-label={t('editor.forms.generateId')}
              disabled={disabled}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-[13px] font-mono text-muted-foreground">{testId || t('editor.forms.noId')}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="test-target" className="text-xs flex items-center gap-1">
          {t('editor.forms.target')} <span className="text-destructive">*</span> <InfoTip text={t('editor.forms.targetHelp')} />
        </Label>
        {!isLoadingTargets && targets.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            <Trans
              i18nKey="editor.forms.noTargets"
              components={{
                link: (
                  <Link
                    to="/config"
                    className="text-primary underline underline-offset-4 hover:text-primary/80"
                  />
                ),
              }}
            />
          </p>
        ) : (
          <Select
            value={target || undefined}
            onValueChange={(val) => onChange('target', val)}
            disabled={disabled || isLoadingTargets}
          >
            <SelectTrigger className="w-full h-8 text-sm">
              <SelectValue placeholder={t('editor.forms.selectTarget')} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
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
          {t('editor.forms.context')} <InfoTip text={t('editor.forms.contextHelp')} />
        </Label>
        <Textarea
          id="test-context"
          value={context}
          onChange={(e) => onChange('context', e.target.value)}
          placeholder={t('editor.forms.contextPlaceholder')}
          disabled={disabled}
          className="min-h-[60px] resize-none text-sm"
          rows={2}
        />
      </div>
    </div>
  )
}
