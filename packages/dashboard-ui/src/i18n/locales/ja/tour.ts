import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'agent-qaへようこそ',
  'tour.intro.body':
    'agent-qaでは、Webとモバイルのテストを自然言語で書けます。テストは厳密なQAハーネスで実行され、過去の実行から学習し、UIが変わっても適応し、何が起きたのかを正確に示します。',
  'tour.llmSetup.title': 'まずLLMを設定',
  'tour.runs.title': '実行で結果を確認',
  'tour.runs.body': '実行には、agent-qaによる各実行の結果、成果物、推論が表示されます。',
  'tour.tests.title': 'テストは自然言語のチェック',
  'tour.tests.body':
    'テストは、設定したWebまたはモバイルのターゲットに対してagent-qaが実行できる、自然言語のチェックです。',
  'tour.suites.title': 'スイートで繰り返せるワークフローをまとめる',
  'tour.suites.body':
    'テスト1つでは足りない場合、スイートで関連するチェックを繰り返し実行できるワークフローにまとめます。',
  'tour.hooks.title': 'フックはステップの前後や間に実行',
  'tour.hooks.body':
    'フックは、テストやスイートの前後で準備や後片付けを行い、ステップの間でインライン実行することもできます。',
  'tour.config.title': '設定でローカル環境を管理',
  'tour.config.body':
    '設定では、agent-qaがローカルで使うモデル、ターゲット、ランタイム、ダッシュボードの構成を管理します。',
  'tour.exampleTest.title': '成功するサンプルテストを実行',
  'tour.exampleTest.body':
    'このテストはinitが環境の検証用に作成したもので、最初の実行に最も安全です。',
  'tour.exampleMissing.title': '成功するサンプルテストを探す',
  'tour.exampleMissing.body':
    'agent-qa initは通常、「Example passing test」を作成します。利用できる場合はテストから選ぶか、後で作成してください。',
  'tour.runAction.title': '準備ができたら「実行」をクリック',
  'tour.runAction.body':
    '準備ができたら「実行」をクリックしてください。ツアーは実行画面または「実行」ページから続きます。',
  'tour.liveRun.title': '実行をライブで見る',
  'tour.liveRun.body':
    'ライブモードでは実行中のテストが表示されます。片側にステップが、その横にブラウザーが表示されます。',
  'tour.runDetail.title': '実行の詳細を確認',
  'tour.runDetail.body':
    'ここが一番の見どころです。agent-qaが何を観察し、計画し、実行し、検証したのかを確認できます。',
  'tour.githubNudge.title': 'agent-qaが役に立ったら',
  'tour.githubNudge.body': 'agent-qaが役に立ったら、GitHubでスターを付けてください。',
  'tour.githubNudge.actionLabel': 'GitHubで見る',
  'tour.runsFallback.title': '最新の実行を開く',
  'tour.runsFallback.body':
    'ここにまだ実行が開いていない場合は、「実行」ページで最新の実行を開き、詳細ビューを確認してください。',
  'tour.ui.progress': 'ツアーの進行状況：{{current}}/{{total}}',
  'tour.ui.skip': 'スキップ',
  'tour.ui.restart': '最初から',
  'tour.ui.back': '戻る',
  'tour.ui.done': '完了',
  'tour.ui.startTour': 'ツアーを開始',
} satisfies Translation<typeof en>
