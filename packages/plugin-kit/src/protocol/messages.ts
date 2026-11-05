import { z } from 'zod'

export const PLUGIN_PROTOCOL_VERSION = 1

export const PLUGIN_METHODS = [
  'initialize',
  'check',
  'acquire',
  'uploadApp',
  'started',
  'end',
  'release',
  'shutdown',
] as const
export type PluginMethod = (typeof PLUGIN_METHODS)[number]

export const OPTIONAL_PLUGIN_METHODS = ['check', 'uploadApp', 'started', 'end'] as const
export type OptionalPluginMethod = (typeof OPTIONAL_PLUGIN_METHODS)[number]

export const PLUGIN_SERVES = ['playwright', 'cdp', 'appium'] as const
export type PluginServe = (typeof PLUGIN_SERVES)[number]

export const PLUGIN_RUN_FACTS = ['testName', 'runId', 'failure'] as const
export type PluginRunFact = (typeof PLUGIN_RUN_FACTS)[number]

export const PLUGIN_FAILURE_KINDS = [
  'unreachable',
  'auth',
  'capacity',
  'timeout',
  'version',
  'refused',
  'ended',
  'lost',
] as const
export type PluginFailureKind = (typeof PLUGIN_FAILURE_KINDS)[number]

export const PLUGIN_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  plugin: -32000,
  cancelled: -32800,
} as const

export const CANCEL_METHOD = '$/cancel'
export const PROGRESS_METHOD = '$/progress'

export const MAX_MESSAGE_BYTES = 1024 * 1024

const JsonObjectSchema = z.record(z.string(), z.unknown())
const HandleSchema = z.json()
const RequestIdSchema = z.union([z.string(), z.number()])

export const InitializeParamsSchema = z.object({
  protocolVersions: z.array(z.number().int()),
  host: z.object({
    pid: z.number().int(),
    agentQaVersion: z.string(),
    playwrightVersion: z.string(),
    webdriverioVersion: z.string(),
  }),
  entry: z.string(),
  options: JsonObjectSchema,
  runFacts: z.object({ runId: z.string().optional() }).optional(),
})
export type InitializeParams = z.infer<typeof InitializeParamsSchema>

export const InitializeResultSchema = z.object({
  protocolVersion: z.number().int(),
  plugin: z.object({ name: z.string(), version: z.string() }),
  serves: z.array(z.enum(PLUGIN_SERVES)),
  methods: z.array(z.enum(OPTIONAL_PLUGIN_METHODS)),
})
export type InitializeResult = z.infer<typeof InitializeResultSchema>

export const CheckParamsSchema = z.object({
  remotes: z.array(z.object({ name: z.string(), settings: JsonObjectSchema })),
})
export type CheckParams = z.infer<typeof CheckParamsSchema>

export const CheckResultSchema = z.object({
  state: z.enum(['ok', 'warn']),
  lines: z.array(z.string()),
})
export type CheckResult = z.infer<typeof CheckResultSchema>

const WebSessionSchema = z.object({
  platform: z.literal('web'),
  engine: z.enum(['chromium', 'firefox', 'webkit']),
  context: z.enum(['new', 'reuse']),
})

const DeviceSessionSchema = z.object({
  platform: z.enum(['android', 'ios']),
  capabilities: JsonObjectSchema,
})

export const AcquireParamsSchema = z.object({
  remote: z.string(),
  settings: JsonObjectSchema,
  session: z.discriminatedUnion('platform', [WebSessionSchema, DeviceSessionSchema]),
  run: z.object({ testName: z.string().optional() }).optional(),
})
export type AcquireParams = z.infer<typeof AcquireParamsSchema>

export const AcquireResultSchema = z.object({
  handle: HandleSchema,
  protocol: z.enum(PLUGIN_SERVES),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  capabilities: JsonObjectSchema.optional(),
  mask: z.array(z.string()).optional(),
  link: z.string().optional(),
})
export type AcquireResult = z.infer<typeof AcquireResultSchema>

export const UploadAppParamsSchema = z.object({
  remote: z.string(),
  settings: JsonObjectSchema,
  platform: z.enum(['android', 'ios']),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
})
export type UploadAppParams = z.infer<typeof UploadAppParamsSchema>

export const UploadAppResultSchema = z.object({ ref: z.string() })
export type UploadAppResult = z.infer<typeof UploadAppResultSchema>

export const StartedParamsSchema = z.object({
  handle: HandleSchema,
  sessionId: z.string().optional(),
})
export type StartedParams = z.infer<typeof StartedParamsSchema>

export const StartedResultSchema = z.object({
  link: z.string().optional(),
  appiumVersion: z.string().optional(),
})
export type StartedResult = z.infer<typeof StartedResultSchema>

export const EndParamsSchema = z.object({
  handle: HandleSchema,
  outcome: z.enum(['passed', 'failed', 'error', 'cancelled']),
  reason: z.string().optional(),
})
export type EndParams = z.infer<typeof EndParamsSchema>

export const ReleaseParamsSchema = z.object({ handle: HandleSchema })
export type ReleaseParams = z.infer<typeof ReleaseParamsSchema>

export const CancelParamsSchema = z.object({ id: RequestIdSchema })
export type CancelParams = z.infer<typeof CancelParamsSchema>

export const ProgressParamsSchema = z.object({
  id: RequestIdSchema,
  message: z.string(),
  queued: z.number().int().nonnegative().optional(),
  percent: z.number().min(0).max(100).optional(),
})
export type ProgressParams = z.infer<typeof ProgressParamsSchema>

export const PluginErrorDataSchema = z.object({
  kind: z.enum(PLUGIN_FAILURE_KINDS),
  path: z.string().optional(),
  handle: HandleSchema.optional(),
  supported: z.array(z.number().int()).optional(),
  requested: z.array(z.number().int()).optional(),
})
export type PluginErrorData = z.infer<typeof PluginErrorDataSchema>
