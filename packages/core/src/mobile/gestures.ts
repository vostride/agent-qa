export const KEY_MAP: Record<string, string> = {
  Enter: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  Space: '\uE00D',
  ArrowUp: '\uE013',
  ArrowDown: '\uE014',
  ArrowLeft: '\uE012',
  ArrowRight: '\uE011',
}

export function computePinch(
  centerX: number, centerY: number,
  scale: number,
  startDistance = 100,
): {
  finger1Start: { x: number; y: number }; finger1End: { x: number; y: number }
  finger2Start: { x: number; y: number }; finger2End: { x: number; y: number }
} {
  const halfStart = startDistance / 2
  const halfEnd = (startDistance * scale) / 2

  return {
    finger1Start: { x: centerX - halfStart, y: centerY },
    finger1End:   { x: centerX - halfEnd, y: centerY },
    finger2Start: { x: centerX + halfStart, y: centerY },
    finger2End:   { x: centerX + halfEnd, y: centerY },
  }
}

export function computeFingerPositions(
  centerX: number, centerY: number,
  fingers: number,
  spacing = 40,
): { x: number; y: number }[] {
  if (fingers === 2) {
    return [
      { x: centerX - spacing / 2, y: centerY },
      { x: centerX + spacing / 2, y: centerY },
    ]
  }
  // 3 fingers: triangle arrangement
  return [
    { x: centerX, y: centerY - spacing / 2 },
    { x: centerX - spacing / 2, y: centerY + spacing / 2 },
    { x: centerX + spacing / 2, y: centerY + spacing / 2 },
  ]
}

export function computeSwipe(
  centerX: number, centerY: number,
  direction: 'up' | 'down' | 'left' | 'right',
  distance: number,
): { startX: number; startY: number; endX: number; endY: number } {
  switch (direction) {
    case 'up':
      return { startX: centerX, startY: centerY + distance / 2, endX: centerX, endY: centerY - distance / 2 }
    case 'down':
      return { startX: centerX, startY: centerY - distance / 2, endX: centerX, endY: centerY + distance / 2 }
    case 'left':
      return { startX: centerX + distance / 2, startY: centerY, endX: centerX - distance / 2, endY: centerY }
    case 'right':
      return { startX: centerX - distance / 2, startY: centerY, endX: centerX + distance / 2, endY: centerY }
  }
}
