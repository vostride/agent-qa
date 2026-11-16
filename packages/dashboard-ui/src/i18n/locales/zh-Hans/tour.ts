import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': '欢迎使用 agent-qa',
  'tour.intro.body':
    'agent-qa 让你用自然语言为 Web 和移动应用编写测试。它通过严格的 QA 框架运行测试，从过去的运行中学习，在界面变化时自动适应，并准确展示发生了什么。',
  'tour.llmSetup.title': '先配置 LLM',
  'tour.runs.title': '运行展示结果',
  'tour.runs.body': '运行展示每次 agent-qa 执行的结果、产物和推理过程。',
  'tour.tests.title': '测试是自然语言检查',
  'tour.tests.body':
    '测试是用自然语言编写的检查，agent-qa 可以针对已配置的 Web 或移动目标运行它们。',
  'tour.suites.title': '套件组合可重复的流程',
  'tour.suites.body': '当一个测试不够用时，套件可以把相关检查组合成可重复的流程。',
  'tour.hooks.title': '钩子在步骤前后和步骤之间运行',
  'tour.hooks.body': '钩子可以准备环境，在步骤之间内联运行，并在测试或套件前后完成清理。',
  'tour.config.title': '配置控制本地设置',
  'tour.config.body': '配置控制 agent-qa 在本地使用的模型、目标、运行时和仪表板设置。',
  'tour.exampleTest.title': '运行会通过的示例测试',
  'tour.exampleTest.body':
    '这个生成的测试最适合作为第一次运行，因为 init 创建它就是为了验证你的设置。',
  'tour.exampleMissing.title': '找到会通过的示例测试',
  'tour.exampleMissing.body':
    'agent-qa init 通常会创建一个会通过的示例测试。它可用时请从“测试”中选择，也可以稍后再创建一个。',
  'tour.runAction.title': '准备好后点击“运行”',
  'tour.runAction.body': '准备好后点击“运行”。导览将从运行界面或“运行”页面继续。',
  'tour.liveRun.title': '实时观看运行',
  'tour.liveRun.body': '实时模式显示正在运行的测试：一侧是它的步骤，旁边是浏览器。',
  'tour.runDetail.title': '查看运行详情',
  'tour.runDetail.body': '这是最有价值的时刻：查看 agent-qa 观察、计划、执行和验证了什么。',
  'tour.githubNudge.title': '如果 agent-qa 对你有帮助',
  'tour.githubNudge.body': '如果 agent-qa 对你有帮助，欢迎在 GitHub 上为它点个星标。',
  'tour.githubNudge.actionLabel': '在 GitHub 上查看',
  'tour.runsFallback.title': '打开最近的运行',
  'tour.runsFallback.body':
    '如果这里还没有打开的运行，请在“运行”中打开最近一次执行并查看详情视图。',
  'tour.ui.progress': '导览进度：第 {{current}} 步，共 {{total}} 步',
  'tour.ui.skip': '跳过',
  'tour.ui.restart': '重新开始',
  'tour.ui.back': '上一步',
  'tour.ui.done': '完成',
  'tour.ui.startTour': '开始导览',
} satisfies Translation<typeof en>
