import { format } from 'node:util'
import type WebSocket from 'ws'
import { parseTestFile, printRunText } from '@vostride/agent-qa-core'
import type { LiveSession } from './live-session.js'
import { LIVE_EDITOR_SUPERSEDED_CLOSE_CODE, LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from './types.js'
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
    let detached = false

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
    // 428 WR-01: a newer socket replaces this one. It is closed by name, its log poll stops, and
    // any command it still sends is ignored, so one page drives the session at a time.
    // 428 WR-02: a session ended elsewhere (DELETE, idle expiry) closes this socket as gone, so the
    // page leaves "connected". A terminate-session from this socket closes it itself.
    const generation = session.beginAttachment((reason) => {
      if (detached || cleanedUp) return
      detached = true
      if (logPollInterval) clearInterval(logPollInterval)
      if (reason === 'superseded') ws.close(LIVE_EDITOR_SUPERSEDED_CLOSE_CODE, 'superseded')
      else ws.close(LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, 'session_ended')
    })

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

    // 428 CR-01: a command outlives the socket that issued it. While this socket is the attached
    // one its replies go straight to it; once it has dropped or been superseded they go through the
    // session to the socket attached now, or wait for the next one.
    function reply(message: ServerMessage): void {
      if (!detached && session.isCurrentAttachment(generation)) {
        send(ws, message)
        return
      }
      session.deliver(message)
    }

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
      if (detached || !session.isCurrentAttachment(generation)) return
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
            reply({
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
                reply({
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
              reply({ type: 'step-cancelled' })
            } else {
              reply({
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
                if (tree) reply({ type: 'aria-tree', tree })
              } catch {}
            }
            reply({ type: 'session-state', state: session.getState() })
            const adapter = (session as any).adapter
            if (adapter && typeof adapter.isBrowserDisconnected === 'boolean' && adapter.isBrowserDisconnected) {
              reply({ type: 'browser-disconnected' })
            }
          } catch (err: any) {
            reply({ type: 'step-error', error: err.message })
            const adapter = (session as any).adapter
            if (adapter && typeof adapter.isBrowserDisconnected === 'boolean' && adapter.isBrowserDisconnected) {
              reply({ type: 'browser-disconnected' })
            }
          }
          break
        }

        case 'execute-hook': {
          if (session.status === 'executing') {
            reply({
              type: 'step-busy',
              currentStep: session.getState().currentStep ?? 'unknown',
            })
            return
          }
          try {
            await session.executeHookCommand(msg.phase, msg.hookId)
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        case 'execute-test': {
          if (session.status === 'executing') {
            reply({
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
              const line = `[ws-handler] execute-test: read failed for path=${msg.path}`
              printRunText(format(line, readErr), () => console.error(line, readErr))
              throw new Error(`Cannot read test file "${msg.path}": ${readErr?.message ?? String(readErr)}`)
            }

            const parsed = parseTestFile(raw, msg.path)
            if (parsed.errors.length > 0) {
              const line = `[ws-handler] execute-test: parse errors for ${msg.path}`
              printRunText(format(line, parsed.errors), () => console.error(line, parsed.errors))
              throw new Error(`Parse error in ${msg.path}: ${parsed.errors[0].message}`)
            }
            const testDef = parsed.tests[0]
            if (!testDef) {
              throw new Error(`Test file "${msg.path}" is empty or has no valid test documents`)
            }
            const stepInstructions: string[] = testDef.steps.map((s: string | { step: string }) =>
              typeof s === 'string' ? s : s.step,
            )
            const stepCount = stepInstructions.length
            const setupCount = (testDef.setup ?? []).length
            const teardownCount = (testDef.teardown ?? []).length
            printRunText(
              `[ws-handler] execute-test: starting "${testDef.name}" ` +
                `(${stepCount} steps, setup=${setupCount}, teardown=${teardownCount})`,
              (text) => console.log(text),
            )

            reply({
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

            const errorPart = result.error ? ` error=${result.error}` : ''
            printRunText(
              `[ws-handler] execute-test: finished "${testDef.name}" status=${result.status} ` +
                `duration=${result.duration}ms${errorPart}`,
              (text) => console.log(text),
            )
            reply({
              type: 'test-complete',
              test: {
                testExecutionId: msg.testExecutionId,
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: testDef.name,
              },
              result,
            })
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            const line = `[ws-handler] execute-test: caught error for path=${msg.path}`
            const detail = { message: err?.message, stack: err?.stack, code: err?.code }
            printRunText(format(line, detail), () => console.error(line, detail))
            reply({
              type: 'test-error',
              test: {
                testExecutionId: msg.testExecutionId,
                testIndex: msg.testIndex ?? 0,
                testId: msg.testId,
                testName: msg.path.split(/[\\/]/).pop() ?? msg.path,
              },
              error: err?.message ?? String(err),
            })
            reply({ type: 'session-state', state: session.getState() })
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

        case 'get-state': {
          reply({ type: 'session-state', state: session.getState() })
          break
        }

        case 'navigate': {
          if (session.status === 'executing') {
            reply({ type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.navigate(msg.url)
            reply({ type: 'navigate-complete', url })
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        case 'refresh-page': {
          if (session.status === 'executing') {
            reply({ type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.refreshPage()
            reply({ type: 'navigate-complete', url })
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        case 'go-back': {
          if (session.status === 'executing') {
            reply({ type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.goBack()
            reply({ type: 'navigate-complete', url })
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        case 'go-forward': {
          if (session.status === 'executing') {
            reply({ type: 'step-busy', currentStep: session.getState().currentStep ?? 'unknown' })
            return
          }
          try {
            const url = await session.goForward()
            reply({ type: 'navigate-complete', url })
            reply({ type: 'session-state', state: session.getState() })
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        case 'get-aria-tree': {
          if (session.status === 'executing') {
            reply({ type: 'error', message: 'Cannot inspect ARIA tree while step is executing' })
            return
          }
          try {
            const tree = await session.getAriaTree()
            if (tree) {
              reply({ type: 'aria-tree', tree })
            } else {
              reply({ type: 'error', message: 'ARIA tree unavailable' })
            }
          } catch (err: any) {
            reply({ type: 'error', message: err.message })
          }
          break
        }

        default: {
          reply({ type: 'error', message: `Unknown message type: ${msg.type}` })
          break
        }
      }
    })

    // 428 D-09: an unexpected drop DETACHES the session for the idle window so the page can
    // reconnect to the same browser, draft, page, hook state and lease. Explicit ends go through
    // terminate-session or DELETE and stay immediate. A superseded socket's late close is inert
    // (RESEARCH P4), and an in-flight step is cancelled so the reconnected page and the server
    // agree it was cancelled (RESEARCH P3, A3 taken as the default).
    function detach(): void {
      if (logPollInterval) clearInterval(logPollInterval)
      if (detached || cleanedUp) return
      detached = true
      if (!session.isCurrentAttachment(generation)) return
      session.attachMessageSink(null)
      if (session.status === 'executing') session.cancelStep()
      session.startIdleTimer(() => {
        onTerminate()
      })
    }

    ws.on('close', detach)
    ws.on('error', detach)
  }
}
