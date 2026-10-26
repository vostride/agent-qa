import { describe, expect, it } from 'vitest'

import { modelFieldSegments } from '../model-workspace'

describe('modelFieldSegments', () => {
  it('modelFieldSegments names one leaf of one saved model by its name', () => {
    expect(modelFieldSegments('gpt', 'model')).toEqual(['registry', 'llms', { name: 'gpt' }, 'model'])
  })
})
