import type en from '../en'
import type { Translation } from '../../translation'
import common from './common'
import hooks from './hooks'
import insights from './insights'
import language from './language'
import nav from './nav'
import runs from './runs'
import status from './status'
import time from './time'
import tour from './tour'

export default {
  ...common,
  ...nav,
  ...language,
  ...time,
  ...tour,
  ...status,
  ...runs,
  ...insights,
  ...hooks,
} satisfies Translation<typeof en>
