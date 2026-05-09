import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const agentQaRoot = fileURLToPath(new URL('../../../..', import.meta.url))

type TimeoutInventoryEntry = {
  id: string
  file: string
  literal: string
  contextIncludes: string
  owner: string
  scope: string
  lifecycleAffecting: boolean
  rationale: string
  allowed: boolean
}

const timeoutInventory: TimeoutInventoryEntry[] = [
  {
    id: 'dashboard-retired-implicit-10m-process-watchdog',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '600_000',
    contextIncludes: 'defaultTimeout',
    owner: 'dashboard execution',
    scope: 'process watchdog',
    lifecycleAffecting: true,
    rationale: 'Retired risk: hidden dashboard fallback killed local LLM runs before configured test timeouts.',
    allowed: false,
  },
  {
    id: 'dashboard-process-timeout-buffer',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '60_000',
    contextIncludes: 'DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS',
    owner: 'dashboard routes',
    scope: 'outer process watchdog buffer',
    lifecycleAffecting: true,
    rationale: 'Keeps dashboard child-process cleanup behind the effective CLI/core test timeout.',
    allowed: true,
  },
  {
    id: 'dashboard-config-timeout-positive-transformed-check',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '0',
    contextIncludes: 'transformedTimeout > 0',
    owner: 'dashboard routes',
    scope: 'trusted timeout metadata positive guard',
    lifecycleAffecting: true,
    rationale: 'Rejects zero or negative transformed timeout values before arming the outer process watchdog.',
    allowed: true,
  },
  {
    id: 'dashboard-config-timeout-positive-raw-check',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '0',
    contextIncludes: 'testTimeout > 0',
    owner: 'dashboard routes',
    scope: 'trusted timeout metadata positive guard',
    lifecycleAffecting: true,
    rationale: 'Rejects zero or negative raw schema-parsed timeout values before arming the outer process watchdog.',
    allowed: true,
  },
  {
    id: 'dashboard-heartbeat-check-interval',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '10_000',
    contextIncludes: 'DEFAULT_HEARTBEAT_INTERVAL_MS',
    owner: 'dashboard execution',
    scope: 'stale heartbeat poll cadence',
    lifecycleAffecting: true,
    rationale: 'Polls for missing live-event heartbeats without imposing a run duration limit.',
    allowed: true,
  },
  {
    id: 'dashboard-stale-heartbeat-threshold',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '30_000',
    contextIncludes: 'DEFAULT_STALE_THRESHOLD_MS',
    owner: 'dashboard execution',
    scope: 'silent child process stale detection',
    lifecycleAffecting: true,
    rationale: 'Fails truly silent child processes after heartbeat loss; heartbeats refresh this threshold.',
    allowed: true,
  },
  {
    id: 'dashboard-stale-threshold-heartbeat-buffer',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '1',
    contextIncludes: 'this.heartbeatIntervalMs + 1',
    owner: 'dashboard execution',
    scope: 'minimum stale threshold above heartbeat poll interval',
    lifecycleAffecting: true,
    rationale: 'Prevents a configured stale threshold from being equal to or shorter than the heartbeat checker cadence.',
    allowed: true,
  },
  {
    id: 'dashboard-process-timeout-positive-check',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '0',
    contextIncludes: 'processTimeoutMs > 0',
    owner: 'dashboard execution',
    scope: 'process watchdog disabled sentinel',
    lifecycleAffecting: true,
    rationale: 'Only arms the process watchdog for positive explicit metadata or constructor timeouts.',
    allowed: true,
  },
  {
    id: 'dashboard-sigterm-sigkill-grace',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '5_000',
    contextIncludes: 'PROCESS_TERMINATION_GRACE_MS',
    owner: 'dashboard execution',
    scope: 'SIGTERM to SIGKILL escalation grace',
    lifecycleAffecting: true,
    rationale: 'Bounds cleanup after an explicit timeout or cancellation signal.',
    allowed: true,
  },
  {
    id: 'dashboard-handle-retention',
    file: 'packages/dashboard-server/src/execution/test-runner.ts',
    literal: '5 * 60 * 1000',
    contextIncludes: 'HANDLE_RETENTION_MS',
    owner: 'dashboard execution',
    scope: 'completed run event buffer retention',
    lifecycleAffecting: false,
    rationale: 'Retains buffered live events after terminal state; does not terminate execution.',
    allowed: true,
  },
  {
    id: 'dashboard-retired-10s-compatible-llm-test-timeout',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '10000',
    contextIncludes: 'controller.abort',
    owner: 'dashboard config',
    scope: 'LLM connectivity test abort',
    lifecycleAffecting: true,
    rationale: 'Retired risk: a fixed 10s cap misclassified slow local compatible models as broken.',
    allowed: false,
  },
  {
    id: 'dashboard-remote-llm-connection-test-timeout',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '10_000',
    contextIncludes: 'REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS',
    owner: 'dashboard config',
    scope: 'remote LLM connectivity test abort',
    lifecycleAffecting: true,
    rationale: 'Bounds the connectivity-only smoke prompt for remote providers.',
    allowed: true,
  },
  {
    id: 'dashboard-local-compatible-llm-connection-test-timeout',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '120_000',
    contextIncludes: 'LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS',
    owner: 'dashboard config',
    scope: 'local OpenAI/Anthropic-compatible connectivity test abort',
    lifecycleAffecting: true,
    rationale: 'Allows slow local prompt processing during connectivity checks without affecting real test execution.',
    allowed: true,
  },
  {
    id: 'dashboard-sse-comment-heartbeat',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '15_000',
    contextIncludes: 'setInterval',
    owner: 'dashboard routes',
    scope: 'SSE keepalive comments',
    lifecycleAffecting: false,
    rationale: 'Keeps browser SSE connections alive and does not terminate execution.',
    allowed: true,
  },
  {
    id: 'dashboard-retired-openai-oauth-session-retention',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '5 * 60 * 1000',
    contextIncludes: 'pendingOpenaiSessions.delete',
    owner: 'dashboard auth',
    scope: 'OAuth polling session retention',
    lifecycleAffecting: false,
    rationale: 'Retired with provider-specific OAuth routes; plugin auth sessions are server-owned and do not use this literal.',
    allowed: false,
  },
  {
    id: 'dashboard-retired-oauth-popup-autoclose',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '1500',
    contextIncludes: 'window.close',
    owner: 'dashboard auth',
    scope: 'OAuth callback window close delay',
    lifecycleAffecting: false,
    rationale: 'Retired with provider-specific callback HTML; plugin auth owns provider callback behavior.',
    allowed: false,
  },
  {
    id: 'stdout-live-reporter-heartbeat',
    file: 'packages/core/src/reporter/stdout-live-reporter.ts',
    literal: '10_000',
    contextIncludes: 'heartbeat',
    owner: 'core live reporter',
    scope: 'child process heartbeat emission cadence',
    lifecycleAffecting: true,
    rationale: 'Feeds dashboard stale detection while a test is active.',
    allowed: true,
  },
  {
    id: 'cli-suite-step-timeout-fallback',
    file: 'packages/cli/src/commands/run.ts',
    literal: '30000',
    contextIncludes: 'step:',
    owner: 'CLI suite runner',
    scope: 'suite step timeout fallback',
    lifecycleAffecting: true,
    rationale: 'Product fallback when neither suite nor config specifies a step timeout.',
    allowed: true,
  },
  {
    id: 'cli-suite-test-timeout-fallback',
    file: 'packages/cli/src/commands/run.ts',
    literal: '120000',
    contextIncludes: 'test:',
    owner: 'CLI suite runner',
    scope: 'suite test timeout fallback',
    lifecycleAffecting: true,
    rationale: 'Product fallback when neither suite nor config specifies a test timeout.',
    allowed: true,
  },
  {
    id: 'cli-suite-navigation-timeout-fallback',
    file: 'packages/cli/src/commands/run.ts',
    literal: '30000',
    contextIncludes: 'navigation:',
    owner: 'CLI suite runner',
    scope: 'suite navigation timeout fallback',
    lifecycleAffecting: true,
    rationale: 'Product fallback when neither suite nor config specifies a navigation timeout.',
    allowed: true,
  },
  {
    id: 'core-test-timeout-disabled-sentinel',
    file: 'packages/core/src/agent/runner.ts',
    literal: '0',
    contextIncludes: 'testTimeout ? startTime + testTimeout : 0',
    owner: 'core runner',
    scope: 'test deadline disabled sentinel',
    lifecycleAffecting: true,
    rationale: 'Disables the core test deadline only when no effective timeout is configured.',
    allowed: true,
  },
  {
    id: 'core-test-timeout-artifact-action-sentinel',
    file: 'packages/core/src/agent/runner.ts',
    literal: '0',
    contextIncludes: "timeout: 0",
    owner: 'core runner',
    scope: 'timeout failure artifact placeholder',
    lifecycleAffecting: false,
    rationale: 'Represents a no-op planned action in failure traces; does not control execution.',
    allowed: true,
  },
  {
    id: 'core-step-timeout-disabled-sentinel',
    file: 'packages/core/src/agent/loop.ts',
    literal: '0',
    contextIncludes: 'config.stepTimeout ? startTime + config.stepTimeout : 0',
    owner: 'core loop',
    scope: 'step deadline disabled sentinel',
    lifecycleAffecting: true,
    rationale: 'Disables the core step deadline only when no effective timeout is configured.',
    allowed: true,
  },
  {
    id: 'core-step-timeout-artifact-action-sentinel',
    file: 'packages/core/src/agent/loop.ts',
    literal: '0',
    contextIncludes: "timeout: 0",
    owner: 'core loop',
    scope: 'timeout/cancelled failure artifact placeholder',
    lifecycleAffecting: false,
    rationale: 'Represents a no-op planned action in traces; does not control execution.',
    allowed: true,
  },
]

const scannedFiles = [...new Set(timeoutInventory.map(entry => entry.file))]
const timeoutContextPattern = /(timeout|setTimeout|setInterval|stale|heartbeat|SIGKILL|SIGTERM|abort|deadline|defaultTimeout|termination|grace|retention|connection)/i
const numericExpressionPattern = /\b\d[\d_]*(?:\s*\*\s*\d[\d_]*)*\b/g

function normalizeLiteral(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

describe('execution timeout inventory', () => {
  it('inventories reviewed timeout literals in execution-relevant files', async () => {
    for (const entry of timeoutInventory) {
      expect(entry.owner, `${entry.id} owner`).toBeTruthy()
      expect(entry.scope, `${entry.id} scope`).toBeTruthy()
      expect(entry.rationale, `${entry.id} rationale`).toBeTruthy()
      expect(typeof entry.lifecycleAffecting, `${entry.id} lifecycle flag`).toBe('boolean')
    }

    const activeInventory = timeoutInventory.filter(entry => entry.allowed)
    const retiredInventory = timeoutInventory.filter(entry => !entry.allowed)

    for (const file of scannedFiles) {
      const content = await readFile(join(agentQaRoot, file), 'utf-8')
      const lines = content.split('\n')

      for (const retired of retiredInventory.filter(entry => entry.file === file)) {
        expect(content, `${retired.id} must remain retired`).not.toContain(retired.literal)
      }

      const discovered = lines.flatMap((line, index) => {
        const context = lines.slice(Math.max(0, index - 4), index + 1).join(' ').trim()
        const ownLineHasTimeoutContext = timeoutContextPattern.test(line)
        const timerArgumentLine = /^\s*},\s*\d[\d_\s*]*\)?/.test(line)
        if (!ownLineHasTimeoutContext && !timerArgumentLine) return []
        if (!timeoutContextPattern.test(context)) return []
        return [...line.matchAll(numericExpressionPattern)].map(match => ({
          file,
          line: index + 1,
          literal: normalizeLiteral(match[0]),
          context,
        }))
      })

      for (const literal of discovered) {
        const entry = activeInventory.find(candidate =>
          candidate.file === literal.file
          && normalizeLiteral(candidate.literal) === literal.literal
          && literal.context.includes(candidate.contextIncludes),
        )
        expect(entry, `${literal.file}:${literal.line} ${literal.literal} in "${literal.context}"`).toBeDefined()
      }

      for (const entry of activeInventory.filter(candidate => candidate.file === file)) {
        expect(discovered.some(literal =>
          literal.literal === normalizeLiteral(entry.literal)
          && literal.context.includes(entry.contextIncludes),
        ), `${entry.id} should match a scanned timeout literal`).toBe(true)
      }
    }
  })
})
