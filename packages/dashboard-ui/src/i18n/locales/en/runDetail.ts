export default {
  'runDetail.usage.tokensNotMeasured': 'tokens not measured',
  'runDetail.usage.modelsHeading': 'Models',
  'runDetail.usage.triggerLabel': 'Token usage — details',
  'runDetail.usage.tokenPair': '{{prompt}} in · {{completion}} out',
  'runDetail.usage.totals': '{{total}} total · {{prompt}} in · {{completion}} out',
  'runDetail.usage.coverage':
    'measured {{measured}} of {{steps}} steps — totals are an undercount',
  'runDetail.usage.cachedInput': 'cached input {{cached}} (provider-reported)',
  'runDetail.usage.cachedInputPartial':
    'cached input {{cached}} of {{measuredTokens}} (provider-reported) over {{cachedSteps}} of {{measuredSteps}} measured steps',
  'runDetail.usage.model': 'Model {{identity}}',
  'runDetail.usage.respondedAs': 'responded as {{model}}',
  'runDetail.usage.modelSteps_one': '{{identity}} × {{count}} steps',
  'runDetail.usage.modelSteps_other': '{{identity}} × {{count}} steps',
  'runDetail.usage.respondedSteps_one': 'responded as {{model}} × {{count}} steps',
  'runDetail.usage.respondedSteps_other': 'responded as {{model}} × {{count}} steps',
  'runDetail.member.didNotRun': 'did not run',
  'runDetail.member.fallbackName': 'Test {{number}}',
  'runDetail.member.reran': 're-ran after failure ×{{times}}',
  'runDetail.evidence.incomplete': 'evidence incomplete',
  'runDetail.screenState.unchanged': 'state unchanged',
  'runDetail.screenState.changed': 'state changed',
  'runDetail.unavailable': 'Could not load this run’s steps.',
  'runDetail.notice.message':
    'This run was recorded before evidence was saved. Variables, network, console, ARIA, accessibility and video were not recorded.',
  'runDetail.notice.dismiss': 'Dismiss notice',
} as const
