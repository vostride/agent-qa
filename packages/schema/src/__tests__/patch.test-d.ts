import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import type { Patch } from '../patch/patch'
import { patchSchema } from '../patch/patch'

test('the patch schema infers the Patch type', () => {
  expectTypeOf<z.infer<typeof patchSchema>>().toEqualTypeOf<Patch>()

  const ok: Patch = {
    id: 'patch_1' as Patch['id'],
    status: 'proposed',
    summary: 'Update checkout target config',
    changes: [
      {
        path: 'agent-qa.config.yaml',
        changeKind: 'modify',
        hunks: [
          {
            header: '@@ -1,1 +1,1 @@',
            lines: ['-baseUrl: https://old.example', '+baseUrl: https://new.example'],
          },
        ],
      },
    ],
    payloadHash: 'sha256:abc123',
  }

  void ok
})
