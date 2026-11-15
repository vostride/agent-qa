import action from './action'
import common from './common'
import config from './config'
import language from './language'
import nav from './nav'
import time from './time'
import tour from './tour'

export default { ...common, ...nav, ...language, ...time, ...action, ...tour, ...config } as const
