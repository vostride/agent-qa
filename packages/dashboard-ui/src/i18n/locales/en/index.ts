import action from './action'
import common from './common'
import language from './language'
import nav from './nav'
import time from './time'

export default { ...common, ...nav, ...language, ...time, ...action } as const
