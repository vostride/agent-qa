import type { ConfigPathSegment } from '@vostride/agent-qa-schema'

export function modelFieldSegments(name: string, key: string): ConfigPathSegment[] {
  return ['registry', 'llms', { name }, key]
}
