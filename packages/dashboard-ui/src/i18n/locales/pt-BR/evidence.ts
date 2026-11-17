import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': 'Carregando registros',
  'evidence.incompleteExplanation':
    'Evidências incompletas: isto foi registrado, mas o arquivo salvo não está mais no disco.',
  'evidence.recordedOnStep': 'Registrado na etapa {{step}}',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': 'Ir para a etapa {{step}}',

  'evidence.retry.variables': 'Tentar carregar as variáveis novamente',
  'evidence.retry.network': 'Tentar carregar os registros de rede novamente',
  'evidence.retry.console': 'Tentar carregar os registros do console novamente',
  'evidence.retry.aria': 'Tentar carregar a árvore ARIA novamente',
  'evidence.retry.a11y': 'Tentar carregar os resultados de acessibilidade novamente',
  'evidence.retry.video': 'Tentar carregar a gravação novamente',
  'evidence.retry.frame': 'Tentar carregar a captura de tela novamente',

  'evidence.variables.empty.title': 'Nenhuma variável nesta etapa',
  'evidence.variables.empty.explanation':
    'Nenhuma variável estava definida quando esta etapa foi executada.',
  'evidence.variables.notCaptured.title': 'Variáveis não registradas para esta etapa',
  'evidence.variables.notCaptured.explanation':
    'Nenhum instantâneo das variáveis foi salvo para esta etapa.',
  'evidence.variables.unsupported.title': 'As variáveis não são registradas nesta plataforma',
  'evidence.variables.unsupported.explanation':
    'A plataforma desta execução não permite salvar um instantâneo das variáveis.',
  'evidence.variables.unavailable.title': 'Variáveis indisponíveis para esta execução',
  'evidence.variables.unavailable.explanation':
    'As variáveis não eram registradas quando esta execução aconteceu, então não há nada para mostrar.',
  'evidence.variables.failed.capture.title': 'Falha ao capturar as variáveis',
  'evidence.variables.failed.capture.explanation':
    'Não foi possível salvar o instantâneo das variáveis durante a execução. Não há nada para tentar novamente.',
  'evidence.variables.failed.load.title': 'Não foi possível carregar as variáveis',
  'evidence.variables.failed.load.explanation':
    'As variáveis foram registradas, mas não carregaram.',
  'evidence.variables.noSelection.title': 'Nenhuma etapa selecionada',
  'evidence.variables.noSelection.explanation':
    'As variáveis são mostradas por etapa. Escolha uma etapa na árvore ou na linha do tempo para vê-las.',

  'evidence.network.empty.title': 'Nenhuma requisição de rede',
  'evidence.network.empty.explanation': 'A página não fez nenhuma requisição durante esta etapa.',
  'evidence.network.notCaptured.title': 'Rede não registrada para esta etapa',
  'evidence.network.notCaptured.explanation':
    'Nenhuma atividade de rede foi salva para esta etapa.',
  'evidence.network.unsupported.title': 'A rede não é registrada nesta plataforma',
  'evidence.network.unsupported.explanation':
    'A plataforma desta execução não permite capturar requisições de rede.',
  'evidence.network.unavailable.title': 'Rede indisponível para esta execução',
  'evidence.network.unavailable.explanation':
    'A atividade de rede não era registrada quando esta execução aconteceu. Isso não significa que a execução não fez requisições.',
  'evidence.network.failed.capture.title': 'Falha ao capturar a rede',
  'evidence.network.failed.capture.explanation':
    'Não foi possível capturar a atividade de rede durante a execução. Não há nada para tentar novamente.',
  'evidence.network.failed.load.title': 'Não foi possível carregar os registros de rede',
  'evidence.network.failed.load.explanation': 'Os registros existem, mas não carregaram.',
  'evidence.network.noSelection.title': 'Nenhuma etapa selecionada',
  'evidence.network.noSelection.explanation':
    'As requisições de rede são mostradas por etapa. Escolha uma etapa na árvore ou na linha do tempo para vê-las.',

  'evidence.console.empty.title': 'Nenhuma saída no console',
  'evidence.console.empty.explanation':
    'A página não registrou nada no console durante esta etapa.',
  'evidence.console.notCaptured.title': 'Console não registrado para esta etapa',
  'evidence.console.notCaptured.explanation': 'Nenhuma saída do console foi salva para esta etapa.',
  'evidence.console.unsupported.title': 'O console não é registrado nesta plataforma',
  'evidence.console.unsupported.explanation':
    'A plataforma desta execução não permite capturar a saída do console.',
  'evidence.console.unavailable.title': 'Console indisponível para esta execução',
  'evidence.console.unavailable.explanation':
    'A saída do console não era registrada quando esta execução aconteceu. Isso não significa que a página não registrou nada.',
  'evidence.console.failed.capture.title': 'Falha ao capturar o console',
  'evidence.console.failed.capture.explanation':
    'Não foi possível capturar a saída do console durante a execução. Não há nada para tentar novamente.',
  'evidence.console.failed.load.title': 'Não foi possível carregar os registros do console',
  'evidence.console.failed.load.explanation': 'Os registros existem, mas não carregaram.',
  'evidence.console.noSelection.title': 'Nenhuma etapa selecionada',
  'evidence.console.noSelection.explanation':
    'A saída do console é mostrada por etapa. Escolha uma etapa na árvore ou na linha do tempo para vê-la.',

  'evidence.aria.empty.title': 'Árvore de acessibilidade vazia',
  'evidence.aria.empty.explanation':
    'A tela não expunha nenhum elemento acessível quando esta ação foi decidida.',
  'evidence.aria.notCaptured.title': 'Árvore ARIA não registrada para esta ação',
  'evidence.aria.notCaptured.explanation':
    'Nenhuma árvore de acessibilidade foi salva para esta subação.',
  'evidence.aria.unsupported.title': 'A árvore ARIA não é registrada nesta plataforma',
  'evidence.aria.unsupported.explanation':
    'A plataforma desta execução não permite capturar uma árvore de acessibilidade.',
  'evidence.aria.unavailable.title': 'Árvore ARIA indisponível para esta execução',
  'evidence.aria.unavailable.explanation':
    'A árvore de acessibilidade não era registrada quando esta execução aconteceu.',
  'evidence.aria.failed.capture.title': 'Falha ao capturar a árvore ARIA',
  'evidence.aria.failed.capture.explanation':
    'Não foi possível capturar a árvore de acessibilidade durante a execução. Não há nada para tentar novamente.',
  'evidence.aria.failed.load.title': 'Não foi possível carregar a árvore ARIA',
  'evidence.aria.failed.load.explanation': 'A árvore foi registrada, mas não carregou.',
  'evidence.aria.noSelection.title': 'Nenhuma subação selecionada',
  'evidence.aria.noSelection.explanation':
    'A árvore de acessibilidade é mostrada por subação. Escolha uma subação na árvore ou na linha do tempo para ver o que o modelo viu.',

  'evidence.a11y.empty.title': 'Nenhuma violação de acessibilidade encontrada',
  'evidence.a11y.empty.explanation':
    'As verificações foram executadas nesta etapa e não encontraram nada para corrigir.',
  'evidence.a11y.notCaptured.title':
    'Verificações de acessibilidade não registradas para esta etapa',
  'evidence.a11y.notCaptured.explanation':
    'Nenhum resultado de acessibilidade foi salvo para esta etapa.',
  'evidence.a11y.unsupported.title':
    'As verificações de acessibilidade não são compatíveis com esta plataforma',
  'evidence.a11y.unsupported.explanation':
    'A plataforma desta execução não consegue executar verificações de acessibilidade.',
  'evidence.a11y.unavailable.title':
    'Resultados de acessibilidade indisponíveis para esta execução',
  'evidence.a11y.unavailable.explanation':
    'As verificações de acessibilidade não eram registradas quando esta execução aconteceu. Isso não significa que a execução não teve violações.',
  'evidence.a11y.failed.capture.title': 'Falha ao executar as verificações de acessibilidade',
  'evidence.a11y.failed.capture.explanation':
    'As verificações encontraram um erro durante a execução, então não há resultados. Não há nada para tentar novamente.',
  'evidence.a11y.failed.load.title': 'Não foi possível carregar os resultados de acessibilidade',
  'evidence.a11y.failed.load.explanation': 'Os resultados existem, mas não carregaram.',
  'evidence.a11y.noSelection.title': 'Nenhuma etapa selecionada',
  'evidence.a11y.noSelection.explanation':
    'Os resultados de acessibilidade são mostrados por etapa. Escolha uma etapa na árvore ou na linha do tempo para vê-los.',

  'evidence.video.empty.title': 'A gravação não tem vídeo',
  'evidence.video.empty.explanation':
    'Uma gravação foi salva para este teste, mas não contém nada para reproduzir.',
  'evidence.video.notCaptured.title': 'Nenhuma gravação para este teste',
  'evidence.video.notCaptured.explanation':
    'Nenhum vídeo foi salvo para este teste. A aba Quadros ainda mostra o que o modelo viu em cada decisão.',
  'evidence.video.unsupported.title': 'A gravação não é compatível com esta plataforma',
  'evidence.video.unsupported.explanation':
    'A plataforma desta execução não grava vídeo. A aba Quadros ainda mostra o que o modelo viu em cada decisão.',
  'evidence.video.unavailable.title': 'Gravação indisponível para esta execução',
  'evidence.video.unavailable.explanation':
    'O vídeo não era gravado quando esta execução aconteceu. A aba Quadros ainda mostra o que o modelo viu em cada decisão.',
  'evidence.video.failed.capture.title': 'Falha na gravação',
  'evidence.video.failed.capture.explanation':
    'Não foi possível salvar o vídeo quando este teste terminou. Não há nada para tentar novamente. A aba Quadros ainda mostra o que o modelo viu em cada decisão.',
  'evidence.video.failed.load.title': 'Não foi possível carregar a gravação',
  'evidence.video.failed.load.explanation':
    'A gravação existe, mas não carregou. Tente novamente ou mude para a aba Quadros.',
  'evidence.video.noSelection.title': 'Nenhuma etapa selecionada',
  'evidence.video.noSelection.explanation':
    'A gravação acompanha a linha do tempo. Escolha uma etapa na árvore ou na linha do tempo para posicioná-la.',

  'evidence.frame.notCaptured.subAction.title': 'Nenhuma captura de tela para esta ação',
  'evidence.frame.notCaptured.subAction.explanation':
    'Nenhuma captura de tela foi salva para esta subação.',
  'evidence.frame.notCaptured.step.title': 'Nenhuma captura de tela para esta etapa',
  'evidence.frame.notCaptured.step.explanation':
    'Nenhuma subação desta etapa salvou uma captura de tela.',
  'evidence.frame.unavailable.title': 'Captura de tela indisponível',
  'evidence.frame.failed.load.title': 'Não foi possível carregar a captura de tela',
  'evidence.frame.failed.load.explanation': 'A captura de tela existe, mas não carregou.',

  'evidence.tab.variables': 'Variáveis',
  'evidence.tab.network': 'Rede',
  'evidence.tab.console': 'Console',
  'evidence.tab.aria': 'Árvore ARIA',
  'evidence.tab.a11y': 'A11y',
  'evidence.trigger.variables': 'Variáveis, {{number}}',
  'evidence.trigger.aria': 'Árvore ARIA, {{number}}',
  'evidence.trigger.consoleErrors_one': 'Console, {{count}} erro',
  'evidence.trigger.consoleErrors_other': 'Console, {{count}} erros',
  'evidence.trigger.consoleMessages_one': 'Console, {{count}} mensagem',
  'evidence.trigger.consoleMessages_other': 'Console, {{count}} mensagens',
  'evidence.trigger.networkFailed_one': 'Rede, {{count}} requisição com falha',
  'evidence.trigger.networkFailed_other': 'Rede, {{count}} requisições com falha',
  'evidence.trigger.networkRequests_one': 'Rede, {{count}} requisição',
  'evidence.trigger.networkRequests_other': 'Rede, {{count}} requisições',
  'evidence.trigger.a11yViolations_one': 'A11y, {{count}} violação',
  'evidence.trigger.a11yViolations_other': 'A11y, {{count}} violações',
  'evidence.trigger.absent': '{{tab}}: {{title}}',
  'evidence.signal.console_one': '{{count}} erro de console na etapa {{step}}. Abrir Console',
  'evidence.signal.console_other': '{{count}} erros de console na etapa {{step}}. Abrir Console',
  'evidence.signal.network_one': '{{count}} requisição com falha na etapa {{step}}. Abrir Rede',
  'evidence.signal.network_other': '{{count}} requisições com falha na etapa {{step}}. Abrir Rede',
  'evidence.signal.a11y_one': '{{count}} violação de acessibilidade na etapa {{step}}. Abrir A11y',
  'evidence.signal.a11y_other':
    '{{count}} violações de acessibilidade na etapa {{step}}. Abrir A11y',

  'evidence.drawer.test': 'Teste',
  'evidence.drawer.config': 'Configuração',
  'evidence.drawer.testAsWritten': 'Teste como foi escrito',
  'evidence.drawer.resolvedDefinition': 'Definição resolvida',
  'evidence.drawer.suiteMembers': 'Membros da suíte',
  'evidence.drawer.runTests': 'Testes desta execução',
  'evidence.drawer.runAttributes': 'Atributos da execução',
  'evidence.drawer.effectiveConfig': 'Configuração efetiva',
  'evidence.drawer.globalConfigAsWritten': 'Configuração global como foi escrita',
  'evidence.drawer.model': 'Modelo',
  'evidence.drawer.runtime': 'Ambiente de execução',
  'evidence.drawer.errors': 'Erros',
  'evidence.drawer.notCaptured': 'Não capturado',
  'evidence.drawer.configNotCaptured': 'Configuração não capturada',
  'evidence.drawer.unsealedCapture':
    'A captura da preparação desta execução não terminou, então o teste e a configuração mostrados aqui podem estar incompletos.',
  'evidence.drawer.technicalDetails': 'Detalhes técnicos',
  'evidence.drawer.runId': 'ID da execução',
  'evidence.drawer.artifactKind': 'Tipo de artefato',
  'evidence.drawer.schemaVersion': 'Versão do esquema',
  'evidence.drawer.captureSealedAt': 'Captura selada em',
  'evidence.drawer.copyRunId': 'Copiar ID da execução',
  'evidence.drawer.retry': 'Tentar carregar os detalhes da execução novamente',
  'evidence.drawer.ranHere': 'Executado nesta máquina',
  'evidence.drawer.ranHereOn': 'Executado nesta máquina ({{deviceType}})',
  'evidence.drawer.deviceType.simulator': 'simulador',
  'evidence.drawer.deviceType.realDevice': 'dispositivo real',
  'evidence.drawer.opensInNewTab': '(abre em uma nova aba)',
  'evidence.drawer.remote': '{{name}} ({{where}})',
  'evidence.drawer.ranOn': 'Executado em {{remote}}',
  'evidence.drawer.ranOnVersion': 'Executado em {{remote}}, {{version}}',
  'evidence.drawer.lostOn': 'Executado em {{remote}} até a conexão ser perdida',
  'evidence.drawer.lostOnVersion':
    'Executado em {{remote}}, {{version}}, até a conexão ser perdida',
  'evidence.drawer.endedOn': 'Executado em {{remote}} até o remoto encerrar a sessão',
  'evidence.drawer.endedOnVersion':
    'Executado em {{remote}}, {{version}}, até o remoto encerrar a sessão',
  'evidence.drawer.couldNotRun': 'Não foi possível executar em {{remote}}: {{reason}}',
  'evidence.drawer.sessionRefused': 'sessão recusada',
  'evidence.drawer.plugin': 'Plugin {{entry}}',
  'evidence.drawer.pluginSource': 'Plugin {{entry}} ({{source}})',
  'evidence.drawer.sessionPage': 'Página da sessão',
  'evidence.drawer.kind.test': 'Teste',
  'evidence.drawer.kind.unknown': 'Não registrado',
  'evidence.drawer.titleFallback': 'Execução {{id}}',

  'evidence.scope.step': 'Etapa {{step}} de {{total}} · etapa inteira',
  'evidence.scope.subAction': 'Subação nº {{number}} de {{total}} · etapa {{step}}',

  'evidence.artifact.loadingLabel': 'Carregando dados do artefato',
  'evidence.artifact.loading': 'Carregando dados do artefato…',
  'evidence.artifact.loadFailed': 'Não foi possível carregar os dados do artefato',
  'evidence.artifact.loadFailedHelp':
    'Tente a requisição novamente. Se o problema continuar, verifique se o servidor do painel consegue ler os artefatos das execuções.',
  'evidence.artifact.missing': 'Os dados do artefato não estão disponíveis para esta execução',
  'evidence.artifact.missingHelp': 'Esta execução não tem um registro de artefato salvo.',
  'evidence.artifact.none': 'Nenhum',
  'evidence.artifact.items_one': '{{count}} item',
  'evidence.artifact.items_other': '{{count}} itens',
  'evidence.artifact.fields_one': '{{count}} campo',
  'evidence.artifact.fields_other': '{{count}} campos',
  'evidence.artifact.sectionNotCaptured': 'Seção não capturada nesta execução: {{section}}.',
  'evidence.artifact.unnamedMember': 'Membro sem nome',
  'evidence.artifact.testId': 'ID do teste',
  'evidence.artifact.ref': 'Referência',
  'evidence.artifact.refId': 'ID da referência',
  'evidence.artifact.path': 'Caminho',
  'evidence.artifact.target': 'Destino',
  'evidence.artifact.childRun': 'Execução filha',
  'evidence.artifact.error': 'Erro',
  'evidence.artifact.ranAgainst': 'Executado em',
  'evidence.artifact.memberSnapshots': 'Instantâneos dos membros',
  'evidence.artifact.rawTestYaml': 'YAML bruto do teste',
  'evidence.artifact.rawMemberYaml': 'YAML bruto do membro',
  'evidence.artifact.rawSuiteYaml': 'YAML bruto da suíte',
  'evidence.artifact.rawGlobalConfig': 'Configuração global bruta',
  'evidence.artifact.noAttributes': 'Nenhum atributo da execução',
  'evidence.artifact.noAttributesHelp': 'Esta execução não registrou nenhum atributo.',
  'evidence.artifact.copyJson': 'Copiar JSON',
  'evidence.artifact.copyNamedValue': 'Copiar o valor de {{key}}',
  'evidence.artifact.copyValue': 'Copiar valor',
} satisfies Translation<typeof en>
