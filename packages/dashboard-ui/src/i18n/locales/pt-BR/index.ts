import type en from '../en'
import type { Translation } from '../../translation'
import action from './action'
import common from './common'
import config from './config'
import configUi from './configUi'
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
  ...action,
  ...tour,
  ...config,
  ...configUi,
  ...status,
  ...runs,
  ...insights,
  ...hooks,
} satisfies Translation<typeof en>
