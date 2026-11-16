import { expect, test, vi } from 'vitest'
import type { RecordingEntry } from '@vostride/agent-qa-schema'
import i18n from '@/i18n'
import { initialPlayerSource, storePlayerSource, PLAYER_SOURCE_STORAGE_KEY, mediaErrorView } from '../player-view'

const recording: RecordingEntry = { state: 'present', ref: { id: `recording:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }, contentType: 'video/webm', byteLength: 10 }

test('PLAYER-STORED-SOURCE', () => {
  const getItem = vi.fn(() => 'frames')
  expect(initialPlayerSource(recording, 'time', { getItem })).toBe('frames')
  expect(getItem).toHaveBeenCalledWith(PLAYER_SOURCE_STORAGE_KEY)
  for (const value of ['video', 'bad', null]) expect(initialPlayerSource(recording, 'time', { getItem: () => value })).toBe('video')
  for (const value of ['frames', 'video', null]) {
    const storage = { getItem: vi.fn(() => value), setItem: vi.fn() }
    expect(initialPlayerSource(recording, 'ordinal', storage)).toBe('frames')
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  }
  const setItem = vi.fn()
  storePlayerSource('video', { setItem })
  expect(setItem).toHaveBeenCalledWith(PLAYER_SOURCE_STORAGE_KEY, 'video')
})
test('PLAYER-NO-OVERWRITE-WITHOUT-RECORDING', () => {
  const storage = { getItem: vi.fn(), setItem: vi.fn() }
  expect(initialPlayerSource(undefined, 'ordinal', storage)).toBe('frames')
  expect(initialPlayerSource({ state: 'absent', reason: 'not-captured' }, 'ordinal', storage)).toBe('frames')
  expect(storage.getItem).not.toHaveBeenCalled()
  expect(storage.setItem).not.toHaveBeenCalled()
})
test('PLAYER-STORAGE-UNAVAILABLE', () => {
  expect(initialPlayerSource(recording, 'time', { getItem: () => { throw Error('denied') } })).toBe('video')
  expect(initialPlayerSource(recording, 'ordinal', { getItem: () => { throw Error('denied') } })).toBe('frames')
  expect(() => storePlayerSource('frames', { setItem: () => { throw Error('denied') } })).not.toThrow()
})
test('PLAYER-MEDIA-ERROR-CLASSIFICATION', () => {
  for (const kind of ['frame', 'video'] as const) {
    expect(mediaErrorView(kind, { status: 404 })).toMatchObject({ state: 'unavailable', incomplete: true })
    expect(mediaErrorView(kind, { blobAbsent: true })).toMatchObject({ state: 'unavailable', incomplete: true })
    expect(mediaErrorView(kind, { status: 500 })).toMatchObject({ state: 'failed', failure: 'load' })
  }
})

test('a media error reads its text in the language shown when it is drawn', async () => {
  const english = {
    title: "Couldn't load the recording",
    explanation: "The recording exists but didn't load. Retry, or switch to Frames.",
    actionLabel: 'Retry loading the recording',
  }
  expect(mediaErrorView('video', { status: 500 })).toMatchObject(english)

  i18n.addResourceBundle('fr', 'translation', {
    'evidence.video.failed.load.title': "Impossible de charger l'enregistrement",
  })
  await i18n.changeLanguage('fr')
  try {
    expect(mediaErrorView('video', { status: 500 })).toMatchObject({
      ...english,
      title: "Impossible de charger l'enregistrement",
    })
  } finally {
    await i18n.changeLanguage('en')
  }

  expect(mediaErrorView('video', { status: 500 })).toMatchObject(english)
})
