import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'Boas-vindas ao agent-qa',
  'tour.intro.body':
    'Com o agent-qa você escreve testes em linguagem natural para web e dispositivos móveis. Ele os executa em um ambiente de QA rigoroso, aprende com as execuções anteriores, se adapta quando a interface muda e mostra exatamente o que aconteceu.',
  'tour.llmSetup.title': 'Configure seu LLM primeiro',
  'tour.runs.title': 'As execuções mostram os resultados',
  'tour.runs.body':
    'As execuções mostram os resultados, os artefatos e o raciocínio de cada execução do agent-qa.',
  'tour.tests.title': 'Os testes guardam verificações em linguagem natural',
  'tour.tests.body':
    'Os testes são verificações em linguagem natural que o agent-qa pode executar no destino web ou móvel que você configurou.',
  'tour.suites.title': 'As suítes agrupam fluxos repetíveis',
  'tour.suites.body':
    'As suítes agrupam verificações relacionadas em fluxos repetíveis quando um único teste não basta.',
  'tour.hooks.title': 'Os hooks são executados em volta das etapas e entre elas',
  'tour.hooks.body':
    'Os hooks podem preparar o ambiente, ser executados entre as etapas e cuidar da limpeza antes e depois de um teste ou de uma suíte.',
  'tour.config.title': 'A configuração controla o ambiente local',
  'tour.config.body':
    'A configuração controla o modelo, o destino, o ambiente de execução e o painel que o agent-qa usa localmente.',
  'tour.exampleTest.title': 'Execute o teste de exemplo que deve passar',
  'tour.exampleTest.body':
    'Este teste gerado é a primeira execução mais segura, porque o init o cria para validar a sua configuração.',
  'tour.exampleMissing.title': 'Encontre o teste de exemplo que deve passar',
  'tour.exampleMissing.body':
    'O agent-qa init normalmente cria um teste de exemplo que deve passar. Escolha-o em Testes quando ele estiver disponível ou crie um depois.',
  'tour.runAction.title': 'Clique em Executar quando estiver pronto',
  'tour.runAction.body':
    'Clique em Executar quando estiver pronto. O tour continua a partir da tela da execução ou da página Execuções.',
  'tour.liveRun.title': 'Acompanhe a execução ao vivo',
  'tour.liveRun.body':
    'O modo ao vivo mostra o teste em execução: as etapas de um lado e o navegador ao lado delas.',
  'tour.runDetail.title': 'Examine os detalhes da execução',
  'tour.runDetail.body':
    'Este é o momento que importa: examine o que o agent-qa observou, planejou, executou e verificou.',
  'tour.githubNudge.title': 'Se o agent-qa ajudou você',
  'tour.githubNudge.body': 'Se o agent-qa ajudou você, considere dar uma estrela a ele no GitHub.',
  'tour.githubNudge.actionLabel': 'Ver no GitHub',
  'tour.runsFallback.title': 'Abra sua execução mais recente',
  'tour.runsFallback.body':
    'Se ainda não houver uma execução aberta aqui, use Execuções para abrir a mais recente e examinar a tela de detalhes.',
  'tour.ui.progress': 'Progresso do tour: {{current}} de {{total}}',
  'tour.ui.skip': 'Pular',
  'tour.ui.restart': 'Recomeçar',
  'tour.ui.back': 'Voltar',
  'tour.ui.done': 'Concluir',
  'tour.ui.startTour': 'Iniciar tour',
} satisfies Translation<typeof en>
