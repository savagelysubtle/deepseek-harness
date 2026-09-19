# @deepseek-ai/dsh-session-turn-status

[English](README.md) | 中文

注册 `turnStatus` projection 单元的函数插件：将 `turn/start`/`turn/end` 边界纯折叠为——会话最近一轮是否仍处于开启状态，以及在不再开启时，最近一次是被何种原因关闭的：用户主动停止、程序化取消（及其子原因）、崩溃恢复后的中断、错误、正常完成，或少数更细的结果。经 session-projection 缝对外提供（registry 快照、变更流，以及每一个 projection 载体：history 尾页、`session/projection` 推送帧、会话列表行），使会话列表行与未来的看门狗无需重放日志，即可读出这一区分——这正是本包（SWD-120）要彻底解决的问题。

## 折叠语义

- `open` 从 `turn/start` 起为 `true`，直到匹配的 `turn/end` 出现为止。这是承重位：若进程在轮次中途崩溃，会留下一条没有 `turn/end` 匹配的 `turn/start`，直到会话下次加载为止（崩溃恢复在加载时运行，见 `dsh-session` 的 `interruptedTurnClosers`，而非崩溃发生时），因此一个已崩溃但尚未重新加载的会话在此处折叠为 `open: true`——与正在执行的轮次形状相同。本单元如实报告日志所载内容；真正区分二者的是会话列表行自身独立的 `running` 位（agent 是否已挂载）。`open: true` 且 `running: false` 就是崩溃信号——调用方必须同时读取这两个字段。
- `cause` 在会话首个轮次关闭之前为 `null`；并且——刻意地——在 `open` 为 `true` 期间也为 `null`：绝不能让前一轮的原因被误读为描述尚未结束的这一轮。
- `cause.kind === 'aborted'` 涵盖所有取消情形，`cause.cause.kind` 指明是谁取消的：`'user'` 表示用户主动停止；`'parent'`/`'hook'`/`'disposed'`/`'legacy'` 表示各类程序化取消，与持久化的 `TurnEndCancelCause` 一一对应。
- `cause.kind === 'interrupted'` 表示某轮是被崩溃恢复的重新加载事后关闭的；崩溃前记录的事件保持完整，只有边界是合成的。
- 本单元尚不认识的分支（`TurnEndReasonMap` 是可合并扩展的）会退化为 `cause.kind === 'other'` 而不会抛出异常，这与 `dsh-session-query` 对未知轮次结束原因已经采用的容错规则一致。

## 组合

```yaml
- id: session-turn-status
  name: '@deepseek-ai/dsh-session-turn-status'
```

注入 `sessionProjections`——这是插件的全部用途；在没有 registry 的装配中 fiber 保持挂起，不注册任何内容。

## 模型体验

无，因为插件只计算面向客户端的读模型——会话最近一轮是否仍在进行，若不在进行，是停止、崩溃、出错还是完成——均来自已写入日志的会话事件，不触碰任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；插件从不组装或发送提供方请求。

## 已知局限与延后工作

- **已崩溃的会话在重新加载之前报告的是 `open: true`，而非 `interrupted`**——崩溃恢复在加载时运行（`dsh-session` 的 `interruptedTurnClosers`），因此在崩溃发生到下次加载之间，本单元自身无法区分“仍在执行”与“因进程已死而被遗弃”；调用方必须交叉核对会话列表行的 `running` 位（或等效的存活事实）才能分辨两者。这是如实折叠日志的既定后果，而非需要在此修复的缺陷。
- **`cause` 只反映最近一次关闭的轮次**——更早轮次的原因不予保留；需要完整历史的调用方应直接读取日志。
- **冷会话需要装配 `dsh-session-projection-cache` 才能在不读日志的情况下提供该键**——只装配了 registry 而未装配缓存的组合，对已挂载会话仍能正确折叠；但冷会话在 `session.list` 中的 projection 列在同时装配该缓存之前将保持缺席。
