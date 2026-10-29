// `editor.liveurl`, driven through its own registry exactly as live-url.test.ts drives
// `runs.liveurl`. Every refusal is asserted by `error.name`, because that is what the doors map.

import { EditorLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import type { FunctionCaller, LiveStreamDeclaration, LiveUrlSigner } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../invoke.js'
import { LIVE_URL_TOKEN_VERSION, LIVE_URL_TTL_MS, validateLiveUrlToken } from '../live-url.js'
import { EDITOR_LIVE_URL_FUNCTION_ID, editorLiveUrlSpec } from '../ops/editor-live-url.js'
import { createRegistryFromSpecs } from '../registry.js'
import type { FunctionDeps, FunctionSpec, LiveViewPort } from '../spec.js'

const fakeSigner: LiveUrlSigner = {
  sign: (data: string) => `sig:${data}`,
  equals: (a: string, b: string) => a === b,
}

const NOW = 1_700_000_000_000
const ORIGIN = 'http://127.0.0.1:3470'
const DECLARATION: LiveStreamDeclaration = { kind: 'cdp-screencast' }

// no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither. The signed token's own scope claim is a live-link control and stays.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

interface RecordingLiveView {
  readonly port: LiveViewPort
  readonly minted: string[]
  readonly runLookups: string[]
}

function recordingLiveView(input: {
  origin?: string | undefined
  editor?: 'absent' | ((sessionId: string) => LiveStreamDeclaration | undefined)
} = {}): RecordingLiveView {
  const minted: string[] = []
  const runLookups: string[] = []
  const editor = input.editor ?? ((sessionId: string) => (sessionId === 's1' ? DECLARATION : undefined))
  const port: LiveViewPort = {
    signer: fakeSigner,
    origin: () => ('origin' in input ? input.origin : ORIGIN),
    now: () => NOW,
    capabilityOf: (runId) => {
      runLookups.push(runId)
      return { kind: 'cdp-screencast' }
    },
    onMinted: (token) => { minted.push(token) },
    ...(editor === 'absent' ? {} : { editorCapabilityOf: editor }),
  }
  return { port, minted, runLookups }
}

function depsWith(liveView: LiveViewPort | undefined): FunctionDeps {
  return {
    runs: {} as FunctionDeps['runs'],
    knowledge: {} as FunctionDeps['knowledge'],
    config: {} as FunctionDeps['config'],
    entities: {} as FunctionDeps['entities'],
    ...(liveView === undefined ? {} : { liveView }),
  } as FunctionDeps
}

function registryWith(liveView: LiveViewPort | undefined): ReturnType<typeof createRegistryFromSpecs> {
  return createRegistryFromSpecs([editorLiveUrlSpec as FunctionSpec], {
    deps: depsWith(liveView),
    // no `resolveExecutionContext` registry option; the registry reads
    // no context.
  })
}

function mint(liveView: LiveViewPort | undefined, sessionId = 's1'): Promise<unknown> {
  return invokeFunction(registryWith(liveView), EDITOR_LIVE_URL_FUNCTION_ID, { sessionId }, CALLER)
}

describe('editor.liveurl mints the editor subject', () => {
  it('MINTS-EDITOR-SUBJECT', async () => {
    const live = recordingLiveView()
    const result = EditorLiveUrlResultSchema.parse(await mint(live.port))
    const [prefix, token] = result.liveUrl.split('#') as [string, string | undefined]
    expect(prefix, 'origin + the served embed path, and the token rides the fragment only')
      .toBe(`${ORIGIN}/live/s1`)
    expect(token).toBeDefined()
    expect(validateLiveUrlToken(fakeSigner, token ?? '', {
      subject: { kind: 'editor', id: 's1' },
      now: NOW,
    })).toMatchObject({ kind: 'ok', claims: { subject: { kind: 'editor', sessionId: 's1' } } })
    expect(
      validateLiveUrlToken(fakeSigner, token ?? '', { subject: { kind: 'run', id: 's1' }, now: NOW }),
      'an editor token never opens a run with the same id',
    ).toEqual({ kind: 'refused', reason: 'scope_mismatch' })
    expect(result.expiresAt).toBe(NOW + LIVE_URL_TTL_MS)
    expect(result.stream, 'the result echoes the declared capability').toEqual(DECLARATION)
    expect(live.runLookups, 'the op reads the editor lookup only, never the run registry')
      .toEqual([])
  })

  it('ON-MINTED-CALLED', async () => {
    const live = recordingLiveView()
    const result = EditorLiveUrlResultSchema.parse(await mint(live.port))
    expect(live.minted, 'one registration per mint, with the bare token')
      .toEqual([result.liveUrl.split('#')[1]])
  })

  it('NO-EDITOR-PORT-UNAVAILABLE', async () => {
    await expect(
      editorLiveUrlSpec.invoke({ sessionId: 's1' }, depsWith(undefined)),
      'no live-view port at all',
    ).rejects.toMatchObject({ name: 'LiveViewUnavailableError' })
    await expect(
      mint(undefined),
      'and through the registry the op is listed unbound before it dispatches',
    ).rejects.toMatchObject({ name: 'FunctionNotBoundError' })
    await expect(mint(recordingLiveView({ origin: undefined }).port), 'no served origin')
      .rejects.toMatchObject({ name: 'LiveViewUnavailableError' })
    const noEditor = recordingLiveView({ editor: 'absent' })
    await expect(mint(noEditor.port), 'a host that serves no live editor')
      .rejects.toMatchObject({ name: 'LiveViewUnavailableError' })
    expect(noEditor.minted, 'no token is minted on a refusal').toEqual([])
  })

  it('UNKNOWN-SESSION-BY-NAME', async () => {
    const live = recordingLiveView()
    await expect(mint(live.port, 'nope'))
      .rejects.toMatchObject({ name: 'UnknownLiveEditorSessionError', sessionId: 'nope' })
    expect(live.minted, 'no token is minted for an unknown session').toEqual([])
    expect(live.runLookups, 'an unknown editor session is never retried as a run').toEqual([])
  })

  it('CLASSIFY-HAS-NO-TOKEN', async () => {
    const live = recordingLiveView()
    const result = EditorLiveUrlResultSchema.parse(await mint(live.port))
    const token = result.liveUrl.split('#')[1] ?? ''
    expect(token.startsWith(`${LIVE_URL_TOKEN_VERSION}.`), 'the result carries a live credential to leak').toBe(true)
    const outcome = editorLiveUrlSpec.classify?.(result).outcome ?? ''
    expect(outcome).toBe('liveUrl minted for a live editor session')
    expect(outcome).not.toContain(result.liveUrl)
    expect(outcome).not.toContain(token)
    expect(outcome).not.toContain(`${LIVE_URL_TOKEN_VERSION}.`)
  })
})
