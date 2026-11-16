import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'Аналитика',
  'insights.description':
    'Надёжность, стоимость и сигналы куратора за весь период, а также отдельный раздел для сравнения тестов, наборов и платформ.',
  'insights.scope.label': 'Учитываемые запуски',
  'insights.scope.scoped': 'Из выборки',
  'insights.scope.all': 'Все запуски',
  'insights.window.label': 'Период',
  'insights.window.oneDay': '1 д',
  'insights.window.sevenDays': '7 д',
  'insights.window.thirtyDays': '30 д',
  'insights.window.all': 'Всё время',
  'insights.refreshing': 'Обновление выбранного интервала',
  'insights.unavailable.title': 'Аналитика недоступна',
  'insights.unavailable.description':
    'Обновите страницу. Если проблема не исчезнет, выберите другой период и убедитесь, что данные аналитики доступны.',
  'insights.empty.title': 'За этот период запусков нет',
  'insights.empty.description':
    'Запустите тесты или повторите их, чтобы наполнить аналитику. Если вы ожидаете более старые данные, выберите «30 д» или «Всё время».',
  'insights.empty.action': 'Открыть запуски',
  'insights.refreshFailed.window':
    'Последнее обновление не удалось. Показан ранее выбранный период.',
  'insights.refreshFailed.range':
    'Последнее обновление не удалось. Показан ранее выбранный интервал.',
  'insights.metric.totalRuns': 'Всего запусков',
  'insights.metric.runsPerDay.window_one': '{{count}} запуск за активный день в этом периоде.',
  'insights.metric.runsPerDay.window_few': '{{count}} запуска за активный день в этом периоде.',
  'insights.metric.runsPerDay.window_many': '{{count}} запусков за активный день в этом периоде.',
  'insights.metric.runsPerDay.window_other': '{{count}} запуска за активный день в этом периоде.',
  'insights.metric.runsPerDay.range_one': '{{count}} запуск за активный день в этом интервале.',
  'insights.metric.runsPerDay.range_few': '{{count}} запуска за активный день в этом интервале.',
  'insights.metric.runsPerDay.range_many': '{{count}} запусков за активный день в этом интервале.',
  'insights.metric.runsPerDay.range_other': '{{count}} запуска за активный день в этом интервале.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} запуск из выборки за активный день в этом периоде.',
  'insights.metric.scopedRunsPerDay.window_few':
    '{{count}} запуска из выборки за активный день в этом периоде.',
  'insights.metric.scopedRunsPerDay.window_many':
    '{{count}} запусков из выборки за активный день в этом периоде.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} запуска из выборки за активный день в этом периоде.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} запуск из выборки за активный день в этом интервале.',
  'insights.metric.scopedRunsPerDay.range_few':
    '{{count}} запуска из выборки за активный день в этом интервале.',
  'insights.metric.scopedRunsPerDay.range_many':
    '{{count}} запусков из выборки за активный день в этом интервале.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} запуска из выборки за активный день в этом интервале.',
  'insights.metric.passRate': 'Доля прохождения',
  'insights.metric.passedOutOf_one':
    '{{count}} успешный запуск из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.passedOutOf_few':
    '{{count}} успешных запуска из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.passedOutOf_many':
    '{{count}} успешных запусков из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.passedOutOf_other':
    '{{count}} успешного запуска из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} успешный запуск из выборки из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.scopedPassedOutOf_few':
    '{{count}} успешных запуска из выборки из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.scopedPassedOutOf_many':
    '{{count}} успешных запусков из выборки из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} успешного запуска из выборки из {{decided}} с результатом «пройден» или «провален».',
  'insights.metric.avgDuration': 'Средняя длительность',
  'insights.metric.avgDurationDescription':
    'Среднее время выполнения завершённых запусков в выбранном интервале.',
  'insights.metric.flakeRate': 'Доля нестабильных',
  'insights.metric.flakeRateDescription_one':
    '{{count}} проваленный запуск; исправленные и нестабильные учитываются отдельно.',
  'insights.metric.flakeRateDescription_few':
    '{{count}} проваленных запуска; исправленные и нестабильные учитываются отдельно.',
  'insights.metric.flakeRateDescription_many':
    '{{count}} проваленных запусков; исправленные и нестабильные учитываются отдельно.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} проваленного запуска; исправленные и нестабильные учитываются отдельно.',
  'insights.passRate.title': 'Доля прохождения',
  'insights.passRate.description': 'Динамика успешных результатов за выбранный период.',
  'insights.duration.title': 'Длительность',
  'insights.duration.description': 'Средняя длительность запуска по дням за выбранный период.',
  'insights.chart.passRate': 'Доля прохождения',
  'insights.chart.duration': 'Длительность',
  'insights.breakdown.test': 'Тест',
  'insights.breakdown.suite': 'Набор',
  'insights.breakdown.platform': 'Платформа',
  'insights.breakdown.testTitle': 'Разбивка по тестам',
  'insights.breakdown.suiteTitle': 'Разбивка по наборам',
  'insights.breakdown.platformTitle': 'Разбивка по платформам',
  'insights.breakdown.description':
    'Сравнивайте надёжность в отдельном нижнем разделе, чтобы общая сводка за период оставалась неизменной.',
  'insights.breakdown.refreshFailed': 'Не удалось обновить сравнение. Показаны прежние результаты.',
  'insights.breakdown.updating': 'Обновление сравнения',
  'insights.breakdown.comparison': 'Сравнение: {{label}}',
  'insights.breakdown.breakDownBy': 'Разбивка',
  'insights.breakdown.unavailable.title': 'Разбивка недоступна',
  'insights.breakdown.unavailable.description':
    'Обновите страницу или выберите другой период, чтобы заново загрузить выбранное сравнение.',
  'insights.breakdown.empty.test': 'За этот период нет данных по тестам',
  'insights.breakdown.empty.suite': 'За этот период нет данных по наборам',
  'insights.breakdown.empty.platform': 'За этот период нет данных по платформам',
  'insights.breakdown.empty.description': 'Выберите другую разбивку или расширьте период.',
  'insights.breakdown.column.runs': 'Запуски',
  'insights.breakdown.column.passed': 'Пройдено',
  'insights.breakdown.column.failed': 'Провалено',
  'insights.breakdown.column.passRate': 'Доля прохождения',
  'insights.breakdown.column.flakeRate': 'Доля нестабильных',
  'insights.breakdown.column.avgDuration': 'Средняя длительность',
  'insights.tokens.title': 'Расход токенов',
  'insights.tokens.description':
    'Активность моделей за весь период, независимо от выбранной разбивки.',
  'insights.tokens.total': 'Всего токенов',
  'insights.tokens.input': 'Входные',
  'insights.tokens.output': 'Выходные',
  'insights.tokens.tooltipTotal': 'Всего',
  'insights.tokens.byModel': 'По моделям',
  'insights.tokens.activeModels_one': 'Входные и выходные токены по {{count}} активной модели',
  'insights.tokens.activeModels_few': 'Входные и выходные токены по {{count}} активным моделям',
  'insights.tokens.activeModels_many': 'Входные и выходные токены по {{count}} активным моделям',
  'insights.tokens.activeModels_other': 'Входные и выходные токены по {{count}} активной модели',
  'insights.tokens.testRuns': 'Тестовые запуски',
  'insights.tokens.liveEditor': 'Интерактивный редактор',
  'insights.tokens.notRecorded': 'Не записано',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} шаг тестового запуска не записал расход токенов и не учтён.',
  'insights.tokens.unmeasuredSteps_few':
    '{{count}} шага тестовых запусков не записали расход токенов и не учтены.',
  'insights.tokens.unmeasuredSteps_many':
    '{{count}} шагов тестовых запусков не записали расход токенов и не учтены.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} шага тестовых запусков не записали расход токенов и не учтены.',
  'insights.tokens.empty.title': 'За этот период токены не расходовались',
  'insights.tokens.empty.description':
    'Показатели токенов появятся, когда запуски или интерактивные сеансы обратятся к модели.',
  'insights.memory.title': 'Куратор памяти',
  'insights.memory.description':
    'Изменения знаний, которые курирование записало для запусков выбранного периода.',
  'insights.memory.reading': 'Чтение изменений курирования за этот период.',
  'insights.memory.noAgentHost':
    'Не удалось прочитать изменения курирования: эта панель запущена без среды агента.',
  'insights.memory.unreadable':
    'Не удалось прочитать изменения курирования за этот период. Обновите страницу, чтобы повторить попытку.',
  'insights.memory.empty.title': 'За этот период куратор памяти не работал',
  'insights.memory.empty.description':
    'Показатели памяти появятся, когда запуски создадут или подтвердят наблюдения.',
  'insights.memory.truncated_one':
    'Учтены последние {{read}} из {{count}} запуска в этом периоде; более ранние запуски не прочитаны.',
  'insights.memory.truncated_few':
    'Учтены последние {{read}} из {{count}} запусков в этом периоде; более ранние запуски не прочитаны.',
  'insights.memory.truncated_many':
    'Учтены последние {{read}} из {{count}} запусков в этом периоде; более ранние запуски не прочитаны.',
  'insights.memory.truncated_other':
    'Учтены последние {{read}} из {{count}} запуска в этом периоде; более ранние запуски не прочитаны.',
  'insights.memory.runsUnreadable_one':
    'Не удалось прочитать курирование для {{affected}} из {{count}} запуска; их изменения не учтены.',
  'insights.memory.runsUnreadable_few':
    'Не удалось прочитать курирование для {{affected}} из {{count}} запусков; их изменения не учтены.',
  'insights.memory.runsUnreadable_many':
    'Не удалось прочитать курирование для {{affected}} из {{count}} запусков; их изменения не учтены.',
  'insights.memory.runsUnreadable_other':
    'Не удалось прочитать курирование для {{affected}} из {{count}} запуска; их изменения не учтены.',
  'insights.memory.curationFailed_one':
    'Курирование не удалось для {{affected}} из {{count}} запуска; их изменения не учтены.',
  'insights.memory.curationFailed_few':
    'Курирование не удалось для {{affected}} из {{count}} запусков; их изменения не учтены.',
  'insights.memory.curationFailed_many':
    'Курирование не удалось для {{affected}} из {{count}} запусков; их изменения не учтены.',
  'insights.memory.curationFailed_other':
    'Курирование не удалось для {{affected}} из {{count}} запуска; их изменения не учтены.',
  'insights.memory.curationUnfinished_one':
    'Курирование ещё не завершено для {{affected}} из {{count}} запуска; их изменения пока не учтены.',
  'insights.memory.curationUnfinished_few':
    'Курирование ещё не завершено для {{affected}} из {{count}} запусков; их изменения пока не учтены.',
  'insights.memory.curationUnfinished_many':
    'Курирование ещё не завершено для {{affected}} из {{count}} запусков; их изменения пока не учтены.',
  'insights.memory.curationUnfinished_other':
    'Курирование ещё не завершено для {{affected}} из {{count}} запуска; их изменения пока не учтены.',
  'insights.memory.inFlight_one': '{{count}} запуск в этом периоде ещё не завершён и не учтён.',
  'insights.memory.inFlight_few': '{{count}} запуска в этом периоде ещё не завершены и не учтены.',
  'insights.memory.inFlight_many':
    '{{count}} запусков в этом периоде ещё не завершено и не учтено.',
  'insights.memory.inFlight_other':
    '{{count}} запуска в этом периоде ещё не завершено и не учтено.',
  'insights.memory.changes': 'Изменения',
  'insights.memory.runsRead': 'Прочитано запусков',
  'insights.memory.runsReadValue': '{{read}} из {{total}}',
  'insights.memory.changeMix': 'Состав изменений',
  'insights.memory.kind.added': 'Добавлено',
  'insights.memory.kind.confirmed': 'Подтверждено',
  'insights.memory.kind.promoted': 'Повышено',
  'insights.memory.kind.superseded': 'Заменено',
  'insights.memory.kind.deprecated': 'Устарело',
  'insights.memory.noChanges_one':
    'Изменений не найдено в {{count}} запуске с завершённым курированием.',
  'insights.memory.noChanges_few':
    'Изменений не найдено в {{count}} запусках с завершённым курированием.',
  'insights.memory.noChanges_many':
    'Изменений не найдено в {{count}} запусках с завершённым курированием.',
  'insights.memory.noChanges_other':
    'Изменений не найдено в {{count}} запуска с завершённым курированием.',
  'insights.memory.noFinishedCuration':
    'Ни у одного запуска в этом периоде нет завершённого курирования, которое можно учесть.',
} satisfies Translation<typeof en>
