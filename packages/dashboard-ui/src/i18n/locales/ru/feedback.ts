import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'этот тест',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'шаг {{number}}',
  'feedback.place.stepOfTest': 'шаг {{number}} теста {{test}}',
  'feedback.composer.pinnedTarget': 'Вы просматриваете: {{viewed}}. Предмет отзыва: {{about}}.',
  'feedback.composer.switchTarget': 'Переключиться: {{place}}',
  'feedback.composer.unsentDraft': 'Неотправленный черновик: {{place}}',
  'feedback.composer.headingStep': 'Отзыв о шаге {{number}} из {{total}} · {{name}}',
  'feedback.composer.headingTest': 'Отзыв о тесте {{name}}',
  'feedback.composer.headingSuiteTest': 'Отзыв о тесте {{name}} {{handle}}',
  'feedback.choice.falseFail': 'Тест должен был пройти',
  'feedback.choice.falsePass': 'Тест должен был провалиться',
  'feedback.choice.confirmedBug': 'Это настоящая ошибка в продукте',
  'feedback.choiceMeaning.failed.falseFail':
    'Приложение работало правильно; тест провалился ошибочно.',
  'feedback.choiceMeaning.failed.confirmedBug': 'Сбой настоящий — приложение здесь неисправно.',
  'feedback.choiceMeaning.failed.falsePass':
    'Тест пропустил проблему, которую должен был обнаружить.',
  'feedback.choiceMeaning.passed.falseFail': 'Тест пройден верно; это подтверждает тест.',
  'feedback.choiceMeaning.passed.confirmedBug':
    'В приложении здесь есть настоящая ошибка, хотя тест прошёл.',
  'feedback.choiceMeaning.passed.falsePass':
    'Приложение здесь было неисправно, но тест всё равно прошёл.',
  'feedback.scope.recorded.passed': 'записано: пройден',
  'feedback.scope.recorded.healed': 'записано: исправлен — считается пройденным',
  'feedback.scope.recorded.failed': 'записано: провален',
  'feedback.scope.recorded.timeout': 'записано: тайм-аут — считается проваленным',
  'feedback.scope.recorded.cancelled': 'записано: отменён — считается проваленным',
  'feedback.scope.recorded.skipped': 'записано: пропущен — считается проваленным',
  'feedback.scope.noStepVerdict':
    'вердикт шага не записан — используется результат теста ({{recorded}})',
  'feedback.scope.wholeTest': 'Весь тест · {{recorded}}',
  'feedback.scope.oneStep': 'Один шаг · {{recorded}}',
  'feedback.scope.oneStepInTest': 'Один шаг теста {{name}} {{handle}} · {{recorded}}',
  'feedback.entry.step': 'Оставить отзыв о шаге {{number}}',
  'feedback.entry.member': 'Оставить отзыв о тесте {{name}} {{handle}}',
  'feedback.entry.stepMarked': 'Оставить отзыв о шаге {{number}} — уже отмечено: {{choice}}',
  'feedback.entry.testMarked': 'Оставить отзыв об этом тесте — уже отмечено: {{choice}}',
  'feedback.entry.memberMarked':
    'Оставить отзыв о тесте {{name}} {{handle}} — уже отмечено: {{choice}}',
  'feedback.entry.stepMarkedTooltip':
    'Шаг {{number}} уже отмечен — просмотрите или измените отметку',
  'feedback.entry.markGlyph': 'Отмечено: {{choice}}',
  'feedback.disposition.applied.fact': 'Записано — добавлен факт знаний',
  'feedback.disposition.applied.caution': 'Записано — добавлено предостережение',
  'feedback.disposition.applied.procedureHint': 'Записано — добавлена подсказка процедуры',
  'feedback.disposition.applied.testEdit': 'Записано — файл теста изменён',
  'feedback.disposition.drafted': 'Записано — подготовлено исправление (более ранняя отметка)',
  'feedback.disposition.noDraftableFix': 'Записано — исправление подготовить не удалось',
  'feedback.disposition.confirmedBug':
    'Записано — оставлено как настоящая ошибка в продукте, ничего не изменено',
  'feedback.disposition.notApplied.targetNotFound':
    'Записано — исправление не применено, потому что заменяемых знаний больше нет',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    'Записано — исправление не применено, потому что текст правила отклонён',
  'feedback.disposition.notApplied.outsideWorkspace':
    'Записано — исправление не применено, потому что файл теста находится вне рабочей области',
  'feedback.disposition.quarantined': 'Записано — помещено в карантин ({{cause}})',
  'feedback.recorded.applied.fact': 'Отзыв записан — добавлен факт знаний.',
  'feedback.recorded.applied.caution': 'Отзыв записан — добавлено предостережение.',
  'feedback.recorded.applied.procedureHint': 'Отзыв записан — добавлена подсказка процедуры.',
  'feedback.recorded.applied.testEdit': 'Отзыв записан — файл теста изменён.',
  'feedback.recorded.drafted': 'Отзыв записан — подготовлено исправление (более ранняя отметка).',
  'feedback.recorded.noDraftableFix': 'Отзыв записан — исправление подготовить не удалось.',
  'feedback.recorded.confirmedBug':
    'Отзыв записан — оставлено как настоящая ошибка в продукте, ничего не изменено.',
  'feedback.recorded.notApplied.targetNotFound':
    'Отзыв записан — исправление не применено, потому что заменяемых знаний больше нет.',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'Отзыв записан — исправление не применено, потому что текст правила отклонён.',
  'feedback.recorded.notApplied.outsideWorkspace':
    'Отзыв записан — исправление не применено, потому что файл теста находится вне рабочей области.',
  'feedback.recorded.quarantined': 'Отзыв записан и помещён в карантин ({{cause}}).',
  'feedback.preview.lineLabel.knowledge': 'Знания',
  'feedback.preview.lineLabel.change': 'Изменение',
  'feedback.preview.noRecordsReached': 'Ни одна единица знаний не затронута',
  'feedback.preview.confirmed_one': '{{count}} единица знаний подтверждена',
  'feedback.preview.confirmed_few': '{{count}} единицы знаний подтверждены',
  'feedback.preview.confirmed_many': '{{count}} единиц знаний подтверждено',
  'feedback.preview.confirmed_other': '{{count}} единицы знаний подтверждено',
  'feedback.preview.countedAgainst_one': 'засчитано против: {{count}}',
  'feedback.preview.countedAgainst_few': 'засчитано против: {{count}}',
  'feedback.preview.countedAgainst_many': 'засчитано против: {{count}}',
  'feedback.preview.countedAgainst_other': 'засчитано против: {{count}}',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}} · {{countedAgainst}}',
  'feedback.preview.unreadableRecords_one':
    'Затронуто единиц знаний: {{count}} — прочитать не удаётся',
  'feedback.preview.unreadableRecords_few':
    'Затронуто единиц знаний: {{count}} — прочитать не удаётся',
  'feedback.preview.unreadableRecords_many':
    'Затронуто единиц знаний: {{count}} — прочитать не удаётся',
  'feedback.preview.unreadableRecords_other':
    'Затронуто единиц знаний: {{count}} — прочитать не удаётся',
  'feedback.preview.showRecords': 'Показать единицы знаний ({{number}})',
  'feedback.preview.effect.confirm': 'подтверждает',
  'feedback.preview.effect.overturn': 'засчитывается против',
  'feedback.preview.effect.overturnTimes': 'засчитывается против × {{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}} · {{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'Содержимое единицы знаний не найдено',
  'feedback.preview.contentAbsence.scanIncomplete':
    'Содержимое единицы знаний не удалось прочитать полностью',
  'feedback.preview.contentAbsence.notBound': 'Содержимое единицы знаний недоступно в этой среде',
  'feedback.preview.fix.fact': 'Будет добавлен факт знаний',
  'feedback.preview.fix.caution': 'Будет добавлено предостережение',
  'feedback.preview.fix.procedureHint': 'Будет добавлена подсказка процедуры',
  'feedback.preview.fix.testEdit': 'Файл теста будет изменён',
  'feedback.preview.fix.noDraftableFix': 'По этому запуску исправление сделать нельзя',
  'feedback.preview.fix.confirmedBug':
    'Ничего не изменится — настоящую ошибку в продукте нужно исправлять в продукте, а не в тесте или знаниях',
  'feedback.preview.replaces':
    'Заменяет вашу предыдущую отметку (№{{mark}}); внесённые ею изменения остаются',
  'feedback.preview.replacesAt':
    'Заменяет вашу предыдущую отметку (№{{mark}}, {{time}}); внесённые ею изменения остаются',
  'feedback.preview.resolvedStep.failingStep':
    'Отмечается шаг {{number}} из {{total}} — первый проваленный шаг.',
  'feedback.preview.resolvedStep.lastStepFinished':
    'Отмечается шаг {{number}} из {{total}} — последний шаг, на котором тест завершился.',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'Отмечается шаг {{number}} из {{total}} — последний шаг, так как ни один шаг не провалился.',
  'feedback.preview.showStep': 'Показать шаг {{number}}',
  'feedback.preview.quarantined.timeout':
    'Тест провалился из-за тайм-аута, поэтому ваша отметка записана, но помещена в карантин — знания и тесты не изменятся.',
  'feedback.preview.quarantined.flake':
    'Тест провалился из-за нестабильного запуска, поэтому ваша отметка записана, но помещена в карантин — знания и тесты не изменятся.',
  'feedback.preview.quarantined.environment':
    'Тест провалился из-за проблемы окружения, поэтому ваша отметка записана, но помещена в карантин — знания и тесты не изменятся.',
  'feedback.preview.alreadyMarked':
    'Вы уже это указали. Новая заметка сама по себе не записывается.',
  'feedback.preview.alreadyMarkedAt':
    'Вы уже это указали ({{time}}). Новая заметка сама по себе не записывается.',
  'feedback.preview.refusal.runNotFound':
    'Этого запуска больше нет в хранилище запусков, поэтому отзыв записать нельзя.',
  'feedback.preview.refusal.memberNotFound':
    'Этот тест не найден в запуске, поэтому отзыв записать нельзя.',
  'feedback.preview.refusal.noSteps':
    'Этот тест не записал ни одного шага, поэтому отмечать нечего.',
  'feedback.preview.refusal.stepNotFound_one':
    'Этот тест записал {{count}} шаг, поэтому шага {{number}} для отметки нет.',
  'feedback.preview.refusal.stepNotFound_few':
    'Этот тест записал {{count}} шага, поэтому шага {{number}} для отметки нет.',
  'feedback.preview.refusal.stepNotFound_many':
    'Этот тест записал {{count}} шагов, поэтому шага {{number}} для отметки нет.',
  'feedback.preview.refusal.stepNotFound_other':
    'Этот тест записал {{count}} шага, поэтому шага {{number}} для отметки нет.',
  'feedback.preview.refusal.ambiguousAddress_one':
    'Этот адрес есть у {{count}} теста в этом запуске, поэтому отметку поставить нельзя.',
  'feedback.preview.refusal.ambiguousAddress_few':
    'Этот адрес есть у {{count}} тестов в этом запуске, поэтому отметку поставить нельзя.',
  'feedback.preview.refusal.ambiguousAddress_many':
    'Этот адрес есть у {{count}} тестов в этом запуске, поэтому отметку поставить нельзя.',
  'feedback.preview.refusal.ambiguousAddress_other':
    'Этот адрес есть у {{count}} теста в этом запуске, поэтому отметку поставить нельзя.',
  'feedback.preview.readFailed': 'Не удалось проверить, что произойдёт: {{reason}}.',
  'feedback.readFailure.network': 'сервер панели не ответил',
  'feedback.readFailure.ledgerCorrupt': 'реестр отзывов этого запуска повреждён',
  'feedback.readFailure.ledgerUnavailable': 'реестр отзывов этого запуска сейчас нельзя прочитать',
  'feedback.readFailure.refused': 'сервер отклонил запрос',
  'feedback.readFailure.shape': 'ответ сервера не соответствует ожидаемому формату',
  'feedback.details.row.kind': 'Тип отметки',
  'feedback.details.row.address': 'Адрес',
  'feedback.details.row.testId': 'ID теста',
  'feedback.details.row.records': 'Затронутые единицы знаний',
  'feedback.details.row.basis': 'Основание',
  'feedback.details.basis': 'порядковый номер в реестре {{ledger}}',
  'feedback.details.basisWithPrior':
    'порядковый номер в реестре {{ledger}} · предыдущая отметка №{{prior}}',
  'feedback.history.title.step': 'Отзывы об этом шаге',
  'feedback.history.title.test': 'Отзывы об этом тесте',
  'feedback.history.titleCount.step': 'Отзывы об этом шаге ({{number}})',
  'feedback.history.titleCount.test': 'Отзывы об этом тесте ({{number}})',
  'feedback.history.runLabel': 'Все отзывы об этом запуске ({{number}})',
  'feedback.history.replacedBy': 'Заменено вашей более поздней отметкой',
  'feedback.history.replacedByAt': 'Заменено вашей более поздней отметкой ({{time}})',
  'feedback.history.recordUnavailable': '{{recordId}} (содержимое недоступно)',
  'feedback.history.quoted': '«{{content}}»',
  'feedback.history.appliedKnowledge': 'Изменены знания: {{records}}',
  'feedback.history.appliedTestFile': 'Изменён файл теста {{file}}',
  'feedback.history.change.records': '{{disposition}}: {{records}}',
  'feedback.history.change.file': '{{disposition}}: {{file}}',
  'feedback.history.change.draftedNotRecorded': '{{disposition}}; что было изменено, не записано.',
  'feedback.history.change.contentNotRecorded': '{{disposition}}; содержимое не записано.',
  'feedback.history.empty.step': 'Отзывов об этом шаге пока нет.',
  'feedback.history.empty.test': 'Отзывов об этом тесте пока нет.',
  'feedback.history.empty.run': 'Отзывов об этом запуске пока нет.',
  'feedback.history.state.runNotFound': 'История отзывов этого запуска не найдена.',
  'feedback.history.state.ledgerCorrupt':
    'История отзывов этого запуска повреждена в строке {{line}}, поэтому её нельзя показать.',
  'feedback.history.state.ledgerUnavailable':
    'Историю отзывов этого запуска сейчас нельзя прочитать.',
  'feedback.history.readFailed': 'Не удалось загрузить историю отзывов этого запуска: {{reason}}.',
  'feedback.history.targetStep': 'Шаг {{number}} из {{total}} · {{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}} · весь тест',
  'feedback.composer.noteLabel': 'Заметка (необязательно)',
  'feedback.composer.choiceLegend': 'Что верно?',
  'feedback.composer.testSwitcherLabel': 'Тест',
  'feedback.composer.noUniqueAddress':
    'У этого теста нет уникального адреса в этом запуске, поэтому отзыв о нём записать нельзя.',
  'feedback.composer.submitReason.noUniqueAddress': 'Этот тест нельзя отметить из панели.',
  'feedback.composer.submitReason.noChoice': 'Выберите один из трёх вариантов.',
  'feedback.composer.submitReason.checking': 'Проверка того, что произойдёт…',
  'feedback.composer.submitReason.previewFailed':
    'Не удалось проверить последствия — повторите попытку выше.',
  'feedback.composer.submitReason.refused': 'Эту отметку нельзя записать — см. выше.',
  'feedback.composer.submitReason.alreadyMarked': 'Вы уже это указали — записывать нечего.',
  'feedback.composer.submitReason.sending': 'Отправка…',
  'feedback.composer.send': 'Отправить отзыв',
  'feedback.preview.title': 'Что произойдёт',
  'feedback.composer.sendingStatus': 'Отправка отзыва…',
  'feedback.entry.test': 'Оставить отзыв об этом тесте',
  'feedback.composer.close': 'Закрыть отзыв',
  'feedback.composer.closeTooltip': 'Закрыть (Esc)',
  'feedback.composer.draftKeptStatus':
    'Черновик сохранён. Прочитайте сообщение выше, прежде чем отправлять снова.',
  'feedback.entry.tooltip': 'Оставить отзыв',
  'feedback.entry.markedTooltip': 'Уже отмечено — просмотрите или измените отметку',
  'feedback.preview.updating': 'Обновление…',
  'feedback.preview.idle': 'Выберите вариант выше, чтобы увидеть, что произойдёт.',
  'feedback.preview.unreadableRecord':
    'Эту единицу знаний нельзя прочитать — она остаётся на месте, и к ней ничего не применяется.',
  'feedback.preview.draftWordingNotShown':
    'Точная формулировка здесь не показана — она составляется при отправке.',
  'feedback.retry': 'Повторить',
  'feedback.details.label': 'Технические сведения',
  'feedback.history.active': 'Действует',
  'feedback.history.replacementExplanation':
    'Учитывается только ваша последняя отметка теста или шага.',
  'feedback.history.appliedUnavailable': 'Что изменила эта отметка, не записано.',
  'feedback.preview.cliEscape': 'Отзыв по-прежнему можно записать из CLI ({{name}}) или через MCP.',
  'feedback.preview.retryName': 'Повторить проверку того, что произойдёт',
  'feedback.history.retryName': 'Повторить загрузку истории отзывов',
  'feedback.history.appliedCorrection':
    'Исправление остаётся, когда вы ставите новую отметку: исправьте знания новым отзывом или забудьте их, а изменение теста отмените через git.',
} satisfies Translation<typeof en>
