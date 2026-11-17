import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': 'Загрузка данных',
  'evidence.incompleteExplanation':
    'доказательства неполные — данные были записаны, но сохранённого файла больше нет на диске.',
  'evidence.recordedOnStep': 'Записано на шаге {{step}}',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': 'Перейти к шагу {{step}}',

  'evidence.retry.variables': 'Повторить загрузку переменных',
  'evidence.retry.network': 'Повторить загрузку данных сети',
  'evidence.retry.console': 'Повторить загрузку данных консоли',
  'evidence.retry.aria': 'Повторить загрузку дерева ARIA',
  'evidence.retry.a11y': 'Повторить загрузку результатов проверки доступности',
  'evidence.retry.video': 'Повторить загрузку записи',
  'evidence.retry.frame': 'Повторить загрузку снимка экрана',

  'evidence.variables.empty.title': 'На этом шаге нет переменных',
  'evidence.variables.empty.explanation':
    'Во время выполнения этого шага не было задано ни одной переменной.',
  'evidence.variables.notCaptured.title': 'Переменные этого шага не записаны',
  'evidence.variables.notCaptured.explanation': 'Для этого шага не сохранён снимок переменных.',
  'evidence.variables.unsupported.title': 'На этой платформе переменные не записываются',
  'evidence.variables.unsupported.explanation':
    'Платформа этого запуска не поддерживает сохранение снимка переменных.',
  'evidence.variables.unavailable.title': 'Переменные этого запуска недоступны',
  'evidence.variables.unavailable.explanation':
    'Во время этого запуска переменные не записывались, поэтому показать нечего.',
  'evidence.variables.failed.capture.title': 'Не удалось записать переменные',
  'evidence.variables.failed.capture.explanation':
    'Снимок переменных не удалось сохранить во время запуска. Повторять нечего.',
  'evidence.variables.failed.load.title': 'Не удалось загрузить переменные',
  'evidence.variables.failed.load.explanation': 'Переменные были записаны, но не загрузились.',
  'evidence.variables.noSelection.title': 'Шаг не выбран',
  'evidence.variables.noSelection.explanation':
    'Переменные показываются для каждого шага отдельно. Выберите шаг в дереве или на временной шкале, чтобы их увидеть.',

  'evidence.network.empty.title': 'Нет сетевых запросов',
  'evidence.network.empty.explanation':
    'Во время этого шага страница не отправила ни одного запроса.',
  'evidence.network.notCaptured.title': 'Сеть на этом шаге не записана',
  'evidence.network.notCaptured.explanation': 'Для этого шага не сохранено сетевой активности.',
  'evidence.network.unsupported.title': 'На этой платформе сеть не записывается',
  'evidence.network.unsupported.explanation':
    'Платформа этого запуска не поддерживает запись сетевых запросов.',
  'evidence.network.unavailable.title': 'Данные сети этого запуска недоступны',
  'evidence.network.unavailable.explanation':
    'Во время этого запуска сетевая активность не записывалась. Это не значит, что запуск не отправлял запросов.',
  'evidence.network.failed.capture.title': 'Не удалось записать сеть',
  'evidence.network.failed.capture.explanation':
    'Сетевую активность не удалось записать во время запуска. Повторять нечего.',
  'evidence.network.failed.load.title': 'Не удалось загрузить данные сети',
  'evidence.network.failed.load.explanation': 'Данные есть, но не загрузились.',
  'evidence.network.noSelection.title': 'Шаг не выбран',
  'evidence.network.noSelection.explanation':
    'Сетевые запросы показываются для каждого шага отдельно. Выберите шаг в дереве или на временной шкале, чтобы их увидеть.',

  'evidence.console.empty.title': 'Нет вывода консоли',
  'evidence.console.empty.explanation': 'Во время этого шага страница ничего не вывела в консоль.',
  'evidence.console.notCaptured.title': 'Консоль на этом шаге не записана',
  'evidence.console.notCaptured.explanation': 'Для этого шага не сохранён вывод консоли.',
  'evidence.console.unsupported.title': 'На этой платформе консоль не записывается',
  'evidence.console.unsupported.explanation':
    'Платформа этого запуска не поддерживает запись вывода консоли.',
  'evidence.console.unavailable.title': 'Данные консоли этого запуска недоступны',
  'evidence.console.unavailable.explanation':
    'Во время этого запуска вывод консоли не записывался. Это не значит, что страница ничего не вывела.',
  'evidence.console.failed.capture.title': 'Не удалось записать консоль',
  'evidence.console.failed.capture.explanation':
    'Вывод консоли не удалось записать во время запуска. Повторять нечего.',
  'evidence.console.failed.load.title': 'Не удалось загрузить данные консоли',
  'evidence.console.failed.load.explanation': 'Данные есть, но не загрузились.',
  'evidence.console.noSelection.title': 'Шаг не выбран',
  'evidence.console.noSelection.explanation':
    'Вывод консоли показывается для каждого шага отдельно. Выберите шаг в дереве или на временной шкале, чтобы его увидеть.',

  'evidence.aria.empty.title': 'Дерево доступности пусто',
  'evidence.aria.empty.explanation':
    'Когда принималось решение об этом действии, на экране не было доступных элементов.',
  'evidence.aria.notCaptured.title': 'Дерево ARIA для этого действия не записано',
  'evidence.aria.notCaptured.explanation':
    'Для этого вложенного действия не сохранено дерево доступности.',
  'evidence.aria.unsupported.title': 'На этой платформе дерево ARIA не записывается',
  'evidence.aria.unsupported.explanation':
    'Платформа этого запуска не поддерживает запись дерева доступности.',
  'evidence.aria.unavailable.title': 'Дерево ARIA этого запуска недоступно',
  'evidence.aria.unavailable.explanation':
    'Во время этого запуска дерево доступности не записывалось.',
  'evidence.aria.failed.capture.title': 'Не удалось записать дерево ARIA',
  'evidence.aria.failed.capture.explanation':
    'Дерево доступности не удалось записать во время запуска. Повторять нечего.',
  'evidence.aria.failed.load.title': 'Не удалось загрузить дерево ARIA',
  'evidence.aria.failed.load.explanation': 'Дерево было записано, но не загрузилось.',
  'evidence.aria.noSelection.title': 'Вложенное действие не выбрано',
  'evidence.aria.noSelection.explanation':
    'Дерево доступности показывается для каждого вложенного действия отдельно. Выберите вложенное действие в дереве или на временной шкале, чтобы увидеть то, что видела модель.',

  'evidence.a11y.empty.title': 'Нарушений доступности не найдено',
  'evidence.a11y.empty.explanation': 'Проверки на этом шаге выполнены, исправлять нечего.',
  'evidence.a11y.notCaptured.title': 'Проверки доступности на этом шаге не записаны',
  'evidence.a11y.notCaptured.explanation':
    'Для этого шага не сохранены результаты проверки доступности.',
  'evidence.a11y.unsupported.title': 'На этой платформе проверки доступности не поддерживаются',
  'evidence.a11y.unsupported.explanation':
    'Платформа этого запуска не может выполнять проверки доступности.',
  'evidence.a11y.unavailable.title': 'Результаты проверки доступности этого запуска недоступны',
  'evidence.a11y.unavailable.explanation':
    'Во время этого запуска проверки доступности не записывались. Это не значит, что нарушений не было.',
  'evidence.a11y.failed.capture.title': 'Не удалось выполнить проверки доступности',
  'evidence.a11y.failed.capture.explanation':
    'Во время запуска проверки завершились с ошибкой, поэтому результатов нет. Повторять нечего.',
  'evidence.a11y.failed.load.title': 'Не удалось загрузить результаты проверки доступности',
  'evidence.a11y.failed.load.explanation': 'Результаты есть, но не загрузились.',
  'evidence.a11y.noSelection.title': 'Шаг не выбран',
  'evidence.a11y.noSelection.explanation':
    'Результаты проверки доступности показываются для каждого шага отдельно. Выберите шаг в дереве или на временной шкале, чтобы их увидеть.',

  'evidence.video.empty.title': 'В записи нет видео',
  'evidence.video.empty.explanation':
    'Для этого теста сохранена запись, но воспроизводить в ней нечего.',
  'evidence.video.notCaptured.title': 'Для этого теста нет записи',
  'evidence.video.notCaptured.explanation':
    'Для этого теста не сохранено видео. На вкладке «Кадры» по-прежнему видно, что модель видела при каждом решении.',
  'evidence.video.unsupported.title': 'На этой платформе запись не поддерживается',
  'evidence.video.unsupported.explanation':
    'Платформа этого запуска не записывает видео. На вкладке «Кадры» по-прежнему видно, что модель видела при каждом решении.',
  'evidence.video.unavailable.title': 'Запись этого запуска недоступна',
  'evidence.video.unavailable.explanation':
    'Во время этого запуска видео не записывалось. На вкладке «Кадры» по-прежнему видно, что модель видела при каждом решении.',
  'evidence.video.failed.capture.title': 'Не удалось записать видео',
  'evidence.video.failed.capture.explanation':
    'Видео не удалось сохранить по завершении теста. Повторять нечего. На вкладке «Кадры» по-прежнему видно, что модель видела при каждом решении.',
  'evidence.video.failed.load.title': 'Не удалось загрузить запись',
  'evidence.video.failed.load.explanation':
    'Запись есть, но не загрузилась. Повторите попытку или перейдите на вкладку «Кадры».',
  'evidence.video.noSelection.title': 'Шаг не выбран',
  'evidence.video.noSelection.explanation':
    'Запись следует за временной шкалой. Выберите шаг в дереве или на временной шкале, чтобы перейти к нему в записи.',

  'evidence.frame.notCaptured.subAction.title': 'Для этого действия нет снимка экрана',
  'evidence.frame.notCaptured.subAction.explanation':
    'Для этого вложенного действия не сохранён снимок экрана.',
  'evidence.frame.notCaptured.step.title': 'Для этого шага нет снимков экрана',
  'evidence.frame.notCaptured.step.explanation':
    'Ни одно вложенное действие этого шага не сохранило снимок экрана.',
  'evidence.frame.unavailable.title': 'Снимок экрана недоступен',
  'evidence.frame.failed.load.title': 'Не удалось загрузить снимок экрана',
  'evidence.frame.failed.load.explanation': 'Снимок экрана есть, но не загрузился.',

  'evidence.tab.variables': 'Переменные',
  'evidence.tab.network': 'Сеть',
  'evidence.tab.console': 'Консоль',
  'evidence.tab.aria': 'Дерево ARIA',
  'evidence.tab.a11y': 'Доступность',
  'evidence.trigger.variables': 'Переменные, {{number}}',
  'evidence.trigger.aria': 'Дерево ARIA, {{number}}',
  'evidence.trigger.consoleErrors_one': 'Консоль, {{count}} ошибка',
  'evidence.trigger.consoleErrors_few': 'Консоль, {{count}} ошибки',
  'evidence.trigger.consoleErrors_many': 'Консоль, {{count}} ошибок',
  'evidence.trigger.consoleErrors_other': 'Консоль, {{count}} ошибки',
  'evidence.trigger.consoleMessages_one': 'Консоль, {{count}} сообщение',
  'evidence.trigger.consoleMessages_few': 'Консоль, {{count}} сообщения',
  'evidence.trigger.consoleMessages_many': 'Консоль, {{count}} сообщений',
  'evidence.trigger.consoleMessages_other': 'Консоль, {{count}} сообщения',
  'evidence.trigger.networkFailed_one': 'Сеть, {{count}} неудачный запрос',
  'evidence.trigger.networkFailed_few': 'Сеть, {{count}} неудачных запроса',
  'evidence.trigger.networkFailed_many': 'Сеть, {{count}} неудачных запросов',
  'evidence.trigger.networkFailed_other': 'Сеть, {{count}} неудачного запроса',
  'evidence.trigger.networkRequests_one': 'Сеть, {{count}} запрос',
  'evidence.trigger.networkRequests_few': 'Сеть, {{count}} запроса',
  'evidence.trigger.networkRequests_many': 'Сеть, {{count}} запросов',
  'evidence.trigger.networkRequests_other': 'Сеть, {{count}} запроса',
  'evidence.trigger.a11yViolations_one': 'Доступность, {{count}} нарушение',
  'evidence.trigger.a11yViolations_few': 'Доступность, {{count}} нарушения',
  'evidence.trigger.a11yViolations_many': 'Доступность, {{count}} нарушений',
  'evidence.trigger.a11yViolations_other': 'Доступность, {{count}} нарушения',
  'evidence.trigger.absent': '{{tab}} — {{title}}',
  'evidence.signal.console_one':
    '{{count}} ошибка консоли на шаге {{step}} — откройте вкладку «Консоль»',
  'evidence.signal.console_few':
    '{{count}} ошибки консоли на шаге {{step}} — откройте вкладку «Консоль»',
  'evidence.signal.console_many':
    '{{count}} ошибок консоли на шаге {{step}} — откройте вкладку «Консоль»',
  'evidence.signal.console_other':
    '{{count}} ошибки консоли на шаге {{step}} — откройте вкладку «Консоль»',
  'evidence.signal.network_one':
    '{{count}} неудачный запрос на шаге {{step}} — откройте вкладку «Сеть»',
  'evidence.signal.network_few':
    '{{count}} неудачных запроса на шаге {{step}} — откройте вкладку «Сеть»',
  'evidence.signal.network_many':
    '{{count}} неудачных запросов на шаге {{step}} — откройте вкладку «Сеть»',
  'evidence.signal.network_other':
    '{{count}} неудачного запроса на шаге {{step}} — откройте вкладку «Сеть»',
  'evidence.signal.a11y_one':
    '{{count}} нарушение доступности на шаге {{step}} — откройте вкладку «Доступность»',
  'evidence.signal.a11y_few':
    '{{count}} нарушения доступности на шаге {{step}} — откройте вкладку «Доступность»',
  'evidence.signal.a11y_many':
    '{{count}} нарушений доступности на шаге {{step}} — откройте вкладку «Доступность»',
  'evidence.signal.a11y_other':
    '{{count}} нарушения доступности на шаге {{step}} — откройте вкладку «Доступность»',

  'evidence.drawer.test': 'Тест',
  'evidence.drawer.config': 'Конфигурация',
  'evidence.drawer.testAsWritten': 'Тест в исходном виде',
  'evidence.drawer.resolvedDefinition': 'Итоговое определение',
  'evidence.drawer.suiteMembers': 'Тесты набора',
  'evidence.drawer.runTests': 'Тесты в этом запуске',
  'evidence.drawer.runAttributes': 'Атрибуты запуска',
  'evidence.drawer.effectiveConfig': 'Действующая конфигурация',
  'evidence.drawer.globalConfigAsWritten': 'Общая конфигурация в исходном виде',
  'evidence.drawer.model': 'Модель',
  'evidence.drawer.runtime': 'Среда выполнения',
  'evidence.drawer.errors': 'Ошибки',
  'evidence.drawer.notCaptured': 'Не сохранено',
  'evidence.drawer.configNotCaptured': 'Конфигурация не сохранена',
  'evidence.drawer.unsealedCapture':
    'Сохранение настроек этого запуска не завершилось, поэтому показанные здесь тест и конфигурация могут быть неполными.',
  'evidence.drawer.technicalDetails': 'Технические сведения',
  'evidence.drawer.runId': 'ID запуска',
  'evidence.drawer.artifactKind': 'Тип артефакта',
  'evidence.drawer.schemaVersion': 'Версия схемы',
  'evidence.drawer.captureSealedAt': 'Сохранение завершено',
  'evidence.drawer.copyRunId': 'Копировать ID запуска',
  'evidence.drawer.retry': 'Повторить загрузку сведений о запуске',
  'evidence.drawer.ranHere': 'Выполнено на этом компьютере',
  'evidence.drawer.ranHereOn': 'Выполнено на этом компьютере, {{deviceType}}',
  'evidence.drawer.deviceType.simulator': 'симулятор',
  'evidence.drawer.deviceType.realDevice': 'реальное устройство',
  'evidence.drawer.opensInNewTab': '(открывается в новой вкладке)',
  'evidence.drawer.remote': '{{name}} ({{where}})',
  'evidence.drawer.ranOn': 'Выполнено в удалённой среде {{remote}}',
  'evidence.drawer.ranOnVersion': 'Выполнено в удалённой среде {{remote}}, {{version}}',
  'evidence.drawer.lostOn':
    'Выполнялось в удалённой среде {{remote}}, пока не прервалось соединение',
  'evidence.drawer.lostOnVersion':
    'Выполнялось в удалённой среде {{remote}}, {{version}}, пока не прервалось соединение',
  'evidence.drawer.endedOn':
    'Выполнялось в удалённой среде {{remote}}, пока она не завершила сеанс',
  'evidence.drawer.endedOnVersion':
    'Выполнялось в удалённой среде {{remote}}, {{version}}, пока она не завершила сеанс',
  'evidence.drawer.couldNotRun': 'Не удалось выполнить в удалённой среде {{remote}}: {{reason}}',
  'evidence.drawer.sessionRefused': 'сеанс отклонён',
  'evidence.drawer.plugin': 'Плагин {{entry}}',
  'evidence.drawer.pluginSource': 'Плагин {{entry}} ({{source}})',
  'evidence.drawer.sessionPage': 'Страница сеанса',
  'evidence.drawer.kind.test': 'Тест',
  'evidence.drawer.kind.unknown': 'Не записано',
  'evidence.drawer.titleFallback': 'Запуск {{id}}',

  'evidence.scope.step': 'Шаг {{step}} из {{total}} · весь шаг',
  'evidence.scope.subAction': 'Вложенное действие №{{number}} из {{total}} · шаг {{step}}',

  'evidence.artifact.loadingLabel': 'Загрузка данных артефакта',
  'evidence.artifact.loading': 'Загрузка данных артефакта…',
  'evidence.artifact.loadFailed': 'Не удалось загрузить данные артефакта',
  'evidence.artifact.loadFailedHelp':
    'Повторите запрос. Если ошибка повторится, проверьте, может ли сервер панели читать артефакты запусков.',
  'evidence.artifact.missing': 'Для этого запуска нет данных артефакта',
  'evidence.artifact.missingHelp': 'У этого запуска нет сохранённой записи артефакта.',
  'evidence.artifact.none': 'Нет',
  'evidence.artifact.items_one': '{{count}} элемент',
  'evidence.artifact.items_few': '{{count}} элемента',
  'evidence.artifact.items_many': '{{count}} элементов',
  'evidence.artifact.items_other': '{{count}} элемента',
  'evidence.artifact.fields_one': '{{count}} поле',
  'evidence.artifact.fields_few': '{{count}} поля',
  'evidence.artifact.fields_many': '{{count}} полей',
  'evidence.artifact.fields_other': '{{count}} поля',
  'evidence.artifact.sectionNotCaptured': 'Для этого запуска не сохранено: {{section}}.',
  'evidence.artifact.unnamedMember': 'Тест без названия',
  'evidence.artifact.testId': 'ID теста',
  'evidence.artifact.ref': 'Ссылка',
  'evidence.artifact.refId': 'ID ссылки',
  'evidence.artifact.path': 'Путь',
  'evidence.artifact.target': 'Цель',
  'evidence.artifact.childRun': 'Дочерний запуск',
  'evidence.artifact.error': 'Ошибка',
  'evidence.artifact.ranAgainst': 'Цель запуска',
  'evidence.artifact.memberSnapshots': 'Снимки тестов набора',
  'evidence.artifact.rawTestYaml': 'Исходный YAML теста',
  'evidence.artifact.rawMemberYaml': 'Исходный YAML теста набора',
  'evidence.artifact.rawSuiteYaml': 'Исходный YAML набора',
  'evidence.artifact.rawGlobalConfig': 'Исходная общая конфигурация',
  'evidence.artifact.noAttributes': 'Нет атрибутов запуска',
  'evidence.artifact.noAttributesHelp': 'Этот запуск не записал ни одного атрибута.',
  'evidence.artifact.copyJson': 'Копировать JSON',
  'evidence.artifact.copyNamedValue': 'Копировать значение {{key}}',
  'evidence.artifact.copyValue': 'Копировать значение',
} satisfies Translation<typeof en>
