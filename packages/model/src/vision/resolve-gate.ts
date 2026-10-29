export interface VisionGate {
  attachImage: boolean
  captureMode: 'full' | 'textOnly'
  promptNote: string
}

const TEXT_ONLY_PROMPT_NOTE = [
  'Visual screenshot is unavailable for this step.',
  'Rely on the accessibility tree for element identification, including roles, names, values, refs, and URLs.',
  'Verify functional state from the available structured context rather than purely visual appearance.',
].join(' ')

/** the configured `vision` when set, otherwise what the capability table says. */
export function visionFromConfig(
  configured: boolean | undefined,
  capabilities: { vision: boolean },
): boolean {
  return configured ?? capabilities.vision
}

export function resolveVisionGate(model: { vision: boolean }): VisionGate {
  if (model.vision) {
    return {
      attachImage: true,
      captureMode: 'full',
      promptNote: '',
    }
  }

  return {
    attachImage: false,
    captureMode: 'textOnly',
    promptNote: TEXT_ONLY_PROMPT_NOTE,
  }
}
