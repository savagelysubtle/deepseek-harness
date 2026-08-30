# Agent Note: 邮件拒绝在发送方会话中记录耐久通知

Status: implemented

[English](2026-08-29-mail-refusal-durable-sender-notice.md) | 中文

## 问题

对发送方而言，一次邮箱准入拒绝是一道无声的栅栏。桥把接收方行落定 `failed`、向宿主日志发出警告、并发出 `mailbox/refused` 事件；宿主的 apiproxy 把该事件转成寻址到发送方会话的 `host/agent-error` 线路帧。但那帧实际上不可见，而且这已在真实浏览器测试中被证实：从 `tt-ping` 发往 `t2-loner` 的一次被拒发送，其数据库行带着准确原因落定 `failed`，而发送方的会话在随后的 2.5 分钟里什么都没显示。两个客户端事实解释了它。manager 的 `host/agent-error` 处理是 `this.sessions.get(frame.sessionId)?.handleAgentError(...)`——当发送方的会话对象不在客户端驻留时，`?.` 把帧悄悄丢弃——而 `handleAgentError` 写入 `lastAgentError`，一个单槽瞬态字段：不是对话节点、重载后不留存、也不会标记侧栏。这条通道对同步失败（持久化栅栏，在用户正看着时触发）是对的，对像邮件拒绝这样的异步失败则是错的——它触发时无人在场。

## 决策

桥把拒绝作为耐久上下文节点记录进发送方（SENDER）自己的会话，与既有的线路帧并存（而非取代），后者继续作为实时提示条。`injectRefusalNotice` 在落定行、发出事件的同一次 `refuse` 调用内运行，追加一条 `user/message`，其合并来源是新的 `MailboxRefusalSource`——`kind: 'mailbox'`、`form: 'notice'`，携带 `refusedTo`（尝试的接收方）、`messageId`（把通知系回该次发送）、`reason`（逐字）、以及有界的 `summary`。`MailboxMessageSource` 变为它与既有中继来源的联合，以 `form` 判别。

**刻意不带 `from`。** 客户端的 `mailboxRelay()` 以 `kind === 'mailbox'` 加可读 `from` 为键；盖上 `from` 就会把拒绝渲染成一张来信卡片。拒绝是宿主对发送方自身行为的报告，不是来自被拒接收方的书信，因此通知不带发送方字段，绝不读作邮件。

**结构性地无循环。** 通知绝不进入邮件存储——它被直接追加进会话日志——因此任何准入规则，包括刚触发的那条，都永远无法裁决它。没有认领、没有拒绝、没有再排水。代码库里既有的对照物恰好说明了这个区别的分量：准入后的失败经存储发布 `bounce`，这之所以安全，是因为 bounce 在失败方向上不受准入裁决——但拒绝的成因本身就是一条准入规则，所以一笔被存储的 bounce 会被它所报告的那条规则再次拒绝。注入失败同样被 containment：`injectRefusalNotice` 内的每条路径都改为警告而不抛出，因为从 `refuse` 抛出会把租约交给排水的通用失败处理器，而它发布 bounce——重新引入环形路由。

**不打断。** 通知绝不触碰 agent 收件箱：没有 `steer`、没有 `followup`、没有唤醒式 `send`。发送方通常正处于回合中——它刚刚调用了发送工具——而一次由拒绝引发的唤醒投递会让座位打断它自己。对驻留的发送方，追加落进日志，运行中的驱动从它本来就要发起的请求历史里读到它；对休眠的发送方，桥取投递所用的同一把按会话驻留锁，恢复 agent、追加、flush 落盘、注销，全程不驱动任何回合，也绝不创建会话——从未运行过的发送方，如同 `guest:` 发送方，没有任何通知途径（CLI 通道报告自己的结果）。

**呈现。** 客户端用 `mailboxRefusal()` 读取通知（接收方与理由二者必需——带着谜团的自信卡片还不如通用行），并渲染一张专用拒绝卡片：邮件卡片的几何，但以警告图标与错误色强调取代邮件图标与商务蓝。默认收起（拒绝不打断任何事，不同于阻塞邮件），收起状态下保持接收方与理由可见，并以 `data-context-mail-refusal` 作为稳定的浏览器测试钩子。缺少接收方或理由的来源落到通用 `notice` 呈现，绝不空白。

## 备选方案

**把拒绝经存储弹回。** 断然否决——环形正是最初的设计约束：bounce 本身受拒绝原始邮件的那条规则约束，会被再次拒绝，发送方只会看到沉默。这是对[创始人模型与退信记录](../architecture/2026-08-26-mailbox-founder-model-and-bounces.md)的一次刻意收窄：其“每个终态失败都 bounce”对准入之后的失败（路由、唤醒、供给）成立，而一次准入拒绝——其成因本身就是准入规则——改为经 `mailbox/refused` 上下文总线报告并记录这条耐久通知，而不是存储 bounce。

**用 `followup` 唤醒发送方送达通知。** 否决：拒绝绝不能开启回合。发送方可能在回合中；由拒绝引发的唤醒投递正是自打断回路的形状。

**复用 `agent.inject()`（非唤醒收件箱通道）。** 否决，作为耐久出口不合适：注入上下文是瞬态的——只在更晚的 step 边界被认领、被取消或注销丢弃——拒绝恰恰会在发送方安静下来时丢失。它适合面向模型的叙述，不适合耐久记录。

**只修客户端帧（`host/agent-error`）。** 否决，不充分：让错误在会话对象恰好驻留时显现，仍然是瞬态、不入列、不可重载的。帧保留其实时提示价值；耐久节点才是真正的出口。

## 后果

每次被拒的发送现在留下三条耐久痕迹：接收方的 failed 行、上下文事件、以及发送方日志里的通知——外加实时帧。发送方的模型会看到拒绝（日志追加进入派生历史），因此不会抱着成功的期待原样重发。当发送方的注册表条目无法解析（注册表损坏）时，拒绝降级为行与事件——通知按设计是尽力而为，其失败绝不掩盖拒绝本身。

## 验证

- `packages/mailbox/bridge/tests/bridge.spec.ts`——活发送方通知（精确来源、无 `from`、无唤醒、恰一次拒绝事件、无存储行）、休眠发送方的恢复/追加/flush/注销且不供给、guest 与不可解析发送方跳过、守卫拒绝（`duplicate-suppressed`）同样被通知。
- `packages/mailbox/bridge/tests/composition.spec.ts`——真实 Loader 树：warmup 落定发送方日志，无边的座位对座位发送被拒，磁盘上发送方的 JSONL 日志包含带存储 id 且无 `from` 的 `notice` 来源。
- `packages/client/runtime/tests/context-provenance.client.spec.ts`——`mailboxRefusal()` 的读取、降级，以及绝不匹配中继形式。
- `packages/client/ui-conversation/tests/mail-refusal-row.client.spec.tsx`——拒绝卡片的渲染（中继来源仍渲染邮件卡片；缺字段的来源降级为通用行）。
