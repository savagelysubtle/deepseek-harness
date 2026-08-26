[English](2026-08-26-mailbox-bridge-delivery.md) | 中文

# Agent Note：邮箱桥——派生会话身份上的 steer 优先投递

Status: implemented

## 问题

接缝与 SQLite 存储落地之后，队列中的邮件仍无法到达 agent：必须有角色把 `<namespace>:<name>` 解析到存活或休眠的会话，跨进程诚实地判定驻留，并把投递渲染为归属发送方的转录可见内容。opencode 先例通过直接向持有会话的进程注入来投递，这要么构成外部权限的 steering，要么在持有者死亡后排入虚空——驻留规则正是为了阻止这些失败模式而存在。

## 决策

`@deepseek-ai/dsh-mailbox-bridge` 是一个轮询函数插件，它的全部排他性叙事都是借用而非发明：

- 路由不加第二套编码。经文法校验的地址名称段就是会话名，`deriveNamedSessionId` 直接产出目标 id。花名册是显式配置；目录发现（`discoverPending`）等待 Service Definition 刻意尚未提供的提供方枚举表面。
- 按 Steve 指令，唤醒延迟优先：存活的 agent 先被 STEER 进运行中的回合，边界拒绝时才降级为 `followup()`。刚冷恢复的 agent 则把邮件作为排队 FIFO 回合接收——steer 会跳过先前上下文的重建。
- 驻留完全沿用具名会话的 pid 存活锁，`lockStaleMs` 作为可选的有界接管逃生口（`maxAgeMs`），供楔死的持有者需要。获取失败立即落定 `pending`——“驻留他处”的推迟绝不消耗任何过期窗口。持久化日志缺失 → `failed 'unknown-address'`，日后成为 SeatRegistry 的铸造门禁绊线。`done` 在准入即落定（静默之前），因为准入语义不得依赖被投递回合之后的运行时长。
- 投递渲染收敛在一个共享模块中，headless runner 复用它，使运行启动时的排水与中途排水产出逐字节一致的回合：subject + payload 文本置于合并的 `{ kind: 'mailbox', form: 'relay' }` 来源之下。headless 侧以 `--mailbox-namespace` 暴露，在任务之前排出固定界限的积压，使任务保持最后一回合的最后一条消息。

否决项：经 session 内部结构或合成事件推送投递（违反 model-visible ⟺ logged）；按地址路由提供方与推送通知（尚无第二个消费者）；让轮询计时器钉住宿主（unref 的排水循环意味着邮箱部署须依靠自己真正的长生命周期句柄维生）。

## 验证

单元套件以真实的注册表 + SQLite 提供方加桩驻留服务覆盖 spec 校验、渲染边界与每种路由结局（存活空闲／运行中／steer 被拒、带锁释放证明的冷恢复、unknown-address、驻留被持时的推迟、毒消息隔离）。组合套件经真实 Loader 树启动且仅桩掉模型：两阶段流程证明休眠具名会话恢复并收到其邮件（含来源归属与存储 done 状态断言）， served-address hook 在单次出厂引导内把积压排到任务回前。

## 后果

命名 agent 在单机内成为端到端可投递目标：向 `<ns>:<name>` 发布邮件，下一个桥周期即诚实跨进程唤醒或排队接收者。unknown-address 失败为 Phase 2 的 SeatRegistry 提供了响亮的铸造治理绊线。崩溃窗口内的跨进程重复投递仍有可能（契约即至少一次）；除既有过期回收允许者外，桥不引入新的重复。
