---
layout: home

hero:
  name: dsh-agent-studio
  text: Agent 中心
  tagline: 把 Agent 的提示词、工具、可见技能变成可视化配置——预设级拼装，子代理也能单独定制
  actions:
    - theme: brand
      text: 快速上手
      link: /install
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/thissensen/dsh-agent-studio

features:
  - title: 提示词收窄
    details: 按 agent 编一份段清单，名单之外的段不进上下文。系统提示词不再越堆越长。
  - title: 工具收窄
    details: 挑出这个 agent 要用的工具，其余收起来。同类工具不再挤爆工具目录。
  - title: 技能可见性
    details: 勾哪些 skill 就暴露哪些，不勾的模型看不见；你仍能在输入框手调。
  - title: 子代理定制
    details: 每个子代理独立配模型、提示词、工具、技能与后台模式，不再整套继承主代理。
  - title: 运行时快照开关
    details: 代理级开关，关掉官方按 step 动态注入的运行时环境快照。
  - title: 配置在自己手里
    details: 配置全部存在插件自己的数据里，装配期生效；卸载即恢复原状。
---

## 这是什么

dsh-agent-studio 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的图形化插件。

模型每一轮看到的东西就三份：系统提示词、工具目录、技能目录。随着插件与 MCP 越装越多，这三份只会越来越大，拖累模型表现；而 DSH 目前给子代理的配置又极其简陋。

本插件把 Agent 拆成可随意拼装的积木：提示词、工具、技能、模型拼成完整 Agent，子代理同样能高度定制；预设可以随手新建；兼容官方 PTC 模式。
