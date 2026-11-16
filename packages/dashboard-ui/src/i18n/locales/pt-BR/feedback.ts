import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'este teste',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'etapa {{number}}',
  'feedback.place.stepOfTest': 'etapa {{number}} de {{test}}',
  'feedback.composer.pinnedTarget':
    'Você está vendo: {{viewed}}. Este feedback é sobre: {{about}}.',
  'feedback.composer.switchTarget': 'Mudar para: {{place}}',
  'feedback.composer.unsentDraft': 'Rascunho não enviado: {{place}}',
  'feedback.composer.headingStep': 'Feedback sobre a etapa {{number}} de {{total}} · {{name}}',
  'feedback.composer.headingTest': 'Feedback sobre {{name}}',
  'feedback.composer.headingSuiteTest': 'Feedback sobre {{name}} {{handle}}',
  'feedback.choice.falseFail': 'Isto deveria ter passado',
  'feedback.choice.falsePass': 'Isto deveria ter falhado',
  'feedback.choice.confirmedBug': 'Isto é um bug real do produto',
  'feedback.choiceMeaning.failed.falseFail':
    'O aplicativo se comportou corretamente; o teste falhou por engano.',
  'feedback.choiceMeaning.failed.confirmedBug': 'A falha é real: o aplicativo está quebrado aqui.',
  'feedback.choiceMeaning.failed.falsePass':
    'O teste deixou passar um problema que deveria ter detectado.',
  'feedback.choiceMeaning.passed.falseFail': 'A aprovação está certa; isto confirma o teste.',
  'feedback.choiceMeaning.passed.confirmedBug':
    'O aplicativo tem um bug real aqui, mesmo que o teste tenha passado.',
  'feedback.choiceMeaning.passed.falsePass':
    'O aplicativo estava quebrado aqui, mas o teste passou mesmo assim.',
  'feedback.scope.recorded.passed': 'registrado: aprovado',
  'feedback.scope.recorded.healed': 'registrado: reparado (conta como aprovado)',
  'feedback.scope.recorded.failed': 'registrado: com falha',
  'feedback.scope.recorded.timeout': 'registrado: tempo esgotado (conta como falha)',
  'feedback.scope.recorded.cancelled': 'registrado: cancelado (conta como falha)',
  'feedback.scope.recorded.skipped': 'registrado: ignorado (conta como falha)',
  'feedback.scope.noStepVerdict':
    'nenhum veredito de etapa registrado; usando o resultado do teste ({{recorded}})',
  'feedback.scope.wholeTest': 'Teste inteiro · {{recorded}}',
  'feedback.scope.oneStep': 'Uma etapa · {{recorded}}',
  'feedback.scope.oneStepInTest': 'Uma etapa em {{name}} {{handle}} · {{recorded}}',
  'feedback.entry.step': 'Dar feedback sobre a etapa {{number}}',
  'feedback.entry.member': 'Dar feedback sobre {{name}} {{handle}}',
  'feedback.entry.stepMarked': 'Dar feedback sobre a etapa {{number}}. Já marcado: {{choice}}',
  'feedback.entry.testMarked': 'Dar feedback sobre este teste. Já marcado: {{choice}}',
  'feedback.entry.memberMarked': 'Dar feedback sobre {{name}} {{handle}}. Já marcado: {{choice}}',
  'feedback.entry.stepMarkedTooltip': 'A etapa {{number}} já está marcada. Revise ou altere',
  'feedback.entry.markGlyph': 'Marcado: {{choice}}',
  'feedback.disposition.applied.fact': 'Registrado. Um fato de conhecimento foi adicionado',
  'feedback.disposition.applied.caution': 'Registrado. Um alerta foi adicionado',
  'feedback.disposition.applied.procedureHint':
    'Registrado. Uma dica de procedimento foi adicionada',
  'feedback.disposition.applied.testEdit': 'Registrado. O arquivo do teste foi editado',
  'feedback.disposition.drafted': 'Registrado. Uma correção foi rascunhada (marcação antiga)',
  'feedback.disposition.noDraftableFix': 'Registrado. Nenhuma correção pôde ser rascunhada',
  'feedback.disposition.confirmedBug':
    'Registrado. Mantido como um bug real do produto; nada mudou',
  'feedback.disposition.notApplied.targetNotFound':
    'Registrado. A correção não foi aplicada porque o conhecimento que ela substitui não existe mais',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    'Registrado. A correção não foi aplicada porque o texto da política foi recusado',
  'feedback.disposition.notApplied.outsideWorkspace':
    'Registrado. A correção não foi aplicada porque o arquivo do teste está fora do espaço de trabalho',
  'feedback.disposition.quarantined': 'Registrado. Em quarentena ({{cause}})',
  'feedback.recorded.applied.fact': 'Feedback registrado. Um fato de conhecimento foi adicionado.',
  'feedback.recorded.applied.caution': 'Feedback registrado. Um alerta foi adicionado.',
  'feedback.recorded.applied.procedureHint':
    'Feedback registrado. Uma dica de procedimento foi adicionada.',
  'feedback.recorded.applied.testEdit': 'Feedback registrado. O arquivo do teste foi editado.',
  'feedback.recorded.drafted':
    'Feedback registrado. Uma correção foi rascunhada (marcação antiga).',
  'feedback.recorded.noDraftableFix': 'Feedback registrado. Nenhuma correção pôde ser rascunhada.',
  'feedback.recorded.confirmedBug':
    'Feedback registrado. Mantido como um bug real do produto; nada mudou.',
  'feedback.recorded.notApplied.targetNotFound':
    'Feedback registrado. A correção não foi aplicada porque o conhecimento que ela substitui não existe mais.',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'Feedback registrado. A correção não foi aplicada porque o texto da política foi recusado.',
  'feedback.recorded.notApplied.outsideWorkspace':
    'Feedback registrado. A correção não foi aplicada porque o arquivo do teste está fora do espaço de trabalho.',
  'feedback.recorded.quarantined': 'Feedback registrado. Em quarentena ({{cause}}).',
  'feedback.preview.lineLabel.knowledge': 'Conhecimento',
  'feedback.preview.lineLabel.change': 'Mudança',
  'feedback.preview.noRecordsReached': 'Nenhum registro de conhecimento é alcançado',
  'feedback.preview.confirmed_one': '{{count}} registro confirmado',
  'feedback.preview.confirmed_other': '{{count}} registros confirmados',
  'feedback.preview.countedAgainst_one': '{{count}} contado contra',
  'feedback.preview.countedAgainst_other': '{{count}} contados contra',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}} · {{countedAgainst}}',
  'feedback.preview.unreadableRecords_one':
    '{{count}} registro alcançado, mas ele não pode ser lido',
  'feedback.preview.unreadableRecords_other':
    '{{count}} registros alcançados, e nenhum pode ser lido',
  'feedback.preview.showRecords': 'Mostrar registros ({{number}})',
  'feedback.preview.effect.confirm': 'confirma',
  'feedback.preview.effect.overturn': 'conta contra',
  'feedback.preview.effect.overturnTimes': 'conta contra × {{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}} · {{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'Conteúdo do registro não encontrado',
  'feedback.preview.contentAbsence.scanIncomplete':
    'Não foi possível ler todo o conteúdo do registro',
  'feedback.preview.contentAbsence.notBound':
    'O conteúdo do registro não está disponível neste host',
  'feedback.preview.fix.fact': 'Um fato de conhecimento será adicionado',
  'feedback.preview.fix.caution': 'Um alerta será adicionado',
  'feedback.preview.fix.procedureHint': 'Uma dica de procedimento será adicionada',
  'feedback.preview.fix.testEdit': 'O arquivo do teste será editado',
  'feedback.preview.fix.noDraftableFix': 'Nenhuma correção pode ser feita a partir desta execução',
  'feedback.preview.fix.confirmedBug':
    'Nada muda: um bug real do produto precisa de uma correção no produto, não de uma mudança no teste ou no conhecimento',
  'feedback.preview.replaces':
    'Substitui a sua marcação anterior (nº {{mark}}); o que ela mudou continua valendo',
  'feedback.preview.replacesAt':
    'Substitui a sua marcação anterior (nº {{mark}}, {{time}}); o que ela mudou continua valendo',
  'feedback.preview.resolvedStep.failingStep':
    'Isto marca a etapa {{number}} de {{total}}: a primeira etapa que falhou.',
  'feedback.preview.resolvedStep.lastStepFinished':
    'Isto marca a etapa {{number}} de {{total}}: a última etapa, onde o teste terminou.',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'Isto marca a etapa {{number}} de {{total}}: a última etapa, porque nenhuma etapa falhou.',
  'feedback.preview.showStep': 'Mostrar a etapa {{number}}',
  'feedback.preview.quarantined.timeout':
    'Este teste falhou por tempo esgotado, então a sua marcação é registrada, mas fica em quarentena: nenhum conhecimento ou teste muda.',
  'feedback.preview.quarantined.flake':
    'Este teste falhou por uma execução instável, então a sua marcação é registrada, mas fica em quarentena: nenhum conhecimento ou teste muda.',
  'feedback.preview.quarantined.environment':
    'Este teste falhou por um problema de ambiente, então a sua marcação é registrada, mas fica em quarentena: nenhum conhecimento ou teste muda.',
  'feedback.preview.alreadyMarked': 'Você já disse isso. Uma nova nota sozinha não é registrada.',
  'feedback.preview.alreadyMarkedAt':
    'Você já disse isso ({{time}}). Uma nova nota sozinha não é registrada.',
  'feedback.preview.refusal.runNotFound':
    'Esta execução não está mais no armazenamento de execuções, então o feedback não pode ser registrado.',
  'feedback.preview.refusal.memberNotFound':
    'Este teste não foi encontrado na execução, então o feedback não pode ser registrado.',
  'feedback.preview.refusal.noSteps':
    'Este teste não registrou nenhuma etapa, então não há nada para marcar.',
  'feedback.preview.refusal.stepNotFound_one':
    'Este teste registrou {{count}} etapa, então não existe a etapa {{number}} para marcar.',
  'feedback.preview.refusal.stepNotFound_other':
    'Este teste registrou {{count}} etapas, então não existe a etapa {{number}} para marcar.',
  'feedback.preview.refusal.ambiguousAddress_one':
    '{{count}} teste desta execução tem este endereço, então a marcação não pode ser feita.',
  'feedback.preview.refusal.ambiguousAddress_other':
    '{{count}} testes desta execução compartilham este endereço, então a marcação não pode ser feita.',
  'feedback.preview.readFailed': 'Não foi possível verificar o que isto vai fazer: {{reason}}.',
  'feedback.readFailure.network': 'o servidor do painel não respondeu',
  'feedback.readFailure.ledgerCorrupt': 'o arquivo de feedback desta execução está danificado',
  'feedback.readFailure.ledgerUnavailable':
    'o arquivo de feedback desta execução não pode ser lido agora',
  'feedback.readFailure.refused': 'o servidor recusou a requisição',
  'feedback.readFailure.shape': 'a resposta do servidor não tinha o formato esperado',
  'feedback.details.row.kind': 'Tipo de marcação',
  'feedback.details.row.address': 'Endereço',
  'feedback.details.row.testId': 'ID do teste',
  'feedback.details.row.records': 'Registros alcançados',
  'feedback.details.row.basis': 'Base',
  'feedback.details.basis': 'posição {{ledger}} no arquivo de feedback',
  'feedback.details.basisWithPrior':
    'posição {{ledger}} no arquivo de feedback · marcação anterior nº {{prior}}',
  'feedback.history.title.step': 'Feedback sobre esta etapa',
  'feedback.history.title.test': 'Feedback sobre este teste',
  'feedback.history.titleCount.step': 'Feedback sobre esta etapa ({{number}})',
  'feedback.history.titleCount.test': 'Feedback sobre este teste ({{number}})',
  'feedback.history.runLabel': 'Todo o feedback desta execução ({{number}})',
  'feedback.history.replacedBy': 'Substituída pela sua marcação posterior',
  'feedback.history.replacedByAt': 'Substituída pela sua marcação posterior ({{time}})',
  'feedback.history.recordUnavailable': '{{recordId}} (conteúdo indisponível)',
  'feedback.history.quoted': '“{{content}}”',
  'feedback.history.appliedKnowledge': 'Conhecimento alterado: {{records}}',
  'feedback.history.appliedTestFile': 'Arquivo do teste editado: {{file}}',
  'feedback.history.change.records': '{{disposition}}: {{records}}',
  'feedback.history.change.file': '{{disposition}}: {{file}}',
  'feedback.history.change.draftedNotRecorded': '{{disposition}}; o que mudou não foi registrado.',
  'feedback.history.change.contentNotRecorded': '{{disposition}}; o conteúdo não foi registrado.',
  'feedback.history.empty.step': 'Nenhum feedback sobre esta etapa ainda.',
  'feedback.history.empty.test': 'Nenhum feedback sobre este teste ainda.',
  'feedback.history.empty.run': 'Nenhum feedback sobre esta execução ainda.',
  'feedback.history.state.runNotFound':
    'Não foi possível encontrar o histórico de feedback desta execução.',
  'feedback.history.state.ledgerCorrupt':
    'O histórico de feedback desta execução está danificado na linha {{line}}, então não pode ser mostrado.',
  'feedback.history.state.ledgerUnavailable':
    'Não é possível ler o histórico de feedback desta execução agora.',
  'feedback.history.readFailed':
    'Não foi possível carregar o histórico de feedback desta execução: {{reason}}.',
  'feedback.history.targetStep': 'Etapa {{number}} de {{total}} · {{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}} · teste inteiro',
  'feedback.composer.noteLabel': 'Nota (opcional)',
  'feedback.composer.choiceLegend': 'O que é verdade?',
  'feedback.composer.testSwitcherLabel': 'Teste',
  'feedback.composer.noUniqueAddress':
    'Este teste não tem um endereço único nesta execução, então não é possível registrar feedback para ele.',
  'feedback.composer.submitReason.noUniqueAddress': 'Este teste não pode ser marcado pelo painel.',
  'feedback.composer.submitReason.noChoice': 'Escolha uma das três opções.',
  'feedback.composer.submitReason.checking': 'Verificando o que isto vai fazer…',
  'feedback.composer.submitReason.previewFailed':
    'Não foi possível verificar as consequências. Tente novamente acima.',
  'feedback.composer.submitReason.refused': 'Esta marcação não pode ser registrada. Veja acima.',
  'feedback.composer.submitReason.alreadyMarked':
    'Você já disse isso; não há nada novo para registrar.',
  'feedback.composer.submitReason.sending': 'Enviando…',
  'feedback.composer.send': 'Enviar feedback',
  'feedback.preview.title': 'O que isto vai fazer',
  'feedback.composer.sendingStatus': 'Enviando feedback…',
  'feedback.entry.test': 'Dar feedback sobre este teste',
  'feedback.composer.close': 'Fechar feedback',
  'feedback.composer.closeTooltip': 'Fechar (Esc)',
  'feedback.composer.draftKeptStatus':
    'Rascunho mantido. Confira a mensagem acima antes de enviar de novo.',
  'feedback.entry.tooltip': 'Dar feedback',
  'feedback.entry.markedTooltip': 'Já marcado. Revise ou altere',
  'feedback.preview.updating': 'Atualizando…',
  'feedback.preview.idle': 'Escolha uma opção acima para ver o que isto vai fazer.',
  'feedback.preview.unreadableRecord':
    'Este registro não pode ser lido. Ele mantém o seu lugar, e nada é aplicado a ele.',
  'feedback.preview.draftWordingNotShown':
    'O texto exato não aparece aqui; ele é escrito quando você envia.',
  'feedback.retry': 'Tentar novamente',
  'feedback.details.label': 'Detalhes técnicos',
  'feedback.history.active': 'Ativa',
  'feedback.history.replacementExplanation':
    'Só conta a sua marcação mais recente em um teste ou em uma etapa.',
  'feedback.history.appliedUnavailable': 'O que esta marcação mudou não foi registrado.',
  'feedback.preview.cliEscape':
    'Você ainda pode registrar feedback pela CLI ({{name}}) ou via MCP.',
  'feedback.preview.retryName': 'Tentar verificar novamente o que isto vai fazer',
  'feedback.history.retryName': 'Tentar carregar o histórico de feedback novamente',
  'feedback.history.appliedCorrection':
    'Uma correção continua valendo quando você marca de novo: corrija o conhecimento com um novo feedback ou esquecendo-o, e reverta uma edição de teste com o git.',
} satisfies Translation<typeof en>
