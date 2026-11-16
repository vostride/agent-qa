import { Link } from 'react-router'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { TestFileInfo } from '@/lib/api'
import { Trans, useTranslation } from '@/i18n'

interface SuiteTestPickerProps {
  availableTests: TestFileInfo[]
  onAdd: (entry: { test: string; id: string }) => void
  disabled?: boolean
}

export function SuiteTestPicker({ availableTests, onAdd, disabled = false }: SuiteTestPickerProps) {
  const { t } = useTranslation()
  if (availableTests.length === 0) {
    return (
      <div className="rounded-md border bg-card/20 p-3 text-sm text-muted-foreground">
        <Trans
          i18nKey="suites.picker.noTests"
          components={{
            link: (
              <Link
                to="/tests/new"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
              />
            ),
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <Command className="rounded-md border">
        <CommandInput placeholder={t('suites.picker.search')} disabled={disabled} />
        <CommandList className="max-h-64">
          <CommandEmpty>{t('suites.picker.noMatches')}</CommandEmpty>
          <CommandGroup>
            {availableTests.map((tf) => (
              <CommandItem
                key={tf.path}
                value={`${tf.name} ${tf.path} ${tf.testId ?? ''}`}
                onSelect={() => onAdd({ test: tf.path, id: tf.testId ?? '' })}
                disabled={disabled}
                className="px-2 py-1.5"
              >
                <div className="flex flex-col gap-0.5 w-full min-w-0">
                  <span className="text-sm font-medium truncate">{tf.name}</span>
                  <span className="text-[11px] font-mono text-muted-foreground truncate">{tf.path}</span>
                  <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                    {tf.testId ?? ''}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      <p className="text-[10px] text-muted-foreground/60">
        {t('suites.picker.help')}
      </p>
    </div>
  )
}
