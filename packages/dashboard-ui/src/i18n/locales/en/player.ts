export default {
  'player.frames': 'Frames',
  'player.video': 'Video',
  'player.source': 'Playback source',
  'player.framesTooltip': 'The exact screenshots the model saw when it decided',
  'player.play': 'Play recording',
  'player.pause': 'Pause recording',
  'player.speed': 'Playback speed',
  'player.substitution':
    'Showing #{{shown}} of {{total}} — the latest sub-action with a screenshot',
  'player.lightboxTitle': 'Cited screenshot',
  'player.lightboxClose': 'Close screenshot',
  'player.lightboxNote':
    'This screenshot is cited by the analysis but does not belong to a recorded sub-action, so it has no place on the timeline.',
  'player.videoUntimed':
    'This recording cannot be synchronized with the selected action. Switch to Frames to see its screenshot.',

  'player.timeline.slider': 'Test timeline',
  'player.timeline.signals': 'Step signals',
  'player.timeline.marker':
    'Step {{step}}, sub-action {{ordinal}} of {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Step {{step}}, sub-action {{ordinal}} of {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': '#{{ordinal}} of {{total}}',
  'player.timeline.readoutAt': '#{{ordinal}} of {{total}} · {{offset}} / {{extent}}',
} as const
