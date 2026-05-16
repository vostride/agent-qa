import { z } from 'zod'
import { DEFAULT_MEMORY_DIR } from '../memory/config.js'
import { DurationString } from './primitives.js'

export const DashboardConfigSchema = z.object({
  port: z.number().optional(),
  dbPath: z.string().optional(),
  artifactsDir: z.string().optional(),
}).strict()

const LoopbackHostSchema = z.string().trim().min(1).refine(
  host => host === 'localhost' || host === '127.0.0.1' || host === '::1',
  { message: 'MCP host must be localhost, 127.0.0.1, or ::1 in local-only mode' },
)

export const McpConfigSchema = z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(['http', 'stdio']).optional(),
  host: LoopbackHostSchema.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().trim().min(1).regex(/^\//, 'MCP path must start with /').optional(),
}).strict()

export const CacheConfigSchema = z.object({
  dir: z.string(),
  ttl: DurationString,
}).strict()

export const AuthStateConfigSchema = z.object({
  dir: z.string().trim().min(1),
}).strict()

export const LoggingConfigSchema = z.object({
  level: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
}).strict()

export const RecordingConfigSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

export const AccessibilityConfigSchema = z.object({
  enabled: z.boolean(),
  standard: z.enum(['wcag2a', 'wcag2aa', 'wcag2aaa']).optional(),
  runAfter: z.enum(['every-step', 'navigation', 'test-end']).optional(),
  failOnViolation: z.boolean().optional(),
  disableRules: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).strict()

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  provider: z.enum(['local']).optional().default('local'),
  dir: z.string().trim().min(1).optional().default(DEFAULT_MEMORY_DIR),
  minTrust: z.number().min(0).max(1).optional().default(0.3),
  maxInjections: z.number().int().min(0).optional().default(3),
  curatorEnabled: z.boolean().optional().default(true),
  curatorLockTimeout: z.number().int().min(1000).optional().default(120_000),
  trustConfirmDelta: z.number().min(0).max(1).optional().default(0.05),
  trustContradictDelta: z.number().min(0).max(1).optional().default(0.10),
  ablationEnabled: z.boolean().optional().default(true),
  circuitBreakerEnabled: z.boolean().optional().default(true),
  circuitBreakerWindowSize: z.number().int().min(5).optional().default(20),
  circuitBreakerBaselineSize: z.number().int().min(2).optional().default(3),
  circuitBreakerThreshold: z.number().min(0).max(1).optional().default(0.15),
}).strict()

export const ServicesSchema = z.object({
  dashboard: DashboardConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  cache: CacheConfigSchema.optional(),
  authState: AuthStateConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  recording: RecordingConfigSchema.optional(),
  accessibility: AccessibilityConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
}).strict()
