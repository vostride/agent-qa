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
    id: 'cli-cancel-grace-default',
    file: 'packages/cli/src/commands/run.ts',
    literal: '3000',
    contextIncludes: 'AGENT_QA_CANCEL_GRACE_MS',
    owner: 'CLI run shutdown',
    scope: 'force-exit backstop grace window',
    lifecycleAffecting: true,
    rationale: 'Default grace before the un-settleable-run force-exit backstop fires; overridable via AGENT_QA_CANCEL_GRACE_MS. Primary cancel guarantee is the shell settling done cleanly; this is a hard safety net so a live Ctrl+C can never hang the CLI.',
    allowed: true,
  },
  {
    id: 'cli-cancel-force-exit-code',
    file: 'packages/cli/src/commands/run.ts',
    literal: '130',
    contextIncludes: 'forceExit(130)',
    owner: 'CLI run shutdown',
    scope: 'force-exit backstop exit code',
    lifecycleAffecting: true,
    rationale: 'The SIGINT (130) exit code the bounded grace timer forces so a genuinely un-settleable run still exits; armed in both handleShutdown sites and cleared after session.done. The timer exits through forceExit, which first closes this process\'s own still-running row.',
    allowed: true,
  },
  {
    id: 'dashboard-retired-implicit-10m-process-watchdog',
    file: 'packages/dashboard-server/src/execution/in-process-backend.ts',
    literal: '600_000',
    contextIncludes: 'defaultTimeout',
    owner: 'dashboard execution',
    scope: 'process watchdog',
    lifecycleAffecting: true,
    rationale: 'Retired risk: hidden dashboard fallback killed local LLM runs before configured test timeouts. The entry follows the backend seam, not a file name.',
    allowed: false,
  },
  {
    id: 'dashboard-run-timeout-positive-check',
    file: 'packages/dashboard-server/src/execution/in-process-backend.ts',
    literal: '0',
    contextIncludes: 'timeoutMs > 0',
    owner: 'dashboard execution',
    scope: 'run timeout disabled sentinel',
    lifecycleAffecting: true,
    rationale: 'Only arms the per-run abort for positive explicit metadata or composed defaults.',
    allowed: true,
  },
  {
    id: 'dashboard-handle-retention',
    file: 'packages/dashboard-server/src/execution/in-process-backend.ts',
    literal: '5 * 60 * 1000',
    contextIncludes: 'DEFAULT_HANDLE_RETENTION_MS',
    owner: 'dashboard execution',
    scope: 'completed run event buffer retention',
    lifecycleAffecting: false,
    rationale: 'Retains buffered live events after terminal state; does not terminate execution.',
    allowed: true,
  },
  {
    id: 'dashboard-queued-execution-timeout-positive-guard',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '0',
    contextIncludes: 'value <= 0',
    owner: 'dashboard routes',
    scope: 'persisted-row execution timeout positive guard',
    lifecycleAffecting: true,
    rationale: '`in-process-backend.ts` reads `opts.timeout ?? defaultTimeout` and '
      + 'validates after, so a non-positive value DISARMS the default reclamation timer instead of '
      + 'falling back to it.',
    allowed: true,
  },
  {
    id: 'dashboard-queued-execution-timeout-ceiling',
    file: 'packages/dashboard-server/src/server/routes.ts',
    literal: '24 * 60 * 60 * 1000',
    contextIncludes: 'MAX_QUEUED_EXECUTION_TIMEOUT_MS',
    owner: 'dashboard routes',
    scope: 'persisted-row execution timeout ceiling',
    lifecycleAffecting: true,
    rationale: 'a persisted `metadata.timeout` beyond a day is a reclamation timer '
      + 'that will never fire; over the ceiling the seam falls back to the backend default rather '
      + 'than arming it.',
    allowed: true,
  },
]

const scannedFiles = [...new Set(timeoutInventory.map(entry => entry.file))]
const timeoutContextPattern = /(timeout|setTimeout|setInterval|stale|heartbeat|SIGKILL|SIGTERM|abort|deadline|defaultTimeout|termination|grace|retention|connection)/i
const numericExpressionPattern = /\b\d[\d_]*(?:\s*\*\s*\d[\d_]*)*\b/g

function normalizeLiteral(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// Comments are blanked to spaces so offsets and line numbers match; context still reads raw lines.
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, match =>
    match.replace(/[^\n]/g, ' '),
  )
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
      // Numeric extraction runs over the code-only projection (comments blanked); context
      // matching still uses the raw lines so `contextIncludes` prose anchors keep working.
      const codeLines = blankComments(content).split('\n')

      for (const retired of retiredInventory.filter(entry => entry.file === file)) {
        expect(content, `${retired.id} must remain retired`).not.toContain(retired.literal)
      }

      const discovered = lines.flatMap((line, index) => {
        const context = lines.slice(Math.max(0, index - 4), index + 1).join(' ').trim()
        const ownLineHasTimeoutContext = timeoutContextPattern.test(line)
        const timerArgumentLine = /^\s*},\s*\d[\d_\s*]*\)?/.test(line)
        if (!ownLineHasTimeoutContext && !timerArgumentLine) return []
        if (!timeoutContextPattern.test(context)) return []
        return [...codeLines[index].matchAll(numericExpressionPattern)].map(match => ({
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
