import action from './action'
import common from './common'
import config from './config'
import configUi from './configUi'
import editor from './editor'
import evidence from './evidence'
import feedback from './feedback'
import insights from './insights'
import knowledge from './knowledge'
import language from './language'
import nav from './nav'
import player from './player'
import runDetail from './runDetail'
import runs from './runs'
import status from './status'
import tests from './tests'
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
  ...knowledge,
  ...feedback,
  ...tests,
  ...editor,
} as const
