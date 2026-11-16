import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'インサイト',
  'insights.description':
    '期間全体の信頼性、コスト、キュレーターのシグナルと、テスト、スイート、プラットフォームを比較する別セクションです。',
  'insights.scope.label': '実行の範囲',
  'insights.scope.scoped': 'スコープ内',
  'insights.scope.all': 'すべての実行',
  'insights.window.label': '期間',
  'insights.window.oneDay': '1日',
  'insights.window.sevenDays': '7日',
  'insights.window.thirtyDays': '30日',
  'insights.window.all': '全期間',
  'insights.refreshing': '選択した範囲を更新中',
  'insights.unavailable.title': 'インサイトを利用できません',
  'insights.unavailable.description':
    'ページを再読み込みしてください。問題が続く場合は、期間を変更し、分析データが利用できることを確認してください。',
  'insights.empty.title': 'この期間に実行はありません',
  'insights.empty.description':
    'テストを実行または再実行すると、インサイトにデータが表示されます。以前のデータがあるはずの場合は、「30日」または「全期間」に切り替えてください。',
  'insights.empty.action': '「実行」を開く',
  'insights.refreshFailed.window':
    '最新の更新に失敗しました。代わりに、前に選択した期間を表示しています。',
  'insights.refreshFailed.range':
    '最新の更新に失敗しました。代わりに、前に選択した範囲を表示しています。',
  'insights.metric.totalRuns': '実行の合計',
  'insights.metric.runsPerDay.window_other': 'この期間の稼働日あたり{{count}}件の実行。',
  'insights.metric.runsPerDay.range_other': 'この範囲の稼働日あたり{{count}}件の実行。',
  'insights.metric.scopedRunsPerDay.window_other':
    'この期間の稼働日あたり{{count}}件のスコープ内の実行。',
  'insights.metric.scopedRunsPerDay.range_other':
    'この範囲の稼働日あたり{{count}}件のスコープ内の実行。',
  'insights.metric.passRate': '成功率',
  'insights.metric.passedOutOf_other':
    '成功または失敗した{{decided}}件の実行のうち、{{count}}件が成功しました。',
  'insights.metric.scopedPassedOutOf_other':
    '成功または失敗した{{decided}}件のスコープ内の実行のうち、{{count}}件が成功しました。',
  'insights.metric.avgDuration': '平均所要時間',
  'insights.metric.avgDurationDescription': '選択した範囲で完了した実行の平均所要時間です。',
  'insights.metric.flakeRate': '不安定率',
  'insights.metric.flakeRateDescription_other':
    '失敗した実行は{{count}}件です。修復済みや不安定の挙動は別に集計しています。',
  'insights.passRate.title': '成功率',
  'insights.passRate.description': '選択した期間における成功の推移です。',
  'insights.duration.title': '所要時間',
  'insights.duration.description': '選択した期間における日ごとの平均実行時間です。',
  'insights.chart.passRate': '成功率',
  'insights.chart.duration': '所要時間',
  'insights.breakdown.test': 'テスト',
  'insights.breakdown.suite': 'スイート',
  'insights.breakdown.platform': 'プラットフォーム',
  'insights.breakdown.testTitle': 'テスト別の内訳',
  'insights.breakdown.suiteTitle': 'スイート別の内訳',
  'insights.breakdown.platformTitle': 'プラットフォーム別の内訳',
  'insights.breakdown.description':
    '期間全体の概要が変わらないよう、信頼性の比較はこの下のセクションで行います。',
  'insights.breakdown.refreshFailed': '比較を更新できませんでした。前の結果を表示しています。',
  'insights.breakdown.updating': '比較を更新中',
  'insights.breakdown.comparison': '{{label}}の比較',
  'insights.breakdown.breakDownBy': '内訳の基準',
  'insights.breakdown.unavailable.title': '内訳を利用できません',
  'insights.breakdown.unavailable.description':
    'ページを再読み込みするか別の期間を選んで、選択した比較を読み込み直してください。',
  'insights.breakdown.empty.test': 'この期間のテストのデータはありません',
  'insights.breakdown.empty.suite': 'この期間のスイートのデータはありません',
  'insights.breakdown.empty.platform': 'この期間のプラットフォームのデータはありません',
  'insights.breakdown.empty.description': '別の内訳を試すか、期間を広げてください。',
  'insights.breakdown.column.runs': '実行',
  'insights.breakdown.column.passed': '成功',
  'insights.breakdown.column.failed': '失敗',
  'insights.breakdown.column.passRate': '成功率',
  'insights.breakdown.column.flakeRate': '不安定率',
  'insights.breakdown.column.avgDuration': '平均所要時間',
  'insights.tokens.title': 'トークン使用量',
  'insights.tokens.description': '期間全体のモデルの使用状況です。内訳の選択には左右されません。',
  'insights.tokens.total': 'トークンの合計',
  'insights.tokens.input': '入力',
  'insights.tokens.output': '出力',
  'insights.tokens.tooltipTotal': '合計',
  'insights.tokens.byModel': 'モデル別',
  'insights.tokens.activeModels_other': '使用中の{{count}}個のモデルの入力と出力',
  'insights.tokens.testRuns': 'テストの実行',
  'insights.tokens.liveEditor': 'ライブエディター',
  'insights.tokens.notRecorded': '記録なし',
  'insights.tokens.unmeasuredSteps_other':
    'テスト実行の{{count}}個のステップにはトークン使用量が記録されておらず、集計に含まれていません。',
  'insights.tokens.empty.title': 'この期間のトークン使用量はありません',
  'insights.tokens.empty.description':
    'トークンの指標は、実行またはライブセッションでモデルが呼び出された後に表示されます。',
  'insights.memory.title': 'メモリキュレーター',
  'insights.memory.description':
    '選択した期間の実行について、キュレーションが記録したナレッジの変更です。',
  'insights.memory.reading': 'この期間のキュレーションの変更を読み込んでいます。',
  'insights.memory.noAgentHost':
    'キュレーションの変更を読み込めませんでした。このダッシュボードはエージェントホストなしで起動されています。',
  'insights.memory.unreadable':
    'この期間のキュレーションの変更を読み込めませんでした。ページを再読み込みしてもう一度お試しください。',
  'insights.memory.empty.title': 'この期間にメモリキュレーターの活動はありません',
  'insights.memory.empty.description':
    'メモリの指標は、実行によって観察が作成または確認された後に表示されます。',
  'insights.memory.truncated_other':
    'この期間の{{count}}件の実行のうち、最新の{{read}}件を集計しました。それより古い実行は読み込んでいません。',
  'insights.memory.runsUnreadable_other':
    '{{count}}件の実行のうち{{affected}}件のキュレーションを読み込めませんでした。その変更は集計に含まれていません。',
  'insights.memory.curationFailed_other':
    '{{count}}件の実行のうち{{affected}}件でキュレーションに失敗しました。その変更は集計に含まれていません。',
  'insights.memory.curationUnfinished_other':
    '{{count}}件の実行のうち{{affected}}件はキュレーションが完了していません。その変更はまだ集計に含まれていません。',
  'insights.memory.inFlight_other':
    'この期間の{{count}}件の実行はまだ完了しておらず、集計に含まれていません。',
  'insights.memory.changes': '変更',
  'insights.memory.runsRead': '読み込んだ実行',
  'insights.memory.runsReadValue': '{{total}}件中{{read}}件',
  'insights.memory.changeMix': '変更の内訳',
  'insights.memory.kind.added': '追加',
  'insights.memory.kind.confirmed': '確認',
  'insights.memory.kind.promoted': '昇格',
  'insights.memory.kind.superseded': '置換',
  'insights.memory.kind.deprecated': '廃止',
  'insights.memory.noChanges_other':
    'キュレーションが完了した{{count}}件の実行に変更は見つかりませんでした。',
  'insights.memory.noFinishedCuration':
    'この期間には、集計できる完了したキュレーションを持つ実行がありません。',
} satisfies Translation<typeof en>
