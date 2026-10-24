<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/banner-light.png">
  <img src="docs/assets/readme/banner-light.png" alt="vostride 出品的 agent-qa：能够持续改进的 AI 测试工具" width="100%">
</picture>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-qa"><img src="https://img.shields.io/npm/v/agent-qa?color=196872" alt="npm 版本"></a>
  <a href="https://github.com/vostride/agent-qa/actions/workflows/ci.yml"><img src="https://github.com/vostride/agent-qa/actions/workflows/ci.yml/badge.svg?branch=main" alt="持续集成"></a>
  <a href="https://vostride.com/docs/agent-qa"><img src="https://img.shields.io/badge/docs-agent--qa-196872" alt="文档"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-196872" alt="许可证：FSL-1.1-ALv2"></a>
</p>

**有记忆的 AI 测试工程师。** 用自然语言描述用户流程，agent-qa 会在 Web、Android 或 iOS 上执行测试并保留证据。你可以使用命令行、仪表板，也可以让编程助手通过 MCP 和技能调用它。

- **memidex 记忆：** 将学到的事实和可复用流程保存为仓库中的文件，方便审查。
- **持续改进：** 验证测试中学到的经验，淘汰过时知识，并根据你的反馈纠正错误。

| 基准测试 | 已公布的成绩 |
| --- | --- |
| [AndroidWorld](https://vostride.com/benchmark/android-world) | **100% pass@1**（116/116 项任务） |
| [AppControlBench](https://vostride.com/benchmark/app-control-bench) | **99.6% 完成度**（114.5/115 分） |

基准报告附有运行证据和测试方法。两项测试均使用 gpt-6-sol，并关闭了记忆和自我改进功能；AppControlBench 对部分完成的任务计半分。

## 实际运行效果

**查看失败原因。** 演示发现购物车将应为 $53 的总价显示成了 $29。失败步骤与对应截图并排呈现。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/evidence-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/evidence-light.png">
  <img src="docs/assets/readme/evidence-light.png" alt="仪表板展示故意设置的购物车总价错误、失败断言和浏览器截图" width="100%">
</picture>

**了解记忆如何参与测试。** 查看本次运行获得了哪些知识，以及哪些步骤使用了它们。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/knowledge-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/knowledge-light.png">
  <img src="docs/assets/readme/knowledge-light.png" alt="Knowledge 标签页展示为本次演示检索到的已存储知识" width="100%">
</picture>

**从终端运行。** 演示测试套件的真实输出：结账流程通过，故意设置的总价错误被检测出来。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/cli-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/cli-light.png">
  <img src="docs/assets/readme/cli-light.png" alt="命令行输出节选：一项测试通过，一项失败，九个步骤中有八个通过" width="100%">
</picture>

## 开始使用

需要 Node.js 24 或更新版本。

```sh
npm install -D agent-qa
npx agent-qa init
```

按照[快速入门](https://vostride.com/docs/agent-qa/quickstart)连接模型并运行演示，也可以[交给编程助手完成设置](https://vostride.com/docs/agent-qa/agent-quickstart)。

> [!NOTE]
> 项目仍处于早期阶段，可能会遇到 bug。遇到问题时，欢迎[提交 issue](https://github.com/vostride/agent-qa/issues)。

## 许可证

[Functional Source License（FSL-1.1-ALv2）](LICENSE.md)。
