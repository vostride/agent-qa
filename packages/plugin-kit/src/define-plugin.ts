import type { z } from 'zod'
import {
  OPTIONAL_PLUGIN_METHODS,
  type AcquireParams,
  type AcquireResult,
  type CheckResult,
  type EndParams,
  type InitializeParams,
  type OptionalPluginMethod,
  type PluginFailureKind,
  type PluginRunFact,
  type PluginServe,
  type StartedParams,
  type StartedResult,
  type UploadAppParams,
  type UploadAppResult,
} from './protocol/messages.js'

type Json = z.core.util.JSONType
type Awaitable<T> = T | Promise<T>

export interface PluginErrorOptions {
  kind: PluginFailureKind
  path?: string
  handle?: Json
}

export class PluginError extends Error {
  readonly kind: PluginFailureKind
  readonly path: string | undefined
  readonly handle: Json | undefined

  constructor(message: string, options: PluginErrorOptions) {
    super(message)
    this.name = 'PluginError'
    this.kind = options.kind
    this.path = options.path
    this.handle = options.handle
  }
}

export interface InitializeInput<Options> {
  options: Options
  host: InitializeParams['host']
  entry: string
  runFacts: InitializeParams['runFacts']
}

export interface CheckInput<Options, Settings> {
  options: Options
  remotes: { name: string; settings: Settings }[]
}

export interface AcquireInput<Options, Settings> extends Omit<AcquireParams, 'settings'> {
  options: Options
  settings: Settings
}

export interface UploadAppInput<Options, Settings> extends Omit<UploadAppParams, 'settings'> {
  options: Options
  settings: Settings
}

export interface StartedInput<Options> extends StartedParams {
  options: Options
}

export interface EndInput<Options> extends EndParams {
  options: Options
}

export interface ReleaseInput<Options> {
  options: Options
  handle: Json
}

export interface ShutdownInput<Options> {
  options: Options
}

export interface PluginProgress {
  message: string
  queued?: number
  percent?: number
}

export interface PluginCallContext {
  signal: AbortSignal
  progress(update: PluginProgress): void
  runFacts: InitializeParams['runFacts']
}

export interface PluginSpec<OptionsSchema extends z.ZodType, SettingsSchema extends z.ZodType> {
  options: OptionsSchema
  settings: SettingsSchema
  serves: readonly PluginServe[]
  runFacts?: readonly PluginRunFact[]
  skill?: string
  initialize?(
    input: InitializeInput<z.output<OptionsSchema>>,
    ctx: PluginCallContext,
  ): Awaitable<void>
  check?(
    input: CheckInput<z.output<OptionsSchema>, z.output<SettingsSchema>>,
    ctx: PluginCallContext,
  ): Awaitable<CheckResult>
  acquire(
    input: AcquireInput<z.output<OptionsSchema>, z.output<SettingsSchema>>,
    ctx: PluginCallContext,
  ): Awaitable<AcquireResult>
  uploadApp?(
    input: UploadAppInput<z.output<OptionsSchema>, z.output<SettingsSchema>>,
    ctx: PluginCallContext,
  ): Awaitable<UploadAppResult>
  started?(
    input: StartedInput<z.output<OptionsSchema>>,
    ctx: PluginCallContext,
  ): Awaitable<StartedResult>
  end?(input: EndInput<z.output<OptionsSchema>>, ctx: PluginCallContext): Awaitable<void>
  release(input: ReleaseInput<z.output<OptionsSchema>>, ctx: PluginCallContext): Awaitable<void>
  shutdown?(input: ShutdownInput<z.output<OptionsSchema>>, ctx: PluginCallContext): Awaitable<void>
}

export interface PluginDefinition<
  OptionsSchema extends z.ZodType = z.ZodType,
  SettingsSchema extends z.ZodType = z.ZodType,
> extends PluginSpec<OptionsSchema, SettingsSchema> {
  methods: readonly OptionalPluginMethod[]
}

export function definePlugin<OptionsSchema extends z.ZodType, SettingsSchema extends z.ZodType>(
  spec: PluginSpec<OptionsSchema, SettingsSchema>,
): PluginDefinition<OptionsSchema, SettingsSchema> {
  const methods = OPTIONAL_PLUGIN_METHODS.filter((method) => typeof spec[method] === 'function')
  return { ...spec, methods }
}
