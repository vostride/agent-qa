import type WebSocket from 'ws'
import { parseTestFile } from '@vostride/agent-qa-core'
import type { LiveSession } from './live-session.js'
import type {
  LiveStepResultPayload,
  ServerMessage,
} from './types.js'
import type { TestFileManager } from '../tests/test-file-manager.js'

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function toStepResultPayload(result: Awaited<ReturnType<LiveSession['executeStepCommand']>>): LiveStepResultPayload {
  const status = result.status === 'passed'
    ? 'passed'
    : result.status === 'cancelled'
      ? 'cancelled'
      : 'failed'

  return {
    status,
    duration: result.duration,
    error: result.error,
    capturedVariables: result.capturedVariables,
    variableSnapshot: result.variableSnapshot,
    originalStepName: result.originalStepName,
    consoleLogs: result.consoleLogs,
    networkLogs: result.networkLogs,
    executionLogs: result.executionLogs,
    subActionsData: result.subActionsData,
  }
}

export function createSessionHandler(
  session: LiveSession,
  onTerminate: () => void,
  onTokenUsage?: (event: { modelName: string; promptTokens: number; completionTokens: number; source: 'live-editor' }) => void,
  testFileManager?: TestFileManager,
): (ws: WebSocket) => void {
  return (ws: WebSocket) => {
    let cleanedUp = false

    async function cleanupSession(): Promise<void> {
      if (cleanedUp) return
      cleanedUp = true
      if (logPollInterval) clearInterval(logPollInterval)
      if (session.status !== 'terminated') {
        await session.cleanup()
      }
      onTerminate()
    }

    session.clearIdleTimer()

    const state = session.getState()
    send(ws, {
      type: 'session-ready',
      sessionId: session.sessionId,
      platform: state.platform,
      interactive: state.interactive,
      error: state.terminalError,
    })
    session.attachMessageSink((message) => {
      send(ws, message)
    })
    send(ws, { type: 'session-state', state })

    let logPollInterval: ReturnType<typeof setInterval> | null = null
    const platform = state.platform
    if (platform !== 'web' && state.interactive) {
      logPollInterval = setInterval(async () => {
        if (session.status === 'executing') {
          return
        }
        try {
          const entries = await session.drainDeviceLogs()
          if (entries.length > 0) {
            send(ws, { type: 'device-logs', entries })
          }
        } catch {}
      }, 2000)
    }

    ws.on('message', async (data) => {
      let msg: any
      try {
        msg = JSON.parse(data.toString())
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' })
        return
      }

      switch (msg.type) {
        case 'execute-step': {
          if (session.status === 'executing') {
            send(ws, {
              type: 'step-busy',
              currentStep: session.getState().currentStep ?? 'unknown',
            })
            return
          }
          try {
            const result = await session.executeStepCommand(
              msg.stepInstruction,
              msg.stepIndex,
              (phase) => {
                send(ws, {
                  type: 'step-phase',
                  phase: phase.phase,
                  data: {
                    text: phase.text,
                    confidence: phase.confidence,
                    action: phase.action,
                    success: phase.success,
                    duration: phase.duration,
                  },
                })
              },
              msg.draft,
            )
            if (result.status === 'cancelled') {
              send(ws, { type: 'step-cancelled' })
            } else {
              send(ws, {
                type: 'step-complete',
                result: toStepResultPayload(result),
              })
              if (onTokenUsage && result.trace?.tokenUsage &&
                  (result.trace.tokenUsage.promptTokens > 0 || result.trace.tokenUsage.completionTokens > 0)) {
                onTokenUsage({
                  modelName: session.modelName,
                  promptTokens: result.trace.tokenUsage.promptTokens,
                  completionTokens: result.trace.tokenUsage.completionTokens,
                  source: 'live-editor',
                })
              }
              try {
                const tree = await session.getAriaTree()
                if (tree) send(ws, { type: 'aria-tree', tree })
              } catch {}
            }
            send(ws, { type: 'session-state', state: session.getState() })
            const adapter = (session as any).adapter
            if (adapter && typeof adapter.isBrowserDisconnected === 'boolean' && adapter.isBrowserDisconnected) {
              send(ws, { type: 'browser-disconnected' })
            }
          } catch (err: any) {
            send(ws, { type: 'step-error', error: err.message })
            const adapter = (session as any).adapter
            if (adapter && typeof adapter.isBrowserDisconnected === 'boolean' && adapter.isBrowserDisconnected) {
              send(ws, { type: 'browser-disconnected' })
            }
          }
          break
        }

        case 'execute-hook': {
          if (session.status === 'executing') {
            send(ws, {
              type: 'step-busy',
              currentStep: session.getState().currentStep ?? 'unknown',
            })
            return
          }
          try {
            await session.executeHookCommand(msg.phase, msg.hookId)
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        case 'execute-test': {
          if (session.status === 'executing') {
            send(ws, {
              type: 'step-busy',
              currentStep: session.getState().currentStep ?? 'unknown',
            })
            return
          }
          try {
            if (!testFileManager) {
              throw new Error('Test file manager unavailable — configure workspace.testMatch to run tests live')
            }

            let raw: string
            try {
              raw = await testFileManager.read(msg.path)
            } catch (readErr: any) {
              console.error(`[ws-handler] execute-test: read failed for path=${msg.path}`, readErr)
              throw new Error(`Cannot read test file "${msg.path}": ${readErr?.message ?? String(readErr)}`)
            }

            const parsed = parseTestFile(raw, msg.path)
            if (parsed.errors.length > 0) {
              console.error(`[ws-handler] execute-test: parse errors for ${msg.path}`, parsed.errors)
              throw new Error(`Parse error in ${msg.path}: ${parsed.errors[0].message}`)
            }
            const testDef = parsed.tests[0]
            if (!testDef) {
              throw new Error(`Test file "${msg.path}" is empty or has no valid test documents`)
            }
            const stepInstructions: string[] = testDef.steps.map((s: string | { step: string }) =>
              typeof s === 'string' ? s : s.step,
            )
            console.log(`[ws-handler] execute-test: starting "${testDef.name}" (${stepInstructions.length} steps, setup=${(testDef.setup ?? []).length}, teardown=${(testDef.teardown ?? []).length})`)

            send(ws, {
              type: 'test-start',
              test: {
                testExecutionId: msg.testExecutionId,
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: testDef.name,
              },
            })

            const result = await session.executeTestCommand(
              msg.testExecutionId,
              {
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: testDef.name,
                testContext: testDef.context,
                steps: stepInstructions,
                setup: testDef.setup ?? [],
                teardown: testDef.teardown ?? [],
              },
            )

            console.log(`[ws-handler] execute-test: finished "${testDef.name}" status=${result.status} duration=${result.duration}ms${result.error ? ` error=${result.error}` : ''}`)
            send(ws, {
              type: 'test-complete',
              test: {
                testExecutionId: msg.testExecutionId,
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: testDef.name,
              },
              result,
            })
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            console.error(`[ws-handler] execute-test: caught error for path=${msg.path}`, {
              message: err?.message,
              stack: err?.stack,
              code: err?.code,
            })
            send(ws, {
              type: 'test-error',
              test: {
                testExecutionId: msg.testExecutionId,
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: msg.path.split(/[\\/]/).pop() ?? msg.path,
              },
              error: err?.message ?? String(err),
            })
            send(ws, { type: 'session-state', state: session.getState() })
          }
          break
        }

        case 'cancel-step': {
          session.cancelStep()
          break
        }

        case 'terminate-session': {
          await cleanupSession()
          send(ws, { type: 'session-terminated' })
          ws.close(1000, 'Session terminated')
          break
        }

        case 'get-screenshot': {
          const buf = await session.getScreenshot()
          if (buf) {
            send(ws, { type: 'screenshot', data: buf.toString('base64') })
          } else {
            send(ws, { type: 'error', message: 'Screenshot unavailable' })
          }
          break
        }

        case 'get-state': {
          send(ws, { type: 'session-state', state: session.getState() })
          break
        }

        case 'navigate': {
          if (session.status === 'executing') {
            send(ws, { type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.navigate(msg.url)
            send(ws, { type: 'navigate-complete', url })
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        case 'refresh-page': {
          if (session.status === 'executing') {
            send(ws, { type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.refreshPage()
            send(ws, { type: 'navigate-complete', url })
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        case 'go-back': {
          if (session.status === 'executing') {
            send(ws, { type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.goBack()
            send(ws, { type: 'navigate-complete', url })
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        case 'go-forward': {
          if (session.status === 'executing') {
            send(ws, { type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.goForward()
            send(ws, { type: 'navigate-complete', url })
            send(ws, { type: 'session-state', state: session.getState() })
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        case 'get-aria-tree': {
          if (session.status === 'executing') {
            send(ws, { type: 'error', message: 'Cannot inspect ARIA tree while step is executing' })
            return
          }
          try {
            const tree = await session.getAriaTree()
            if (tree) {
              send(ws, { type: 'aria-tree', tree })
            } else {
              send(ws, { type: 'error', message: 'ARIA tree unavailable' })
            }
          } catch (err: any) {
            send(ws, { type: 'error', message: err.message })
          }
          break
        }

        default: {
          send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` })
          break
        }
      }
    })

    ws.on('close', () => {
      session.attachMessageSink(null)
      void cleanupSession()
    })

    ws.on('error', () => {
      session.attachMessageSink(null)
      void cleanupSession()
    })
  }
}
