import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import { DashboardDatabase } from '../../db/database.js'
import { createDashboardRunIngest, type DashboardRunIngest } from '../dashboard-subscriber.js'
import type { RunIdentityMember } from '../run-row-identity.js'

// 444 D-07 (the artifact half of 433 REVIEW WR-01): a multi-test run's artifact lists each member's
// own source and config, in member order, and presents no one member's as the run's.

let db: DashboardDatabase
let seq = 0

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
  seq = 0
})

afterEach(() => {
  db.close()
})

const RUN_ID = 'r_artifact-members-alpha-bravo-charlie-delta-echo'

function ev(type: RunEventType, payload: Record<string, unknown> = {}): RunEventEnvelope {
  return { seq: ++seq, ts: seq, runId: RUN_ID, type, payload } as RunEventEnvelope
}

const LOGIN: RunIdentityMember = { name: 'Login', testId: 't_login', filePath: 'tests/login.yaml' }
const CHECKOUT: RunIdentityMember = { name: 'Checkout', testId: 't_checkout', filePath: 'tests/checkout.yaml' }

const LOGIN_YAML = 'name: Login\ntest-id: t_login\ntarget: staging\nsteps:\n  - Click Sign in\n'
const CHECKOUT_YAML = 'name: Checkout\ntest-id: t_checkout\ntarget: shop\nsteps:\n  - Click Pay\n'

function testSnapshot(member: RunIdentityMember, rawYaml: string, target: string) {
  return {
    config: {
      rawConfigContent: 'targets: {}\n',
      effectiveConfig: { use: { timeout: { step: target === 'staging' ? 30000 : 45000 } } },
      model: { planner: { provider: 'openai', model: 'gpt-test' } },
      runtime: { platform: 'web', targetName: target },
      timeouts: { step: target === 'staging' ? 30000 : 45000 },
    },
    source: {
      kind: 'test' as const,
      testId: member.testId,
      name: member.name,
      filePath: `/work/${member.filePath}`,
      rawYaml,
      resolvedDefinition: { name: member.name },
      loadStatus: 'loaded' as const,
    },
  }
}

function startTwoTestRun(): DashboardRunIngest {
  const first = testSnapshot(LOGIN, LOGIN_YAML, 'staging')
  const ingest = createDashboardRunIngest({
    db,
    runId: RUN_ID,
    configSnapshot: first.config,
    sourceSnapshot: first.source,
    members: [LOGIN, CHECKOUT],
  })
  ingest.handler(ev('runStarted', { memberTestCount: 2 }))
  ingest.handler(ev('testStarted', { testIndex: 0, testId: LOGIN.testId, name: LOGIN.name, filePath: LOGIN.filePath }))
  ingest.handler(ev('testStarted', { testIndex: 1, testId: CHECKOUT.testId, name: CHECKOUT.name, filePath: CHECKOUT.filePath }))
  return ingest
}

function suiteSnapshot(
  suite: { id: string; name: string; target: string },
  members: readonly RunIdentityMember[],
) {
  return {
    config: {
      rawConfigContent: 'targets: {}\n',
      runtime: { platform: 'web', targetName: suite.target },
      timeouts: { step: 20000 },
    },
    source: {
      kind: 'suite' as const,
      suiteId: suite.id,
      name: suite.name,
      filePath: `/work/suites/${suite.id}.suite.yaml`,
      rawYaml: `name: ${suite.name}\nsuite-id: ${suite.id}\n`,
      resolvedDefinition: { name: suite.name },
      loadStatus: 'loaded' as const,
      members: members.map((member, index) => ({
        index,
        ref: { test: member.filePath, id: member.testId },
        filePath: `/work/${member.filePath}`,
        testId: member.testId,
        name: member.name,
        target: null,
        rawYaml: `name: ${member.name}\ntest-id: ${member.testId}\n`,
        resolvedDefinition: { name: member.name },
        loadStatus: 'loaded' as const,
      })),
    },
  }
}

function storedPayload(): Record<string, any> {
  const artifact = db.getRunArtifact(RUN_ID)
  expect(artifact, 'the run has an artifact').not.toBeNull()
  return artifact!.payload as unknown as Record<string, any>
}

describe('C444-ARTIFACT-MEMBERS', () => {
  it("a two-test run's source lists both members with their own YAML and config", () => {
    const ingest = startTwoTestRun()
    ingest.stageSnapshots(testSnapshot(LOGIN, LOGIN_YAML, 'staging'))
    ingest.stageSnapshots(testSnapshot(CHECKOUT, CHECKOUT_YAML, 'shop'))

    const payload = storedPayload()
    expect(payload.source.kind).toBe('tests')
    const members = payload.source.members as Array<Record<string, any>>
    expect(members.map((member) => member.index)).toEqual([0, 1])
    expect(members[0]).toMatchObject({
      index: 0,
      ref: { test: '/work/tests/login.yaml', id: 't_login' },
      testId: 't_login',
      name: 'Login',
      rawYaml: LOGIN_YAML,
      resolvedDefinition: { name: 'Login' },
      loadStatus: 'loaded',
    })
    expect(members[0].config.runtime.targetName).toBe('staging')
    expect(members[1]).toMatchObject({ index: 1, testId: 't_checkout', name: 'Checkout', rawYaml: CHECKOUT_YAML })
    expect(members[1].config.runtime.targetName).toBe('shop')
    expect(payload.source.rawYaml).toBeUndefined()
    expect(payload.config).toBeUndefined()
  })

  it('members are listed in member order whatever order their snapshots arrive in', () => {
    const ingest = startTwoTestRun()
    ingest.stageSnapshots(testSnapshot(CHECKOUT, CHECKOUT_YAML, 'shop'))
    ingest.stageSnapshots(testSnapshot(LOGIN, LOGIN_YAML, 'staging'))

    const members = storedPayload().source.members as Array<Record<string, any>>
    expect(members.map((member) => member.name)).toEqual(['Login', 'Checkout'])
    expect(members.map((member) => member.index)).toEqual([0, 1])
    expect(members.map((member) => member.rawYaml)).toEqual([LOGIN_YAML, CHECKOUT_YAML])
    expect(members.map((member) => member.config.runtime.targetName)).toEqual(['staging', 'shop'])
  })

  it("a run spanning two suites lists every member with its own suite's config and presents neither suite as the run's", () => {
    const LOGIN_SUITE = { id: 's_login', name: 'Login suite', target: 'login-target' }
    const CHECKOUT_SUITE = { id: 's_checkout', name: 'Checkout suite', target: 'checkout-target' }
    const signIn = { name: 'Sign in', testId: 't_sign_in', filePath: 'tests/sign-in.yaml', suiteId: LOGIN_SUITE.id, suiteName: LOGIN_SUITE.name }
    const signOut = { name: 'Sign out', testId: 't_sign_out', filePath: 'tests/sign-out.yaml', suiteId: LOGIN_SUITE.id, suiteName: LOGIN_SUITE.name }
    const pay = { name: 'Pay', testId: 't_pay', filePath: 'tests/pay.yaml', suiteId: CHECKOUT_SUITE.id, suiteName: CHECKOUT_SUITE.name }
    const loginSnapshot = suiteSnapshot(LOGIN_SUITE, [signIn, signOut])
    const checkoutSnapshot = suiteSnapshot(CHECKOUT_SUITE, [pay])
    const ingest = createDashboardRunIngest({
      db,
      runId: RUN_ID,
      configSnapshot: loginSnapshot.config,
      sourceSnapshot: loginSnapshot.source,
      members: [signIn, signOut, pay],
    })
    ingest.handler(ev('runStarted', { memberTestCount: 3 }))
    ingest.stageSnapshots(checkoutSnapshot)
    ingest.stageSnapshots(loginSnapshot)

    const payload = storedPayload()
    expect(payload.source.kind).toBe('tests')
    const members = payload.source.members as Array<Record<string, any>>
    expect(members.length).toBe(3)
    expect(members.map((member) => member.index)).toEqual([0, 1, 2])
    expect(members.map((member) => member.name)).toEqual(['Sign in', 'Sign out', 'Pay'])
    expect(members.map((member) => member.testId)).toEqual(['t_sign_in', 't_sign_out', 't_pay'])
    expect(members.map((member) => member.rawYaml)).toEqual([
      'name: Sign in\ntest-id: t_sign_in\n',
      'name: Sign out\ntest-id: t_sign_out\n',
      'name: Pay\ntest-id: t_pay\n',
    ])
    expect(members.map((member) => member.config.runtime.targetName)).toEqual([
      'login-target',
      'login-target',
      'checkout-target',
    ])
    expect(payload.source.suiteId).toBeUndefined()
    expect(payload.source.name).toBeUndefined()
    expect(payload.source.rawYaml).toBeUndefined()
    expect(payload.config).toBeUndefined()
  })

  it('a single-test run keeps its test source and config', () => {
    const ingest = createDashboardRunIngest({ db, runId: RUN_ID, members: [LOGIN] })
    ingest.handler(ev('runStarted', { memberTestCount: 1 }))
    ingest.stageSnapshots(testSnapshot(LOGIN, LOGIN_YAML, 'staging'))

    const payload = storedPayload()
    expect(payload.source.kind).toBe('test')
    expect(payload.source.rawYaml).toBe(LOGIN_YAML)
    expect(payload.source.testId).toBe('t_login')
    expect(payload.source.members).toBeUndefined()
    expect(payload.config.runtime.targetName).toBe('staging')
  })

  it('a one-suite run keeps its suite source', () => {
    const LOGIN_SUITE = { id: 's_login', name: 'Login suite', target: 'login-target' }
    const signIn = { name: 'Sign in', testId: 't_sign_in', filePath: 'tests/sign-in.yaml', suiteId: LOGIN_SUITE.id, suiteName: LOGIN_SUITE.name }
    const signOut = { name: 'Sign out', testId: 't_sign_out', filePath: 'tests/sign-out.yaml', suiteId: LOGIN_SUITE.id, suiteName: LOGIN_SUITE.name }
    const snapshot = suiteSnapshot(LOGIN_SUITE, [signIn, signOut])
    const ingest = createDashboardRunIngest({
      db,
      runId: RUN_ID,
      configSnapshot: snapshot.config,
      sourceSnapshot: snapshot.source,
      members: [signIn, signOut],
    })
    ingest.handler(ev('runStarted', { memberTestCount: 2 }))
    ingest.stageSnapshots(snapshot)

    const payload = storedPayload()
    expect(payload.source.kind).toBe('suite')
    expect(payload.source.suiteId).toBe('s_login')
    expect(payload.source.rawYaml).toBe('name: Login suite\nsuite-id: s_login\n')
    expect((payload.source.members as Array<Record<string, any>>).map((member) => member.name)).toEqual(['Sign in', 'Sign out'])
    expect(payload.config.runtime.targetName).toBe('login-target')
  })
})
