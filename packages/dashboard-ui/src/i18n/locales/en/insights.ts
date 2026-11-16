export default {
  'insights.title': 'Insights',
  'insights.description':
    'Window-wide reliability, cost, and curator signals with a separate comparison section for tests, suites, and platforms.',
  'insights.scope.label': 'Run scope',
  'insights.scope.scoped': 'Scoped',
  'insights.scope.all': 'All runs',
  'insights.window.label': 'Time window',
  'insights.window.oneDay': '1D',
  'insights.window.sevenDays': '7D',
  'insights.window.thirtyDays': '30D',
  'insights.window.all': 'All Time',
  'insights.refreshing': 'Refreshing selected range',
  'insights.unavailable.title': 'Insights unavailable',
  'insights.unavailable.description':
    'Refresh the page. If the problem continues, change the time window and verify analytics data is available.',
  'insights.empty.title': 'No runs in this window',
  'insights.empty.description':
    'Run or rerun tests to populate insights. If you expect older data, switch to 30D or All Time.',
  'insights.empty.action': 'Open Runs',
  'insights.refreshFailed.window':
    'The latest refresh failed. Showing the previous selected window instead.',
  'insights.refreshFailed.range':
    'The latest refresh failed. Showing the previous selected range instead.',
  'insights.metric.totalRuns': 'Total Runs',
  'insights.metric.runsPerDay.window_one': '{{count}} runs per active day in this window.',
  'insights.metric.runsPerDay.window_other': '{{count}} runs per active day in this window.',
  'insights.metric.runsPerDay.range_one': '{{count}} runs per active day in this range.',
  'insights.metric.runsPerDay.range_other': '{{count}} runs per active day in this range.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} scoped runs per active day in this window.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} scoped runs per active day in this window.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} scoped runs per active day in this range.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} scoped runs per active day in this range.',
  'insights.metric.passRate': 'Pass Rate',
  'insights.metric.passedOutOf_one':
    '{{count}} successful runs out of {{decided}} that passed or failed.',
  'insights.metric.passedOutOf_other':
    '{{count}} successful runs out of {{decided}} that passed or failed.',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} successful scoped runs out of {{decided}} that passed or failed.',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} successful scoped runs out of {{decided}} that passed or failed.',
  'insights.metric.avgDuration': 'Avg Duration',
  'insights.metric.avgDurationDescription':
    'Average runtime for completed runs in the selected range.',
  'insights.metric.flakeRate': 'Flake Rate',
  'insights.metric.flakeRateDescription_one':
    '{{count}} failed runs with healed/flaky behavior tracked separately.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} failed runs with healed/flaky behavior tracked separately.',
  'insights.passRate.title': 'Pass Rate',
  'insights.passRate.description': 'Trend for successful outcomes across the selected window.',
  'insights.duration.title': 'Duration',
  'insights.duration.description': 'Average run duration by day for the selected window.',
  'insights.chart.passRate': 'Pass Rate',
  'insights.chart.duration': 'Duration',
  'insights.breakdown.test': 'Test',
  'insights.breakdown.suite': 'Suite',
  'insights.breakdown.platform': 'Platform',
  'insights.breakdown.testTitle': 'Test Breakdown',
  'insights.breakdown.suiteTitle': 'Suite Breakdown',
  'insights.breakdown.platformTitle': 'Platform Breakdown',
  'insights.breakdown.description':
    'Compare reliability in a focused lower section so the overall window summary stays stable.',
  'insights.breakdown.refreshFailed': 'Unable to refresh comparison. Showing previous results.',
  'insights.breakdown.updating': 'Updating comparison',
  'insights.breakdown.comparison': '{{label}} comparison',
  'insights.breakdown.breakDownBy': 'Break down by',
  'insights.breakdown.unavailable.title': 'Breakdown unavailable',
  'insights.breakdown.unavailable.description':
    'Refresh the page or pick another window to reload the selected comparison.',
  'insights.breakdown.empty.test': 'No test data in this window',
  'insights.breakdown.empty.suite': 'No suite data in this window',
  'insights.breakdown.empty.platform': 'No platform data in this window',
  'insights.breakdown.empty.description': 'Try another breakdown or widen the time window.',
  'insights.breakdown.column.runs': 'Runs',
  'insights.breakdown.column.passed': 'Passed',
  'insights.breakdown.column.failed': 'Failed',
  'insights.breakdown.column.passRate': 'Pass Rate',
  'insights.breakdown.column.flakeRate': 'Flake Rate',
  'insights.breakdown.column.avgDuration': 'Avg Duration',
  'insights.tokens.title': 'Token Usage',
  'insights.tokens.description':
    'Window-wide model activity, independent of the breakdown selector.',
  'insights.tokens.total': 'Total Tokens',
  'insights.tokens.input': 'Input',
  'insights.tokens.output': 'Output',
  'insights.tokens.tooltipTotal': 'Total',
  'insights.tokens.byModel': 'By model',
  'insights.tokens.activeModels_one': 'Input vs output across {{count}} active model',
  'insights.tokens.activeModels_other': 'Input vs output across {{count}} active models',
  'insights.tokens.testRuns': 'Test Runs',
  'insights.tokens.liveEditor': 'Live Editor',
  'insights.tokens.notRecorded': 'Not recorded',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} test-run step recorded no token usage and is not counted.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} test-run steps recorded no token usage and are not counted.',
  'insights.tokens.empty.title': 'No token usage in this window',
  'insights.tokens.empty.description':
    'Token metrics appear after runs or live sessions use model calls.',
  'insights.memory.title': 'Memory Curator',
  'insights.memory.description':
    'Knowledge changes curation recorded for the runs in the selected window.',
  'insights.memory.reading': 'Reading curation changes for this window.',
  'insights.memory.noAgentHost':
    'Curation changes could not be read: this dashboard was started without an agent host.',
  'insights.memory.unreadable':
    'Curation changes could not be read for this window. Refresh the page to try again.',
  'insights.memory.empty.title': 'No memory-curator activity in this window',
  'insights.memory.empty.description':
    'Memory metrics appear after runs create or confirm observations.',
  'insights.memory.truncated_one':
    'Counted the latest {{read}} of {{count}} runs in this window; older runs were not read.',
  'insights.memory.truncated_other':
    'Counted the latest {{read}} of {{count}} runs in this window; older runs were not read.',
  'insights.memory.runsUnreadable_one':
    'Could not read curation for {{affected}} of {{count}} run; their changes are not counted.',
  'insights.memory.runsUnreadable_other':
    'Could not read curation for {{affected}} of {{count}} runs; their changes are not counted.',
  'insights.memory.curationFailed_one':
    'Curation failed for {{affected}} of {{count}} run; their changes are not counted.',
  'insights.memory.curationFailed_other':
    'Curation failed for {{affected}} of {{count}} runs; their changes are not counted.',
  'insights.memory.curationUnfinished_one':
    'Curation has not finished for {{affected}} of {{count}} run; their changes are not counted yet.',
  'insights.memory.curationUnfinished_other':
    'Curation has not finished for {{affected}} of {{count}} runs; their changes are not counted yet.',
  'insights.memory.inFlight_one':
    '{{count}} run in this window has not finished yet and is not counted.',
  'insights.memory.inFlight_other':
    '{{count}} runs in this window have not finished yet and are not counted.',
  'insights.memory.changes': 'Changes',
  'insights.memory.runsRead': 'Runs Read',
  'insights.memory.runsReadValue': '{{read}} of {{total}}',
  'insights.memory.changeMix': 'Change Mix',
  'insights.memory.kind.added': 'Added',
  'insights.memory.kind.confirmed': 'Confirmed',
  'insights.memory.kind.promoted': 'Promoted',
  'insights.memory.kind.superseded': 'Superseded',
  'insights.memory.kind.deprecated': 'Deprecated',
  'insights.memory.noChanges_one': 'No changes found in the {{count}} run whose curation finished.',
  'insights.memory.noChanges_other':
    'No changes found in the {{count}} runs whose curation finished.',
  'insights.memory.noFinishedCuration': 'No run in this window has a finished curation to count.',
} as const
