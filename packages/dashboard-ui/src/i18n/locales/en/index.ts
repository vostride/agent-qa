import action from './action'
import common from './common'
import config from './config'
import configUi from './configUi'
import evidence from './evidence'
import insights from './insights'
import language from './language'
import nav from './nav'
import player from './player'
import runDetail from './runDetail'
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
  ...evidence,
  ...player,
  ...runDetail,
} as const
