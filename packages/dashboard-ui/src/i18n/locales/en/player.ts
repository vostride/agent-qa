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
  'player.videoAbsent': 'Video — {{title}}',
  'player.lastRecordedAction': 'Last recorded action',
  'player.totalTimeUnavailable':
    'Full playback time is unavailable because a recording duration is missing or still loading.',
  'player.noAnnotationTiming':
    'This recording has no saved timing to place action highlights on the video. Open Frames to see any saved action highlights.',
  'player.hideAnnotations': 'Hide annotations',
  'player.showAnnotations': 'Show annotations',
  'player.enableMagnifier': 'Enable magnifier',
  'player.disableMagnifier': 'Disable magnifier',
  'player.enterFullscreen': 'Enter fullscreen',
  'player.exitFullscreen': 'Exit fullscreen',
  'player.fullscreenDialog': 'Evidence media fullscreen',
  'player.videoUntimed':
    'This recording cannot be synchronized with the selected action. Switch to Frames to see its screenshot.',

  'player.timeline.slider': 'Test timeline',
  'player.timeline.signals': 'Step signals',
  'player.timeline.memberSlider': 'Test timeline: {{member}}',
  'player.timeline.noActions': 'No actions recorded for this test',
  'player.timeline.memberNoActions': '{{member}}: No actions recorded',
  'player.timeline.step': 'Step {{step}}',
  'player.timeline.memberStep': '{{member}}, Step {{step}}',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_one': 'Choose from {{count}} nearby actions',
  'player.timeline.chooseNearby_other': 'Choose from {{count}} nearby actions',
  'player.timeline.nearbyActions': 'Nearby actions',
  'player.timeline.marker':
    'Step {{step}}, sub-action {{index}} of {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Step {{step}}, sub-action {{index}} of {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': '#{{index}} of {{total}}',
  'player.timeline.readoutAt': '#{{index}} of {{total}} · {{offset}} / {{extent}}',
} as const
