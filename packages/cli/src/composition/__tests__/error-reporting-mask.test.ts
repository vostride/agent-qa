// The envelope walk masks every string but the ids and protocol fields where they sit, the home
// folder reads as a tilde in every spelling, and an envelope that cannot be masked is never sent.

import { describe, expect, it } from 'vitest'

import {
  recordingReportTransport,
  serializedEnvelopes,
} from '../../__tests__/error-report-recorder.js'
import type { RecordedEnvelope } from '../../__tests__/error-report-recorder.js'
import {
  createMaskingTransport,
  createRepeatFilter,
  homeSpellings,
  maskEnvelope,
  rewriteHome,
} from '../error-reporting-mask.js'
import type { MaskingTransportOptions, TextMask } from '../error-reporting-mask.js'

const SECRET = 'Hunter-42-zz'
const MARKER = '[secret:API_TOKEN]'
const HOME = '/Users/canary-user'
const REAL_HOME = '/System/Volumes/Data/Users/canary-user'
const TRANSPORT_OPTIONS = {
  url: 'http://127.0.0.1:9/api/1/envelope/',
  recordDroppedEvent: () => {},
}

const maskSecret: TextMask = (text) => text.replaceAll(SECRET, MARKER)
const unmasked: TextMask = (text) => text

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

// The path of every string a total mask left as it was, in the order the walk meets them.
function keptStrings(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === 'string') return value === '[masked]' ? [] : [path.join('.')]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => keptStrings(item, [...path, key]))
}

function maskingTransport(resolveMask: () => TextMask, options: MaskingTransportOptions = {}) {
  const recorder = recordingReportTransport()
  const transport = createMaskingTransport(recorder.transport, resolveMask, options)(
    TRANSPORT_OPTIONS,
  )
  return { recorder, transport }
}

// An event and a span container that quote `text` in every free-text field the SDK fills.
function envelopeQuoting(text: string) {
  return [
    {
      event_id: 'e0'.repeat(16),
      sent_at: '2026-11-10T12:00:00.000Z',
      sdk: { name: 'sentry.javascript.node', version: '11.11.0' },
      trace: {
        trace_id: 'a1'.repeat(16),
        public_key: 'key',
        transaction: `command ${text}`,
        environment: 'production',
      },
    },
    [
      [
        { type: 'event' },
        {
          event_id: 'e0'.repeat(16),
          platform: 'node',
          level: 'error',
          message: `message ${text}`,
          exception: {
            values: [
              {
                type: 'Error',
                value: `failed with ${text}`,
                stacktrace: {
                  frames: [
                    {
                      filename: `/srv/app/${text}.js`,
                      abs_path: `/srv/app/${text}.js`,
                      function: 'load',
                      lineno: 3,
                      colno: 7,
                      pre_context: [`const before = '${text}'`],
                      context_line: `throw new Error('${text}')`,
                      post_context: [`const after = '${text}'`],
                    },
                  ],
                },
              },
            ],
          },
          breadcrumbs: [
            { category: 'console', message: `printed ${text}`, data: { arguments: [text] } },
          ],
          contexts: { app: { app_name: `app ${text}` } },
          tags: { step: `step ${text}` },
          debug_meta: {
            images: [
              { type: 'sourcemap', code_file: `/srv/app/${text}.js`, debug_id: 'd2'.repeat(16) },
            ],
          },
        },
      ],
      [
        { type: 'span', item_count: 1, content_type: 'application/vnd.sentry.items.span.v2+json' },
        {
          version: 2,
          items: [
            {
              trace_id: 'a1'.repeat(16),
              span_id: 'b3'.repeat(8),
              name: `span ${text}`,
              attributes: { 'agent_qa.step': { type: 'string', value: `attribute ${text}` } },
            },
          ],
        },
      ],
    ],
  ]
}

describe('the envelope walk', () => {
  it('masks every string of an event and a span container, the envelope header included', () => {
    const envelope = envelopeQuoting(SECRET)

    const sent = JSON.stringify(maskEnvelope(envelope, maskSecret))

    expect(sent).not.toContain(SECRET)
    expect(occurrences(sent, MARKER)).toBe(occurrences(JSON.stringify(envelope), SECRET))
    expect(sent).toContain(`"transaction":"command ${MARKER}"`)
  })

  it('leaves the value under a structural key as it is while masking the same text elsewhere', () => {
    const eventId = '0de1'.repeat(8)
    const traceId = 'de42'.repeat(8)
    const shortSecret: TextMask = (text) => text.replaceAll('de', '[secret:SHORT]')
    const envelope = [
      {
        event_id: eventId,
        sdk: { name: 'sentry.javascript.node', integrations: ['LinkedErrors'] },
      },
      [
        [
          { type: 'event' },
          {
            event_id: eventId,
            platform: 'node',
            contexts: { trace: { trace_id: traceId } },
            exception: { values: [{ type: 'Error', value: 'a decoder failed' }] },
          },
        ],
      ],
    ]

    const sent = JSON.stringify(maskEnvelope(envelope, shortSecret))

    expect(sent).toContain(
      `{"event_id":"${eventId}","sdk":{"name":"sentry.javascript.node","integrations":["LinkedErrors"]}}`,
    )
    expect(sent).toContain(`"event_id":"${eventId}","platform":"node"`)
    expect(sent).toContain(`"trace_id":"${traceId}"`)
    expect(sent).toContain('"value":"a [secret:SHORT]co[secret:SHORT]r failed"')
  })

  it('keeps the ids and protocol fields where they sit, and masks text under the same key names anywhere else', () => {
    const free = {
      type: 'free type',
      platform: 'free platform',
      level: 'free level',
      dsn: 'free dsn',
      sdk: { name: 'free sdk name' },
    }
    const envelope = [
      {
        event_id: 'e0'.repeat(16),
        sent_at: '2026-01-01T00:00:00.000Z',
        dsn: 'http://key@127.0.0.1:9/1',
        sdk: { name: 'sentry.javascript.node', version: '11.11.0' },
        trace: { trace_id: 'a1'.repeat(16), public_key: 'key', transaction: 'agent-qa run' },
      },
      [
        [
          { type: 'event' },
          {
            event_id: 'e0'.repeat(16),
            platform: 'node',
            level: 'error',
            sdk: { name: 'sentry.javascript.node', integrations: ['LinkedErrors'] },
            contexts: {
              trace: { trace_id: 'a1'.repeat(16), span_id: 'b3'.repeat(8), op: 'run' },
              thrown: free,
            },
            breadcrumbs: [
              { type: 'default', level: 'log', category: 'console', data: { arguments: [free] } },
            ],
            extra: free,
            tags: { level: 'free tag' },
            exception: {
              values: [{ type: 'FreeNamedError', value: 'v', mechanism: { type: 'generic' } }],
            },
            debug_meta: {
              images: [{ type: 'sourcemap', debug_id: 'd2'.repeat(16), code_file: 'f' }],
            },
          },
        ],
        [
          SPAN_ITEM[0],
          {
            items: [
              {
                trace_id: 'a1'.repeat(16),
                span_id: 'b4'.repeat(8),
                parent_span_id: 'b3'.repeat(8),
                name: 'step',
                status: 'ok',
                attributes: {
                  'agent_qa.step': { type: 'string', value: 'free value' },
                  type: { type: 'string', value: 'free type attribute' },
                },
              },
            ],
          },
        ],
      ],
    ]

    const kept = keptStrings(maskEnvelope(envelope, () => '[masked]'))

    expect(kept).toEqual([
      '0.event_id',
      '0.sent_at',
      '0.dsn',
      '0.sdk.name',
      '0.sdk.version',
      '0.trace.trace_id',
      '0.trace.public_key',
      '1.0.0.type',
      '1.0.1.event_id',
      '1.0.1.platform',
      '1.0.1.level',
      '1.0.1.sdk.name',
      '1.0.1.sdk.integrations.0',
      '1.0.1.contexts.trace.trace_id',
      '1.0.1.contexts.trace.span_id',
      '1.0.1.breadcrumbs.0.type',
      '1.0.1.breadcrumbs.0.level',
      '1.0.1.exception.values.0.mechanism.type',
      '1.0.1.debug_meta.images.0.type',
      '1.0.1.debug_meta.images.0.debug_id',
      '1.1.0.type',
      '1.1.0.content_type',
      '1.1.1.items.0.trace_id',
      '1.1.1.items.0.span_id',
      '1.1.1.items.0.parent_span_id',
      '1.1.1.items.0.status',
      '1.1.1.items.0.attributes.agent_qa.step.type',
      '1.1.1.items.0.attributes.type.type',
    ])
  })

  it('passes a binary item body through as it is and masks the strings beside it', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const buffer = Buffer.from('binary body')
    const envelope = [
      { event_id: 'e0'.repeat(16) },
      [
        [{ type: 'attachment', length: bytes.length, filename: `${SECRET}.bin` }, bytes],
        [{ type: 'attachment', length: buffer.length, filename: 'buffer.bin' }, buffer],
      ],
    ] as const

    const [, [first, second]] = maskEnvelope(envelope, maskSecret)

    expect(first[1]).toBe(bytes)
    expect(second[1]).toBe(buffer)
    expect(first[0]).toEqual({ type: 'attachment', length: 3, filename: `${MARKER}.bin` })
  })
})

describe('the home folder', () => {
  it('reads as a tilde in every spelling the home takes', () => {
    const spellings = homeSpellings(HOME, REAL_HOME)
    const texts = {
      given: `${HOME}/project/a.ts`,
      real: `${REAL_HOME}/project/b.ts`,
      backslashes: '\\Users\\canary-user\\project\\c.ts',
      jsonEscaped: JSON.stringify({ path: '\\Users\\canary-user\\project' }),
      fileUrl: `file://${HOME}/project/d.mjs`,
    }

    const rewritten = Object.fromEntries(
      Object.entries(texts).map(([form, text]) => [form, rewriteHome(text, spellings)]),
    )

    expect(rewritten).toEqual({
      given: '~/project/a.ts',
      real: '~/project/b.ts',
      backslashes: '~\\project\\c.ts',
      jsonEscaped: '{"path":"~\\\\project"}',
      fileUrl: '~/project/d.mjs',
    })
  })

  it('reads as a tilde for a Windows home and in the encoded file URL of a home with a space', () => {
    const windows = homeSpellings('C:\\Users\\canary', 'C:\\Users\\canary')
    const spaced = homeSpellings('/Users/canary user', '/Users/canary user')

    expect(rewriteHome('C:\\Users\\canary\\project', windows)).toBe('~\\project')
    expect(rewriteHome('C:/Users/canary/project', windows)).toBe('~/project')
    expect(rewriteHome('{"cwd":"C:\\\\Users\\\\canary\\\\project"}', windows)).toBe(
      '{"cwd":"~\\\\project"}',
    )
    expect(rewriteHome('file:///C:/Users/canary/project', windows)).toBe('~/project')
    expect(rewriteHome('file:///Users/canary%20user/project', spaced)).toBe('~/project')
  })

  it('leaves a folder of the same name outside the home and a bare user name as they are', () => {
    const spellings = homeSpellings(HOME, REAL_HOME)

    for (const text of ['/srv/build/canary-user/app.js', 'started by canary-user']) {
      expect(rewriteHome(text, spellings)).toBe(text)
    }
  })

  it('has no spelling for a root or empty home, so other text is left alone', () => {
    expect(homeSpellings('/', '')).toEqual([])
    expect(rewriteHome('/srv/app.js', homeSpellings('/', '/'))).toBe('/srv/app.js')
  })

  it('gives a frame and its debug image the same rewritten file name at the transport', async () => {
    const { recorder, transport } = maskingTransport(() => unmasked, {
      homeSpellings: homeSpellings(HOME, REAL_HOME),
    })
    const file = `${HOME}/project/node_modules/agent-qa/dist/cli.js`
    const envelope = [
      { event_id: 'e0'.repeat(16) },
      [
        [
          { type: 'event' },
          {
            exception: {
              values: [
                { type: 'Error', stacktrace: { frames: [{ filename: file, abs_path: file }] } },
              ],
            },
            debug_meta: { images: [{ type: 'sourcemap', code_file: file }] },
          },
        ],
      ],
    ] as unknown as RecordedEnvelope

    await transport.send(envelope)

    const sent = serializedEnvelopes(recorder.envelopes)
    expect(sent).not.toContain('canary-user')
    expect(sent).toContain('"filename":"~/project/node_modules/agent-qa/dist/cli.js"')
    expect(sent).toContain('"code_file":"~/project/node_modules/agent-qa/dist/cli.js"')
  })

  it('is rewritten, and a secret masked, under a key named dsn, type or sdk in printed data', async () => {
    const { recorder, transport } = maskingTransport(() => maskSecret, {
      homeSpellings: homeSpellings(HOME, REAL_HOME),
    })
    const printed = { dsn: `${HOME}/.config/${SECRET}`, type: SECRET, sdk: { name: `${HOME}/x` } }

    await transport.send(
      [
        { event_id: 'e0'.repeat(16) },
        [
          [
            { type: 'event' },
            { breadcrumbs: [{ category: 'console', data: { arguments: [printed] } }] },
          ],
        ],
      ] as unknown as RecordedEnvelope,
    )

    const sent = serializedEnvelopes(recorder.envelopes)
    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain('canary-user')
    expect(sent).toContain(
      `{"dsn":"~/.config/${MARKER}","type":"${MARKER}","sdk":{"name":"~/x"}}`,
    )
  })

  it('is rewritten after the secrets are masked, so a secret that holds the home stays whole', async () => {
    const keyPath = `${HOME}/.ssh/deploy-key`
    const { recorder, transport } = maskingTransport(
      () => (text) => text.replaceAll(keyPath, '[secret:KEY_PATH]'),
      { homeSpellings: homeSpellings(HOME, REAL_HOME) },
    )

    await transport.send(
      [
        { event_id: 'e0'.repeat(16) },
        [[{ type: 'event' }, { message: `cannot read ${keyPath} in ${HOME}/project` }]],
      ] as unknown as RecordedEnvelope,
    )

    expect(serializedEnvelopes(recorder.envelopes)).toContain(
      '"message":"cannot read [secret:KEY_PATH] in ~/project"',
    )
  })
})

describe('the masking transport', () => {
  it('drops an envelope whose mask cannot be built or throws, and the send still resolves', async () => {
    const recorder = recordingReportTransport()
    const envelope = envelopeQuoting('a message') as unknown as RecordedEnvelope
    const wrap = (resolveMask: () => TextMask) =>
      createMaskingTransport(recorder.transport, resolveMask, {
        homeSpellings: homeSpellings(HOME, REAL_HOME),
      })(TRANSPORT_OPTIONS)

    const unbuildable = wrap(() => {
      throw new Error('the secrets file cannot be read')
    })
    const throwing = wrap(() => () => {
      throw new Error('the mask failed')
    })

    await expect(unbuildable.send(envelope)).resolves.toEqual({})
    await expect(throwing.send(envelope)).resolves.toEqual({})
    expect(recorder.envelopes).toEqual([])
    await wrap(() => maskSecret).send(envelope)
    expect(recorder.envelopes).toHaveLength(1)
  })
})

function errorItem(value: string) {
  const frame = { filename: '/srv/app.js', function: 'load', lineno: 3, colno: 7 }
  return [
    { type: 'event' },
    { exception: { values: [{ type: 'Error', value, stacktrace: { frames: [frame] } }] } },
  ]
}

const SPAN_ITEM = [
  { type: 'span', item_count: 1, content_type: 'application/vnd.sentry.items.span.v2+json' },
  { version: 2, items: [{ trace_id: 'a1'.repeat(16), span_id: 'b3'.repeat(8), name: 'run' }] },
]

describe('repeats', () => {
  it('never drops a span container, however often it is sent', () => {
    const dropRepeats = createRepeatFilter()
    const spanOnly = [{ sent_at: '2026-11-10T12:00:00.000Z' }, [SPAN_ITEM]]

    expect(dropRepeats(spanOnly)).toEqual(spanOnly)
    expect(dropRepeats(spanOnly)).toEqual(spanOnly)
  })

  it('removes an error event already sent and keeps the span container beside it', () => {
    const dropRepeats = createRepeatFilter()
    const header = { event_id: 'e0'.repeat(16) }

    expect(dropRepeats([header, [errorItem('error A'), SPAN_ITEM]])).toEqual([
      header,
      [errorItem('error A'), SPAN_ITEM],
    ])
    expect(dropRepeats([header, [errorItem('error A'), SPAN_ITEM]])).toEqual([header, [SPAN_ITEM]])
    expect(dropRepeats([header, [errorItem('error B')]])).toEqual([header, [errorItem('error B')]])
  })

  it('sends nothing for an envelope whose only item is an error already sent', async () => {
    const { recorder, transport } = maskingTransport(() => unmasked, {
      dropRepeats: createRepeatFilter(),
    })
    const envelope = [
      { event_id: 'e0'.repeat(16) },
      [errorItem('error A')],
    ] as unknown as RecordedEnvelope

    await expect(transport.send(envelope)).resolves.toEqual({})
    await expect(transport.send(envelope)).resolves.toEqual({})

    expect(recorder.envelopes).toHaveLength(1)
  })
})
