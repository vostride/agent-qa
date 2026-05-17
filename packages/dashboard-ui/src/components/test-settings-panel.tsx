import { useYamlDocument } from '@/hooks/use-yaml-document'
import { useTargetDetails } from '@/hooks/use-target-details'
import { useEffect, useMemo, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

interface TestSettingsPanelProps {
  content: string
  onChange: (yaml: string) => void
  selectedTarget?: string
  showMeta?: boolean
}

const BROWSERS = [
  { value: 'chromium', label: 'Chromium' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'webkit', label: 'WebKit' },
]

function ih(value: unknown): string {
  if (value === undefined || value === null) return ''
  return `${value} (inherited)`
}

function ihBool(value: unknown): string {
  if (value === true) return '(inherited: on)'
  if (value === false) return '(inherited: off)'
  return '(inherited)'
}

type MobileAppState = 'preserve' | 'reset'

const AUTH_STATE_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/
const AUTH_STATE_KEYS = new Set(['name', 'load', 'capture'])

interface ParsedAuthStateUse {
  present: boolean
  valid: boolean
  name: string
  load: boolean
  capture: boolean
}

function inheritedAppStateLabel(value: MobileAppState | undefined): string {
  if (value === 'preserve') return 'Preserve app data (inherited)'
  if (value === 'reset') return 'Reset app data (inherited)'
  return 'Select app state'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidAuthStateName(value: string): boolean {
  return AUTH_STATE_NAME_PATTERN.test(value)
}

function parseAuthStateUse(value: unknown): ParsedAuthStateUse {
  if (value === undefined) {
    return { present: false, valid: false, name: '', load: true, capture: false }
  }

  if (typeof value === 'string') {
    const name = value.trim()
    return isValidAuthStateName(name)
      ? { present: true, valid: true, name, load: true, capture: false }
      : { present: true, valid: false, name: '', load: true, capture: false }
  }

  if (isPlainRecord(value)) {
    const keysAreKnown = Object.keys(value).every((key) => AUTH_STATE_KEYS.has(key))
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const loadValid = value.load === undefined || typeof value.load === 'boolean'
    const captureValid = value.capture === undefined || typeof value.capture === 'boolean'
    if (keysAreKnown && isValidAuthStateName(name) && loadValid && captureValid) {
      return {
        present: true,
        valid: true,
        name,
        load: value.load !== false,
        capture: value.capture === true,
      }
    }
  }

  return { present: true, valid: false, name: '', load: true, capture: false }
}

function serializeAuthStateUse(name: string, load: boolean, capture: boolean): string | { name: string; load?: boolean; capture?: boolean } {
  if (load && !capture) return name
  return {
    name,
    ...(!load ? { load: false } : {}),
    ...(capture ? { capture: true } : {}),
  }
}

export function TestSettingsPanel({ content, onChange, selectedTarget, showMeta = true }: TestSettingsPanelProps) {
  const { doc, getIn, setIn, deleteIn } = useYamlDocument(content)

  function handleSet(path: string[], value: unknown) {
    if (value === '' || value === undefined || value === null) {
      onChange(deleteIn(path))
    } else {
      onChange(setIn(path, value))
    }
  }

  function handleBoolSet(path: string[], checked: boolean, globalDefault: boolean | undefined) {
    if (checked === (globalDefault ?? false)) {
      onChange(deleteIn(path))
    } else {
      onChange(setIn(path, checked))
    }
  }

  const { targets: targetDetails, globalUse: g } = useTargetDetails()
  const targetPlatform = selectedTarget ? targetDetails[selectedTarget]?.platform : undefined
  const isMobile = targetPlatform === 'android' || targetPlatform === 'ios'

  const browser = getIn(['use', 'browser', 'name']) as string | undefined
  const headless = getIn(['use', 'browser', 'headless']) as boolean | undefined
  const viewportWidth = getIn(['use', 'browser', 'viewport', 'width']) as number | undefined
  const viewportHeight = getIn(['use', 'browser', 'viewport', 'height']) as number | undefined
  const stepTimeout = getIn(['use', 'timeout', 'step']) as string | undefined
  const testTimeout = getIn(['use', 'timeout', 'test']) as string | undefined
  const navTimeout = getIn(['use', 'timeout', 'navigation']) as string | undefined
  const healingMaxAttempts = getIn(['use', 'healing', 'maxAttempts']) as number | undefined
  const plannerMaxSubActions = getIn(['use', 'planner', 'maxSubActions']) as number | undefined
  const plannerPrevStepCount = getIn(['use', 'planner', 'previousStepCount']) as number | undefined
  const logConsole = getIn(['use', 'logCapture', 'console']) as boolean | undefined
  const logNetwork = getIn(['use', 'logCapture', 'network']) as boolean | undefined
  const llm = getIn(['use', 'llm']) as string | undefined
  const parallel = getIn(['use', 'parallel']) as boolean | undefined
  const device = getIn(['use', 'device']) as string | undefined
  const appState = getIn(['use', 'mobile', 'appState']) as MobileAppState | undefined
  const rawAuthState = useMemo(() => {
    try {
      return (doc?.toJSON() as { use?: { authState?: unknown } } | null)?.use?.authState
    } catch {
      return undefined
    }
  }, [doc])
  const parsedAuthState = useMemo(() => parseAuthStateUse(rawAuthState), [rawAuthState])
  const [draftAuthStateName, setDraftAuthStateName] = useState(parsedAuthState.valid ? parsedAuthState.name : '')
  const retries = getIn(['meta', 'retries']) as number | undefined
  const record = getIn(['meta', 'record']) as boolean | undefined

  const gHeadless = g?.browser?.headless
  const gLogConsole = g?.logCapture?.console
  const gLogNetwork = g?.logCapture?.network
  const gParallel = g?.parallel
  const gAppState = g?.mobile?.appState
  const mobileDevicePlaceholder = showMeta
    ? 'Select a device for this mobile test.'
    : 'Select a device for this mobile suite.'
  const authStateName = draftAuthStateName.trim()
  const authStateNameInvalid = authStateName.length > 0 && !isValidAuthStateName(authStateName)
  const authStateControlsEnabled = authStateName.length > 0 && !authStateNameInvalid
  const authStateLoad = parsedAuthState.valid ? parsedAuthState.load : true
  const authStateCapture = parsedAuthState.valid ? parsedAuthState.capture : false

  useEffect(() => {
    setDraftAuthStateName(parsedAuthState.valid ? parsedAuthState.name : '')
  }, [parsedAuthState.valid, parsedAuthState.name])

  function handleAppStateSet(value: MobileAppState) {
    if (value === gAppState) {
      onChange(deleteIn(['use', 'mobile', 'appState']))
    } else {
      onChange(setIn(['use', 'mobile', 'appState'], value))
    }
  }

  function writeAuthStateUse(name: string, load: boolean, capture: boolean) {
    onChange(setIn(['use', 'authState'], serializeAuthStateUse(name, load, capture)))
  }

  function handleAuthStateNameChange(value: string) {
    setDraftAuthStateName(value)
    const nextName = value.trim()
    if (nextName.length === 0) {
      onChange(deleteIn(['use', 'authState']))
      return
    }
    if (!isValidAuthStateName(nextName)) return
    writeAuthStateUse(nextName, authStateLoad, authStateCapture)
  }

  function handleAuthStateLoadChange(checked: boolean) {
    if (!authStateControlsEnabled) return
    writeAuthStateUse(authStateName, checked, authStateCapture)
  }

  function handleAuthStateCaptureChange(checked: boolean) {
    if (!authStateControlsEnabled) return
    writeAuthStateUse(authStateName, authStateLoad, checked)
  }

  return (
    <div className="space-y-3">
      {/* Browser */}
      {!isMobile ? (
        <>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-foreground tracking-tight">Browser</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Engine</Label>
              <Select
                value={browser ?? ''}
                onValueChange={(val) => handleSet(['use', 'browser', 'name'], val || undefined)}
              >
                <SelectTrigger className="w-full h-7 text-xs">
                  <SelectValue placeholder={ih(g?.browser?.name ?? 'chromium')} />
                </SelectTrigger>
                <SelectContent>
                  {BROWSERS.map((b) => (
                    <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-muted-foreground">Headless {headless === undefined && <span className="text-muted-foreground/50">{ihBool(gHeadless)}</span>}</Label>
              <Switch
                checked={headless ?? gHeadless ?? true}
                onCheckedChange={(checked) => handleBoolSet(['use', 'browser', 'headless'], checked, gHeadless)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <Label className="text-[11px] text-muted-foreground">Viewport W</Label>
                <Input
                  type="number"
                  value={viewportWidth ?? ''}
                  onChange={(e) => handleSet(['use', 'browser', 'viewport', 'width'], e.target.value ? Number(e.target.value) : undefined)}
                  placeholder={ih(g?.browser?.viewport?.width ?? 1280)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[11px] text-muted-foreground">Viewport H</Label>
                <Input
                  type="number"
                  value={viewportHeight ?? ''}
                  onChange={(e) => handleSet(['use', 'browser', 'viewport', 'height'], e.target.value ? Number(e.target.value) : undefined)}
                  placeholder={ih(g?.browser?.viewport?.height ?? 720)}
                  className="h-7 text-xs"
                />
              </div>
            </div>
          </div>
          <Separator />
        </>
      ) : (
        <>
          <div className="space-y-1 opacity-50">
            <span className="text-sm font-semibold text-foreground tracking-tight">Browser</span>
            <p className="text-[11px] text-muted-foreground">Not applicable to mobile targets</p>
          </div>
          <Separator />
        </>
      )}

      {!isMobile ? (
        <>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-foreground tracking-tight">Auth State</span>
            <div className="space-y-0.5">
              <Label htmlFor="auth-state-name" className="text-[11px] text-muted-foreground">Auth state name</Label>
              <Input
                id="auth-state-name"
                value={draftAuthStateName}
                onChange={(e) => handleAuthStateNameChange(e.target.value)}
                placeholder="demo-acc"
                className="h-7 text-xs font-mono"
              />
              {authStateNameInvalid ? (
                <p className="text-[11px] text-destructive">Auth state name must be a lowercase slug.</p>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="auth-state-load" className="text-[11px] text-muted-foreground">Load before run</Label>
              <Switch
                id="auth-state-load"
                checked={authStateControlsEnabled ? authStateLoad : true}
                disabled={!authStateControlsEnabled}
                onCheckedChange={handleAuthStateLoadChange}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="auth-state-capture" className="text-[11px] text-muted-foreground">Capture after success</Label>
              <Switch
                id="auth-state-capture"
                checked={authStateControlsEnabled ? authStateCapture : false}
                disabled={!authStateControlsEnabled}
                onCheckedChange={handleAuthStateCaptureChange}
              />
            </div>
            {authStateControlsEnabled && authStateCapture ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  {authStateLoad
                    ? 'Loads this state first, then replaces it after a successful run.'
                    : 'Starts without saved auth state, then saves this name after a successful run.'}
                </p>
                <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                  Capture creates or replaces the saved state after the run succeeds.
                </p>
              </>
            ) : null}
          </div>
          <Separator />
        </>
      ) : parsedAuthState.present ? (
        <>
          <div className="space-y-1 opacity-70">
            <span className="text-sm font-semibold text-foreground tracking-tight">Auth State</span>
            <p className="text-[11px] text-muted-foreground">
              Web auth state is not available for mobile targets. Use Mobile / App state to preserve app data.
            </p>
          </div>
          <Separator />
        </>
      ) : null}

      {isMobile ? (
        <>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-foreground tracking-tight">Mobile</span>
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Device</Label>
              <Input
                value={device ?? ''}
                onChange={(e) => handleSet(['use', 'device'], e.target.value || undefined)}
                placeholder={mobileDevicePlaceholder}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">App state</Label>
              <Select
                value={appState ?? ''}
                onValueChange={(val) => handleAppStateSet(val as MobileAppState)}
              >
                <SelectTrigger className="w-full h-7 text-xs">
                  <SelectValue placeholder={inheritedAppStateLabel(gAppState)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preserve">Preserve app data</SelectItem>
                  <SelectItem value="reset">Reset app data</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Separator />
        </>
      ) : null}

      {/* Timeouts */}
      <div className="space-y-2">
        <span className="text-sm font-semibold text-foreground tracking-tight">Timeouts</span>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Step</Label>
            <Input
              value={stepTimeout ?? ''}
              onChange={(e) => handleSet(['use', 'timeout', 'step'], e.target.value || undefined)}
              placeholder={ih(g?.timeout?.step ?? '30s')}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Test</Label>
            <Input
              value={testTimeout ?? ''}
              onChange={(e) => handleSet(['use', 'timeout', 'test'], e.target.value || undefined)}
              placeholder={ih(g?.timeout?.test ?? '5m')}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Navigation</Label>
            <Input
              value={navTimeout ?? ''}
              onChange={(e) => handleSet(['use', 'timeout', 'navigation'], e.target.value || undefined)}
              placeholder={ih(g?.timeout?.navigation ?? '15s')}
              className="h-7 text-xs"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Agent */}
      <div className="space-y-2">
        <span className="text-sm font-semibold text-foreground tracking-tight">Agent</span>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Heal Attempts</Label>
            <Input
              type="number"
              min={0}
              value={healingMaxAttempts ?? ''}
              onChange={(e) => handleSet(['use', 'healing', 'maxAttempts'], e.target.value ? Number(e.target.value) : undefined)}
              placeholder={ih(g?.healing?.maxAttempts ?? 3)}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Sub-Actions</Label>
            <Input
              type="number"
              min={1}
              value={plannerMaxSubActions ?? ''}
              onChange={(e) => handleSet(['use', 'planner', 'maxSubActions'], e.target.value ? Number(e.target.value) : undefined)}
              placeholder={ih(g?.planner?.maxSubActions ?? 5)}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[11px] text-muted-foreground">Prev Steps</Label>
            <Input
              type="number"
              min={0}
              value={plannerPrevStepCount ?? ''}
              onChange={(e) => handleSet(['use', 'planner', 'previousStepCount'], e.target.value ? Number(e.target.value) : undefined)}
              placeholder={ih(g?.planner?.previousStepCount ?? 3)}
              className="h-7 text-xs"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Log Capture */}
      <div className="space-y-2">
        <span className="text-sm font-semibold text-foreground tracking-tight">Log Capture</span>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">Console {logConsole === undefined && <span className="text-muted-foreground/50">{ihBool(gLogConsole)}</span>}</Label>
          <Switch
            checked={logConsole ?? gLogConsole ?? false}
            onCheckedChange={(checked) => handleBoolSet(['use', 'logCapture', 'console'], checked, gLogConsole)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">Network {logNetwork === undefined && <span className="text-muted-foreground/50">{ihBool(gLogNetwork)}</span>}</Label>
          <Switch
            checked={logNetwork ?? gLogNetwork ?? false}
            onCheckedChange={(checked) => handleBoolSet(['use', 'logCapture', 'network'], checked, gLogNetwork)}
          />
        </div>
      </div>

      <Separator />

      {/* LLM */}
      <div className="space-y-2">
        <span className="text-sm font-semibold text-foreground tracking-tight">LLM</span>
        <div className="space-y-0.5">
          <Label className="text-[11px] text-muted-foreground">LLM Config</Label>
          <Input
            value={llm ?? ''}
            onChange={(e) => handleSet(['use', 'llm'], e.target.value || undefined)}
            placeholder={ih(g?.llm ?? 'default')}
            className="h-7 text-xs"
          />
        </div>
      </div>

      <Separator />

      {/* Execution & Meta */}
      <div className="space-y-2">
        <span className="text-sm font-semibold text-foreground tracking-tight">Execution</span>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">Parallel {parallel === undefined && <span className="text-muted-foreground/50">{ihBool(gParallel)}</span>}</Label>
          <Switch
            checked={parallel ?? gParallel ?? false}
            onCheckedChange={(checked) => handleBoolSet(['use', 'parallel'], checked, gParallel)}
          />
        </div>
        {showMeta && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Retries</Label>
              <Input
                type="number"
                min={0}
                value={retries ?? ''}
                onChange={(e) => handleSet(['meta', 'retries'], e.target.value ? Number(e.target.value) : undefined)}
                placeholder="0 (inherited)"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Record {record === undefined && <span className="text-muted-foreground/50">(inherited: off)</span>}</Label>
              <div className="flex items-center h-7">
                <Switch
                  checked={record ?? false}
                  onCheckedChange={(checked) => handleBoolSet(['meta', 'record'], checked, false)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
