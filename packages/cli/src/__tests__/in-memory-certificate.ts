// A self-signed certificate made in memory for one test run, from Node's own crypto, so the
// repository holds no key or certificate. It names the given host names and nothing else.

import { generateKeyPairSync, sign } from 'node:crypto'

export interface InMemoryCertificate {
  readonly key: string
  readonly cert: string
}

const DAY_MS = 86_400_000

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let left = length; left > 0; left = Math.floor(left / 256)) bytes.unshift(left % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const sequence = (...parts: readonly Buffer[]) => der(0x30, ...parts)

function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const bytes = [40 * first + second]
  for (const arc of rest) {
    const groups = [arc % 128]
    for (let left = Math.floor(arc / 128); left > 0; left = Math.floor(left / 128)) {
      groups.unshift(0x80 | left % 128)
    }
    bytes.push(...groups)
  }
  return der(0x06, Buffer.from(bytes))
}

function utcTime(at: Date): Buffer {
  return der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/gu, '').slice(2, 14)}Z`))
}

function pem(body: Buffer): string {
  const lines = body.toString('base64').match(/.{1,64}/gu) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

export function inMemoryCertificate(hostNames: readonly string[]): InMemoryCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const signedWithEcdsaSha256 = sequence(objectId('1.2.840.10045.4.3.2'))
  const name = sequence(
    der(0x31, sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from('an ingest under test')))),
  )
  const now = Date.now()
  const alternativeNames = sequence(
    objectId('2.5.29.17'),
    der(0x04, sequence(...hostNames.map((host) => der(0x82, Buffer.from(host))))),
  )
  const authority = sequence(
    objectId('2.5.29.19'),
    der(0x01, Buffer.from([0xff])),
    der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
  )
  const signed = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    signedWithEcdsaSha256,
    name,
    sequence(utcTime(new Date(now - DAY_MS)), utcTime(new Date(now + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(alternativeNames, authority)),
  )
  const certificate = sequence(
    signed,
    signedWithEcdsaSha256,
    der(0x03, Buffer.from([0]), sign('sha256', signed, privateKey)),
  )
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem(certificate),
  }
}
