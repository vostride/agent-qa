import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { RemoteRefusalError, type RemoteProgress } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import type { PluginHostProgress, PluginUploadRequest } from '../host-pool.js'
import { createHostProject, methodsOf, type HostProject } from './plugin-host-fixtures.js'

let project: HostProject | undefined

function host(): HostProject {
  project = createHostProject()
  return project
}

afterEach(async () => {
  await project?.cleanup()
  project = undefined
})

function appFile(p: HostProject, name: string, content: string): string {
  const path = join(p.fixture.root, name)
  writeFileSync(path, content)
  return path
}

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function upload(
  remote: string,
  entry: string,
  path: string,
  extra: Partial<PluginUploadRequest> = {},
): PluginUploadRequest {
  return {
    remote,
    plugin: { entry, settings: { project: 'shop' } },
    platform: 'android',
    path,
    deadlineMs: 10_000,
    ...extra,
  }
}

async function refusalOf(work: Promise<unknown>): Promise<RemoteRefusalError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RemoteRefusalError)
  return error as RemoteRefusalError
}

function uploadLines(p: HostProject, entry: Parameters<HostProject['ledger']>[0]) {
  return p.ledger(entry).filter((line) => line.method === 'uploadApp')
}

describe("a plugin's app upload", () => {
  it("sends the file's real sha256 and size with the remote, its settings and the platform, and returns the plugin's ref", async () => {
    const p = host()
    const lab = p.entry(
      'lab',
      { recordParams: true, upload: { ref: 'bs://shop-1' } },
      { methods: ['uploadApp'] },
    )
    const content = 'an android build\n'.repeat(4096)
    const path = appFile(p, 'shop.apk', content)
    const pool = p.pool([lab])

    const uploaded = await pool.uploadApp(upload('lab-a', 'lab', path))

    expect(uploaded?.ref).toBe('bs://shop-1')
    expect(uploadLines(p, lab)).toEqual([
      {
        method: 'uploadApp',
        remote: 'lab-a',
        settings: { project: 'shop' },
        platform: 'android',
        path,
        sha256: sha256Of(content),
        size: Buffer.byteLength(content),
      },
    ])
  })

  it('cancels an upload still running at uploadTimeout and refuses it as timeout', async () => {
    const p = host()
    const lab = p.entry(
      'lab',
      { script: { uploadApp: { delayMs: 10_000 } } },
      { methods: ['uploadApp'] },
    )
    const path = appFile(p, 'shop.apk', 'slow build')
    const pool = p.pool([lab])

    const started = Date.now()
    const refused = await refusalOf(
      pool.uploadApp(upload('lab-a', 'lab', path, { deadlineMs: 300 })),
    )

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(refused.kind).toBe('timeout')
    expect(refused.message).toBe(
      'Remote lab-a: plugin entry lab did not answer uploadApp within 300ms.',
    )
  })

  it('refuses a plugin that declares no uploadApp, saying to set app.ref', async () => {
    const p = host()
    const lab = p.entry('lab', {}, { methods: [] })
    const path = appFile(p, 'shop.apk', 'a build')
    const pool = p.pool([lab])

    const refused = await refusalOf(pool.uploadApp(upload('lab-a', 'lab', path)))

    expect(refused.kind).toBe('refused')
    expect(refused.message).toBe(
      'Remote lab-a: plugin entry lab uploads no apps; set app.ref on the target to an app the service already has.',
    )
    expect(methodsOf(p.ledger(lab))).toEqual(['initialize'])
  })

  it('uploads one file once for two requests in flight at once and for a later one', async () => {
    const p = host()
    const lab = p.entry(
      'lab',
      { upload: { ref: 'bs://shop-1' }, script: { uploadApp: { delayMs: 200 } } },
      { methods: ['uploadApp'] },
    )
    const path = appFile(p, 'shop.apk', 'one build')
    const copy = appFile(p, 'shop-copy.apk', 'one build')
    const pool = p.pool([lab])

    const both = await Promise.all([
      pool.uploadApp(upload('lab-a', 'lab', path)),
      pool.uploadApp(upload('lab-a', 'lab', copy)),
    ])
    const later = await pool.uploadApp(upload('lab-a', 'lab', path))

    expect(both).toEqual([{ ref: 'bs://shop-1' }, { ref: 'bs://shop-1' }])
    expect(later).toEqual({ ref: 'bs://shop-1' })
    expect(uploadLines(p, lab)).toHaveLength(1)
  })

  it('uploads again for a different file, another platform or another plugins entry', async () => {
    const p = host()
    const lab = p.entry('lab', {}, { methods: ['uploadApp'] })
    const farm = p.entry('farm', {}, { methods: ['uploadApp'] })
    const first = appFile(p, 'shop.apk', 'build one')
    const second = appFile(p, 'shop-2.apk', 'build two')
    const pool = p.pool([lab, farm])

    await pool.uploadApp(upload('lab-a', 'lab', first))
    await pool.uploadApp(upload('lab-a', 'lab', second))
    await pool.uploadApp(upload('lab-a', 'lab', first, { platform: 'ios' }))
    await pool.uploadApp(upload('farm-a', 'farm', first))

    expect(uploadLines(p, lab)).toHaveLength(3)
    expect(uploadLines(p, farm)).toHaveLength(1)
  })

  it('remembers a refused upload, so a later request gets the same refusal without asking again', async () => {
    const p = host()
    const lab = p.entry(
      'lab',
      { script: { uploadApp: { error: { kind: 'refused', message: 'The app is too large' } } } },
      { methods: ['uploadApp'] },
    )
    const path = appFile(p, 'shop.apk', 'a large build')
    const pool = p.pool([lab])

    const first = await refusalOf(pool.uploadApp(upload('lab-a', 'lab', path)))
    const second = await refusalOf(pool.uploadApp(upload('lab-a', 'lab', path)))

    expect(first.message).toBe('Remote lab-a: The app is too large.')
    expect(second.message).toBe(first.message)
    expect(second.kind).toBe('refused')
    expect(uploadLines(p, lab)).toHaveLength(1)
  })

  it("passes the plugin's upload progress to the request's listener and the pool's", async () => {
    const p = host()
    const lab = p.entry(
      'lab',
      { progress: [{ message: 'uploading app (12 MB)', percent: 40 }] },
      { methods: ['uploadApp'] },
    )
    const path = appFile(p, 'shop.apk', 'a build')
    const pooled: PluginHostProgress[] = []
    const pool = p.pool([lab], { onProgress: (event) => pooled.push(event) })
    const own: RemoteProgress[] = []

    await pool.uploadApp(
      upload('lab-a', 'lab', path, { onProgress: (progress: RemoteProgress) => own.push(progress) }),
    )

    expect(own).toEqual([{ message: 'uploading app (12 MB)', percent: 40 }])
    expect(pooled).toEqual([
      { remote: 'lab-a', entry: 'lab', message: 'uploading app (12 MB)', percent: 40 },
    ])
  })

  it('refuses an app file it cannot read, naming the path', async () => {
    const p = host()
    const lab = p.entry('lab', {}, { methods: ['uploadApp'] })
    const path = join(p.fixture.root, 'missing.apk')
    const pool = p.pool([lab])

    const refused = await refusalOf(pool.uploadApp(upload('lab-a', 'lab', path)))

    expect(refused.kind).toBe('refused')
    expect(refused.message).toBe(`Remote lab-a: the app at ${path} could not be read.`)
    expect(uploadLines(p, lab)).toHaveLength(0)
  })
})
