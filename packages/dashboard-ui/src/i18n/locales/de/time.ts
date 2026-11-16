import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'time.justNow': 'gerade eben',
  'time.minutesAgoCompact_one': 'vor {{count}} Min.',
  'time.minutesAgoCompact_other': 'vor {{count}} Min.',
  'time.hoursAgoCompact_one': 'vor {{count}} Std.',
  'time.hoursAgoCompact_other': 'vor {{count}} Std.',
  'time.daysAgoCompact_one': 'vor {{count}} Tag',
  'time.daysAgoCompact_other': 'vor {{count}} Tagen',
} satisfies Translation<typeof en>
