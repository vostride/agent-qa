import { describe, expect, it } from 'vitest'

const FORBIDDEN_EXPORT_FAMILY = /(delta|commit|promot|drain|enqueue|rollback|purge)/i

describe('read-only reader entry surface', () => {
  it('exposes the complete read face without mutation symbols', async () => {
    const surface = await import('../reader.js')

    for (const exportName of Object.keys(surface)) {
      expect(exportName, `forbidden reader export: ${exportName}`).not.toMatch(
        FORBIDDEN_EXPORT_FAMILY,
      )
    }

    expect(surface.openKnowledgeReader).toBeTypeOf('function')
    expect(surface.createAuthoringReader).toBeTypeOf('function')
    expect(surface.inspectRecords).toBeTypeOf('function')
    expect(surface.diffSince).toBeTypeOf('function')
    expect(surface.gateReceiptsFor).toBeTypeOf('function')
  })
})
