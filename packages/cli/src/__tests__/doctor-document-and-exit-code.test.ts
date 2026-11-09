import { describe, expect, it } from 'vitest'
import type { CheckResult, DoctorCheck } from '../commands/doctor.js'
import { doctorDocument } from '../commands/doctor-row.js'

function row(name: string, result: CheckResult, fixInstructions = `fix ${name}`) {
  const check: DoctorCheck = { name, fixInstructions, check: async () => result }
  return { check, result }
}

describe('doctor document', () => {
  it('prints format 1 with every row, and fix only on the warn and fail rows', () => {
    const document = doctorDocument([
      row('Node.js', { status: 'pass', message: 'v24.10.0' }),
      row('Docker', { status: 'warn', message: 'daemon not running' }),
      row('Config file', { status: 'fail', message: 'not found' }),
      row('Xcode', { status: 'skip', message: 'no iOS target' }),
    ])

    expect(document).toEqual({
      format: 1,
      ok: false,
      rows: [
        { name: 'Node.js', status: 'pass', message: 'v24.10.0' },
        { name: 'Docker', status: 'warn', message: 'daemon not running', fix: 'fix Docker' },
        { name: 'Config file', status: 'fail', message: 'not found', fix: 'fix Config file' },
        { name: 'Xcode', status: 'skip', message: 'no iOS target' },
      ],
    })
  })

  it("uses the check result's own fix over the check's fix text", () => {
    const document = doctorDocument([
      row('Plugin lab', { status: 'warn', message: 'stale', fix: 'reinstall lab' }),
      row('Embedder', { status: 'fail', message: 'broken', fix: 'restart the daemon' }),
    ])

    expect(document.rows.map((entry) => entry.fix)).toEqual(['reinstall lab', 'restart the daemon'])
  })

  it('gives a pass or skip row no fix even when its result names one', () => {
    const document = doctorDocument([
      row('Node.js', { status: 'pass', message: 'ok', fix: 'nothing to do' }),
      row('Xcode', { status: 'skip', message: 'skipped', fix: 'nothing to do' }),
    ])

    expect(document.rows.some((entry) => 'fix' in entry)).toBe(false)
  })

  it('is ok with only pass, warn and skip rows', () => {
    const document = doctorDocument([
      row('Node.js', { status: 'pass', message: 'ok' }),
      row('Docker', { status: 'warn', message: 'daemon not running' }),
      row('Xcode', { status: 'skip', message: 'no iOS target' }),
    ])

    expect(document.ok).toBe(true)
  })

  it('has no checks key', () => {
    const document = doctorDocument([row('Node.js', { status: 'pass', message: 'ok' })])

    expect(Object.keys(document)).toEqual(['format', 'ok', 'rows'])
  })
})
