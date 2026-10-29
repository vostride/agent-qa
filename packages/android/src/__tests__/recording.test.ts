import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlatformAdapter, RecordingCapability } from '@vostride/agent-qa-runner'
import { createRunEventBus, createMemberEventSink, runMemberTest } from '@vostride/agent-qa-runner'
import { remote } from 'webdriverio'
import { AndroidPlatformAdapter } from '../adapter.js'

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

let adapter: AndroidPlatformAdapter
let videoDir: string
const driver = {
  startRecordingScreen: vi.fn(),
  stopRecordingScreen: vi.fn(),
  deleteSession: vi.fn(),
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(remote).mockResolvedValue(driver as unknown as WebdriverIO.Browser)
  videoDir = await mkdtemp(join(tmpdir(), 'agent-qa-android-recording-'))
  adapter = new AndroidPlatformAdapter()
  await adapter.setup({
    platform: 'android',
    recording: { enabled: true, videoDir, videoSize: { width: 1080, height: 1920 } },
  })
})

afterEach(async () => {
  await adapter.cleanup()
  await rm(videoDir, { recursive: true, force: true })
})

function recording(): RecordingCapability {
  const capability = (adapter as PlatformAdapter<'android'>).recording
  expect(capability, 'initialized Android adapter exposes recording').toBeDefined()
  return capability!
}

it('REC-ANDROID-PER-MEMBER: two members write distinct mp4 files without setup recording', async () => {
  const capability = recording()
  expect(recording()).toBe(capability)
  expect(driver.startRecordingScreen).not.toHaveBeenCalled()
  const paths: string[] = []
  for (const contents of ['first member', 'second member']) {
    driver.stopRecordingScreen.mockResolvedValue(Buffer.from(contents).toString('base64'))
    await capability.start()
    const stopped = await capability.stop()
    expect(stopped?.contentType).toBe('video/mp4')
    expect(dirname(stopped!.stagingPath)).toBe(videoDir)
    expect(stopped!.stagingPath).toMatch(/[a-f0-9-]{36}\.mp4$/)
    expect(await readFile(stopped!.stagingPath, 'utf8')).toBe(contents)
    paths.push(stopped!.stagingPath)
  }
  expect(new Set(paths).size).toBe(2)
  expect(driver.startRecordingScreen).toHaveBeenCalledTimes(2)
  expect(driver.startRecordingScreen).toHaveBeenNthCalledWith(1, {
    videoSize: '1080x1920', timeLimit: 1800, forceRestart: true,
  })
  expect(driver.startRecordingScreen).toHaveBeenNthCalledWith(2, {
    videoSize: '1080x1920', timeLimit: 1800, forceRestart: true,
  })
})

it('REC-ANDROID-NO-ZERO: start does not claim a clock zero', async () => {
  const result = await recording().start()
  expect(result).toEqual({})
  expect(result).not.toHaveProperty('zeroMs')
})

it('REC-ANDROID-THROW-PROPAGATES: stop failure rejects and cleanup still deletes session', async () => {
  const capability = recording()
  await capability.start()
  const error = new Error('device recording failed')
  driver.stopRecordingScreen.mockRejectedValue(error)
  await expect(capability.stop()).rejects.toBe(error)
  await expect(adapter.cleanup()).resolves.toBeUndefined()
  expect(driver.deleteSession).toHaveBeenCalledOnce()
})

it('REC-ANDROID-START-THROWS: start failure rejects and cleanup still stops the driver', async () => {
  const capability = recording()
  const error = new Error('recording start failed')
  driver.startRecordingScreen.mockRejectedValue(error)
  await expect(capability.start()).rejects.toBe(error)
  await adapter.cleanup()
  expect(driver.stopRecordingScreen).toHaveBeenCalledOnce()
  expect(driver.deleteSession).toHaveBeenCalledOnce()
})

it('REC-ANDROID-EMPTY: empty payload produces no staging file', async () => {
  const capability = recording()
  await capability.start()
  driver.stopRecordingScreen.mockResolvedValue('')
  await expect(capability.stop()).resolves.toBeUndefined()
  expect(await readdir(videoDir)).toEqual([])
})

it('REC-ANDROID-IDLE: idle stop does not contact the driver', async () => {
  await expect(recording().stop()).resolves.toBeUndefined()
  expect(driver.stopRecordingScreen).not.toHaveBeenCalled()
})

it('REC-ANDROID-CLEANUP: running capture stops before session deletion', async () => {
  await recording().start()
  await adapter.cleanup()
  expect(driver.stopRecordingScreen).toHaveBeenCalledOnce()
  expect(driver.stopRecordingScreen.mock.invocationCallOrder[0])
    .toBeLessThan(driver.deleteSession.mock.invocationCallOrder[0])
  expect((adapter as PlatformAdapter<'android'>).recording).toBeUndefined()
})

it.each(['start', 'stop'] as const)('REC-ANDROID-RECOVER-%s: failed attempt never returns bytes and the same capability can retry', async failure => {
  const capability = recording()
  const error = new Error('transient recording failure')
  if (failure === 'start') driver.startRecordingScreen.mockRejectedValueOnce(error)
  else driver.stopRecordingScreen.mockRejectedValueOnce(error)
  if (failure === 'start') await expect(capability.start()).rejects.toBe(error)
  else {
    await capability.start()
    await expect(capability.stop()).rejects.toBe(error)
  }
  expect(await readdir(videoDir)).toEqual([])
  driver.stopRecordingScreen.mockResolvedValue(Buffer.from('successful retry').toString('base64'))
  await capability.start()
  const stopped = await capability.stop()
  expect(await readFile(stopped!.stagingPath, 'utf8')).toBe('successful retry')
  expect(driver.startRecordingScreen).toHaveBeenCalledTimes(2)
})

it('REC-ANDROID-RECOVERY-EXCLUSIVE: pending cleanup owns the guard and persistent failures remain driver failures', async () => {
  const capability = recording()
  const error = new Error('driver cannot stop')
  await capability.start()
  let release!: () => void
  driver.stopRecordingScreen.mockRejectedValueOnce(error)
    .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const stopping = expect(capability.stop()).rejects.toBe(error)
  await vi.waitFor(() => expect(release).toBeDefined())
  await expect(capability.start()).rejects.toThrow(/already/i)
  release()
  await stopping
  await capability.start()
  driver.stopRecordingScreen.mockRejectedValue(error)
  await expect(capability.stop()).rejects.toBe(error)
  await expect(capability.start()).rejects.toBe(error)
  driver.stopRecordingScreen.mockResolvedValue('')
  await capability.start()
  await capability.stop()
})

it.each(['start', 'stop'] as const)('REC-ANDROID-RUNNER-RETRY-%s: only the successful retry reaches persistence', async failure => {
  if (failure === 'start') driver.startRecordingScreen.mockRejectedValueOnce(new Error('first start failed'))
  else driver.stopRecordingScreen.mockRejectedValueOnce(new Error('first stop failed'))
  driver.stopRecordingScreen.mockResolvedValue(Buffer.from('retry recording').toString('base64'))
  const ref = { id: `recording:${'a'.repeat(64)}` as const, sha: 'a'.repeat(64) }
  const persistRecording = vi.fn((path: string) => {
    expect(driver.startRecordingScreen).toHaveBeenCalledTimes(2)
    expect(readFileSync(path, 'utf8')).toBe('retry recording')
    return { ref, byteLength: 15 }
  })
  let attempt = 0
  const result = await runMemberTest({ testId: 'synthetic-retry', name: 'Retry', filePath: 'synthetic.yaml',
    steps: ['Run'], meta: { retries: 1 } }, {
    adapter, planner: {} as never, plannerModel: {} as never, verifierModel: {} as never,
    sink: createMemberEventSink({ bus: createRunEventBus({ runId: 'synthetic-retry-run' }),
      mask: text => text, testIndex: 0 }),
    testIndex: 0, abortSignal: new AbortController().signal, recording: { enabled: true },
    evidenceArtifacts: { persistDecisionScreenshot: () => ({ id: `decision-screenshot:${ref.sha}`, sha: ref.sha }),
      getBlob: () => undefined, persistRecording },
    executeStep: async name => ({ name, status: attempt++ === 0 ? 'failed' : 'passed', duration: 0 }),
  })
  expect(result.status).toBe('passed')
  expect(result.retryCount).toBe(1)
  expect(result.recording).toMatchObject({ state: 'present', ref })
  expect(result.firstFailedAttempt?.result).not.toHaveProperty('recording')
  expect(persistRecording).toHaveBeenCalledOnce()
  expect(await readdir(videoDir)).toHaveLength(1)
})
