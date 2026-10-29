import { describe, expect, it } from 'vitest'
import {
  classifyRunOwner,
  defaultRunOwnership,
  orphanSummary,
  ownedElsewhere,
  type RunOwner,
  type RunOwnerProbe,
  type RunOwnership,
} from '../run-owner.js'

const HOST = 'host-a'
const SELF: RunOwner = { pid: 100, incarnation: 'start:100', host: HOST }

interface FakeProcess {
  alive: boolean | 'throws'
  incarnation?: string
}

function ownershipOver(processes: Record<number, FakeProcess>): {
  ownership: RunOwnership
  probed: number[]
} {
  const probed: number[] = []
  const probe: RunOwnerProbe = {
    isAlive(pid) {
      probed.push(pid)
      const entry = processes[pid]
      if (entry?.alive === 'throws') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
      return entry?.alive === true
    },
    incarnationOf: (pid) => processes[pid]?.incarnation,
  }
  return { ownership: { self: SELF, probe }, probed }
}

describe('classifying a run owner', () => {
  it("answers self for this process's own pid and start time", () => {
    const { ownership } = ownershipOver({ 100: { alive: true, incarnation: 'start:100' } })
    expect(classifyRunOwner({ ...SELF }, ownership)).toBe('self')
  })

  it('answers gone for a dead pid', () => {
    const { ownership, probed } = ownershipOver({})
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: HOST }, ownership)).toBe('gone')
    expect(probed.join()).toBe('200')
  })

  it('answers gone for a live pid whose start time differs from the stamp', () => {
    const { ownership } = ownershipOver({ 200: { alive: true, incarnation: 'start:reused' } })
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: HOST }, ownership)).toBe('gone')
  })

  it('answers alive for a live pid with the stamped start time', () => {
    const { ownership } = ownershipOver({ 200: { alive: true, incarnation: 'start:200' } })
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: HOST }, ownership)).toBe('alive')
  })

  it('answers unknown when the start time of a live pid cannot be read', () => {
    const { ownership } = ownershipOver({ 200: { alive: true } })
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: HOST }, ownership)).toBe('unknown')
  })

  it('answers unknown for a live pid stamped with no start time', () => {
    const { ownership } = ownershipOver({ 200: { alive: true, incarnation: 'start:200' } })
    expect(classifyRunOwner({ pid: 200, incarnation: null, host: HOST }, ownership)).toBe('unknown')
  })

  it('answers unknown when the liveness probe throws', () => {
    const { ownership, probed } = ownershipOver({ 200: { alive: 'throws' } })
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: HOST }, ownership)).toBe('unknown')
    expect(probed.join()).toBe('200')
  })

  it('answers unknown for an owner on another host even when its pid is dead here', () => {
    const { ownership, probed } = ownershipOver({})
    expect(classifyRunOwner({ pid: 200, incarnation: 'start:200', host: 'host-b' }, ownership)).toBe('unknown')
    expect(classifyRunOwner({ ...SELF, host: 'host-b' }, ownership)).toBe('unknown')
    expect(probed.join()).toBe('')
  })

  it('does not answer self for its own pid with a different start time', () => {
    const { ownership } = ownershipOver({ 100: { alive: true, incarnation: 'start:100' } })
    const verdict = classifyRunOwner({ pid: 100, incarnation: 'start:earlier', host: HOST }, ownership)
    expect(verdict).not.toBe('self')
    expect(verdict).toBe('gone')
  })

  it('the default ownership never answers alive or gone for a live pid', () => {
    const ownership = defaultRunOwnership()
    const host = ownership.self.host
    expect(ownership.self.pid).toBe(process.pid)
    expect(classifyRunOwner({ pid: process.pid, incarnation: null, host }, ownership)).toBe('unknown')
    const live = [process.pid, process.ppid]
    for (const pid of live) {
      for (const incarnation of ['start:any', null]) {
        if (pid === process.pid && incarnation === null) continue
        expect(classifyRunOwner({ pid, incarnation, host }, ownership)).toBe('unknown')
      }
    }
  })

  it('the orphan and owned-elsewhere sentences name the pid', () => {
    expect(orphanSummary(4242)).toBe('The process running this run (pid 4242) ended before it finished.')
    expect(ownedElsewhere(4242)).toBe(
      'This run belongs to another agent-qa process (pid 4242). Stop it there with Ctrl+C.',
    )
  })
})

describe('start-time stamp formats', () => {
  const stampedAs = (incarnation: string): RunOwner => ({ pid: 200, incarnation, host: HOST })

  it('a live owner stamped in another start-time format is unknown, never gone', () => {
    const { ownership, probed } = ownershipOver({
      200: { alive: true, incarnation: 'ps-lstart-utc:Fri Oct 16 03:21:30 2026' },
    })
    const stamps = ['ps-lstart:Fri Oct 16 08:51:30 2026', 'proc-starttime:12']
    expect(stamps.map((stamp) => classifyRunOwner(stampedAs(stamp), ownership))).toEqual([
      'unknown',
      'unknown',
    ])
    expect(probed.join()).toBe('200,200')
  })

  it('a live owner with an equal-format different start time is still gone', () => {
    const { ownership, probed } = ownershipOver({
      200: { alive: true, incarnation: 'ps-lstart-utc:B' },
    })
    expect(classifyRunOwner(stampedAs('ps-lstart-utc:A'), ownership)).toBe('gone')
    expect(probed.join()).toBe('200')
  })

  it("a dead owner is gone whatever its stamp's format", () => {
    const { ownership, probed } = ownershipOver({
      200: { alive: false, incarnation: 'ps-lstart-utc:Fri Oct 16 03:21:30 2026' },
    })
    expect(classifyRunOwner(stampedAs('ps-lstart:old'), ownership)).toBe('gone')
    expect(probed.join()).toBe('200')
  })
})

describe('a start time missing on both sides', () => {
  it('a start time missing on both sides is never self, even for this pid on this host', () => {
    const unread: RunOwner = { pid: 100, incarnation: null, host: HOST }
    const { ownership, probed } = ownershipOver({ 100: { alive: true } })
    expect(classifyRunOwner({ ...unread }, { self: unread, probe: ownership.probe })).toBe('unknown')
    expect(probed.join()).toBe('100')
  })
})

describe('a start-time read that throws', () => {
  it('a start-time read that throws answers unknown', () => {
    const owner: RunOwner = { pid: 200, incarnation: 'start:200', host: HOST }
    const probe: RunOwnerProbe = {
      isAlive: (pid) => pid === owner.pid,
      incarnationOf: (pid) => {
        if (pid === owner.pid) throw new Error('ps failed')
        return undefined
      },
    }
    expect(classifyRunOwner({ ...owner }, { self: SELF, probe })).toBe('unknown')
  })
})
