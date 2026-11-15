import action from './action'
import language from './language'
import nav from './nav'
import time from './time'

export default { ...nav, ...language, ...time, ...action } as const
