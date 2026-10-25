import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asRecordId } from '@vostride/agent-qa-schema'
import * as host from '../replay-gate-host.js'
import * as session from '../../eval-session-composition.js'

afterEach(() => vi.restoreAllMocks())
const { completeGate1Receipt } = await import(new URL(
  '../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url).href)

// 2026-09-07, 418 D-13: tail and maintenance bind lazy capability so receipt
// posture reaches the law. The 417 no-automatic-replay/no-spend boundary still
// requires an unbound replay job slot and zero session IO during construction.
describe('417/418 production replay gate binding', () => {
  it.each([
    'composition/local-agent-host.ts',
    'daemon/host.ts',
    'curation/post-run-tail.ts',
    'commands/knowledge-maintain.ts',
  ])('binds exactly once in %s', (file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(source.match(/createReplayGatePortForHost\(/g)).toHaveLength(1)
  })

  /**
   * 2026-09-12, 422-09: THIS WALL MOVED, AND IT MOVED BECAUSE ITS SUBJECT DID.
   *
   * 417 required the post-run replay job slot to stay UNBOUND, and pinned it the bluntest way
   * there is — the member spelling `runReplayGate:` appearing in NO shipped file. That was the
   * right wall while the capability was a declaration: 422-07 and 422-08 both shipped it typed
   * and bound nowhere, and this cell is what would have caught a host binding it by accident.
   *
   * 422 D-14 binds it on purpose. So the wall becomes an EXACT ALLOW-LIST rather than a
   * prohibition — which is strictly stronger than deleting it and stronger than the old form for
   * everything except the two named files: a third site, anywhere in either tree, still fails.
   * The two are the only shapes the architecture permits:
   *
   *   proposal-stage-capabilities.ts  BINDS it, over a bridge its host built and handed in
   *   compose-local-agent.ts          FORWARDS it, neutrally — agent-local constructs no gate
   *
   * Neither production HOST is on the list, and that is the point: both compose through the one
   * shared builder rather than spelling the member themselves, which is what makes the terminal's
   * and the daemon's capability sets equal by construction (422-09's parity cells).
   */
  it('binds the post-run replay job slot at exactly the two sanctioned sites', () => {
    function files(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.name === '__tests__'
          ? []
          : entry.isDirectory()
            ? files(join(dir, entry.name))
            : entry.name.endsWith('.ts')
              ? [join(dir, entry.name)]
              : [],
      )
    }
    const roots = ['../../', '../../../../agent-local/src/'].map((path) =>
      fileURLToPath(new URL(path, import.meta.url)),
    )
    const sites = roots
      .flatMap(files)
      .filter((file) => /runReplayGate:/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(file.indexOf(`${join('packages', '')}`)))
      .sort()
    expect(sites).toEqual([
      join('packages', 'agent-local', 'src', 'composition', 'compose-local-agent.ts'),
      join('packages', 'cli', 'src', 'composition', 'proposal-stage-capabilities.ts'),
    ])
  })

  it('constructs without session IO, then lazily resolves a key-only session and preserves the host runtime root', async () => {
    const resolved = {} as session.EvalSession
    const resolveSession = vi.spyOn(session, 'resolveEvalSession').mockResolvedValue(resolved)
    const run = vi.spyOn(session, 'runReplayGateVerb').mockResolvedValue({
      kind: 'refused',
      refusal: { path: '/fixture', reason: 'no-floor' },
      notices: [],
      exit: 2,
      maxScreens: 64,
      maxScreensSource: 'default',
      k: 3,
      kSource: 'default',
    })
    expect(host).toHaveProperty('createReplayGatePortForHost')
    const factory = Reflect.get(host, 'createReplayGatePortForHost')
    const port = factory({ configPath: '/fixture/config.yaml', agentQaRoot: '/runtime/custom' })
    expect(resolveSession).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    await expect(port.runReplayGate(asRecordId('candidate'))).rejects.toThrow('no-floor')
    expect(resolveSession).toHaveBeenCalledWith({
      configPath: '/fixture/config.yaml',
      keyOnly: true,
    })
    expect(run).toHaveBeenCalledWith(resolved, 'candidate', {
      agentQaRoot: '/runtime/custom',
      onProgress: expect.any(Function),
      resolveTrustPriors: expect.any(Function),
    })
    const receipt = completeGate1Receipt('candidate')
    // 422 D-14: `recorded` is a REQUIRED member of the receipt arm and the production verb always
    // supplies it; these fixtures used to omit it behind the cast. The port now reads it, because
    // a receipt the writer refused is replay work spent and evidence nothing stored.
    run.mockResolvedValueOnce({ kind: 'receipt', receipt, recorded: 'appended' } as session.ReplayGateVerbResult)
    expect(await port.runReplayGate(asRecordId('candidate'))).toEqual(receipt)
    run.mockResolvedValueOnce({ kind: 'receipt', receipt, recorded: 'lease-held' } as session.ReplayGateVerbResult)
    await expect(port.runReplayGate(asRecordId('candidate'))).rejects.toThrow(
      'the writer did not acknowledge',
    )
    run.mockResolvedValueOnce({ kind: 'receipt', receipt: { ...receipt, judgeId: 'substituted' }, recorded: 'appended' } as session.ReplayGateVerbResult)
    await expect(port.runReplayGate(asRecordId('candidate'))).rejects.toThrow('invalid receipt digest')
  })
})
