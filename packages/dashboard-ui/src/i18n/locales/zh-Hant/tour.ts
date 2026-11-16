import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': '歡迎使用 agent-qa',
  'tour.intro.body':
    'agent-qa 讓您以自然語言撰寫網頁與行動裝置的測試。它會透過嚴謹的 QA 執行框架執行測試、從過去的執行中學習、在 UI 變更時自動調整，並讓您清楚看到實際發生的一切。',
  'tour.llmSetup.title': '請先設定您的 LLM',
  'tour.runs.title': '執行會顯示結果',
  'tour.runs.body': '「執行」會顯示每一次 agent-qa 執行的結果、產出檔案與推理過程。',
  'tour.tests.title': '測試是以自然語言撰寫的檢查',
  'tour.tests.body':
    '測試是以自然語言撰寫的檢查，agent-qa 可以針對您設定的網頁或行動裝置目標執行。',
  'tour.suites.title': '套件組合出可重複執行的工作流程',
  'tour.suites.body': '當一個測試不夠用時，套件可以把相關的檢查組合成可重複執行的工作流程。',
  'tour.hooks.title': '掛鉤在步驟前後與步驟之間執行',
  'tour.hooks.body': '掛鉤可以在測試或套件前後負責準備與清理工作，也可以在步驟之間以內嵌方式執行。',
  'tour.config.title': '設定控制本機環境',
  'tour.config.body': '「設定」控制 agent-qa 在本機使用的模型、目標、執行環境與儀表板設定。',
  'tour.exampleTest.title': '執行預期會通過的範例測試',
  'tour.exampleTest.body':
    '這個自動產生的測試最適合作為第一次執行，因為 init 建立它就是為了驗證您的設定。',
  'tour.exampleMissing.title': '找到預期會通過的範例測試',
  'tour.exampleMissing.body':
    'agent-qa init 通常會建立一個預期會通過的範例測試。有這個測試時，請從「測試」中選取它，或稍後再自行建立一個。',
  'tour.runAction.title': '準備好後點擊「執行」',
  'tour.runAction.body': '準備好後請點擊「執行」。導覽會從執行畫面或「執行」頁面繼續。',
  'tour.liveRun.title': '即時觀看執行',
  'tour.liveRun.body': '即時模式會顯示正在執行的測試：一側是測試步驟，旁邊則是瀏覽器畫面。',
  'tour.runDetail.title': '檢查執行詳細資料',
  'tour.runDetail.body': '這就是最有價值的時刻：檢查 agent-qa 觀察、規劃、執行與驗證了哪些內容。',
  'tour.githubNudge.title': '如果 agent-qa 對您有幫助',
  'tour.githubNudge.body': '如果 agent-qa 對您有幫助，歡迎在 GitHub 上為它加上星號。',
  'tour.githubNudge.actionLabel': '在 GitHub 上查看',
  'tour.runsFallback.title': '開啟最新的執行',
  'tour.runsFallback.body':
    '如果這裡還沒有開啟任何執行，請使用「執行」頁面開啟最新的執行並檢查詳細資料檢視。',
  'tour.ui.progress': '導覽進度：第 {{current}} 步，共 {{total}} 步',
  'tour.ui.skip': '略過',
  'tour.ui.restart': '重新開始',
  'tour.ui.back': '上一步',
  'tour.ui.done': '完成',
  'tour.ui.startTour': '開始導覽',
} satisfies Translation<typeof en>
