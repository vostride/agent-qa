export default {
  'tour.intro.title': 'Welcome to agent-qa',
  'tour.intro.body':
    'agent-qa lets you write tests in natural language for web and mobile. It runs them through a strict QA harness, learns from past runs, adapts when the UI changes, and shows you exactly what happened.',
  'tour.llmSetup.title': 'Configure your LLM first',
  'tour.runs.title': 'Runs show outcomes',
  'tour.runs.body': 'Runs show outcomes, artifacts, and reasoning from every agent-qa execution.',
  'tour.tests.title': 'Tests hold natural-language checks',
  'tour.tests.body':
    'Tests are natural-language checks that agent-qa can run against your configured web or mobile target.',
  'tour.suites.title': 'Suites group repeatable workflows',
  'tour.suites.body':
    'Suites group related checks into repeatable workflows when one test is not enough.',
  'tour.hooks.title': 'Hooks run around and between steps',
  'tour.hooks.body':
    'Hooks can prepare setup, run inline between steps, and handle cleanup around a test or suite.',
  'tour.config.title': 'Config controls local setup',
  'tour.config.body':
    'Config controls the model, target, runtime, and dashboard setup agent-qa uses locally.',
  'tour.exampleTest.title': 'Run the example passing test',
  'tour.exampleTest.body':
    'This generated test is the safest first run because init creates it to validate your setup.',
  'tour.exampleMissing.title': 'Find the example passing test',
  'tour.exampleMissing.body':
    'agent-qa init normally creates Example passing test. Pick it from Tests when it is available, or create one later.',
  'tour.runAction.title': 'Click Run when ready',
  'tour.runAction.body':
    'Click Run when you are ready. The tour will continue from the run surface or Runs page.',
  'tour.liveRun.title': 'Watch the run live',
  'tour.liveRun.body':
    'Live mode shows the running test: its steps on one side and the browser beside them.',
  'tour.runDetail.title': 'Inspect the run detail',
  'tour.runDetail.body':
    'This is the value moment: inspect what agent-qa observed, planned, executed, and verified.',
  'tour.githubNudge.title': 'If agent-qa helped',
  'tour.githubNudge.body': 'If agent-qa helped, consider starring it on GitHub.',
  'tour.githubNudge.actionLabel': 'View on GitHub',
  'tour.runsFallback.title': 'Open your latest run',
  'tour.runsFallback.body':
    'If a run is not open here yet, use Runs to open the latest execution and inspect the detail view.',
  'tour.ui.progress': 'Tour progress {{current}} of {{total}}',
  'tour.ui.skip': 'Skip',
  'tour.ui.restart': 'Restart',
  'tour.ui.back': 'Back',
  'tour.ui.done': 'Done',
  'tour.ui.startTour': 'Start tour',
} as const
