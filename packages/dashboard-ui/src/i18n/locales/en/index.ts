import action from './action'
import common from './common'
import config from './config'
import configUi from './configUi'
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
  ...action,
  ...tour,
  ...config,
  ...configUi,
  ...status,
  ...runs,
} as const
