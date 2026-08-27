# Agent Note: 机器所有者的唤醒预算与响亮收尾轮

状态：已实现

[English](2026-08-26-machine-owner-wake-budget.md) | 中文

## 问题

`tool-jobs` 用 `maxConsecutiveWakes`（默认 3）约束自激的唤醒链，且只有所有者领取用户撰写的消息才会重置。对受托派的 subagent child 而言这一预算两次走形：委派时其审批策略被固定为 `'never'`（`dsh-subagent` 的 `captureDelegatedPolicyOverrides`），永远无法向人求助；而其 inbox 几乎只装插件通知——这类通知刻意不回补预算。越过预算后，完成通知降级为注入，注入不会开启轮次：停滞的 child 与自己已完成的工作无声地搁浅在一起（见 `interagentstuff/plans/background-lifetime-findings-2026-08-26.md` §2.1）。

## 决策

以持久 header 为键的两类语义（`SessionHeader.origin === 'subagent'`）：

- 交互式所有者：不变——`maxConsecutiveWakes`（3），静默降级为注入。
- 机器所有者：新增经校验的 `Config.machineOwnerWakeBudget`（默认 16，同样的整数纪律；仍拒绝 `Infinity`，因为守卫必须设界而非消失），耗尽时恰好一轮**收尾轮**：走唤醒通道指示 child 用 memory 工具持久化状态并保持安静，此后通知改为注入、不再开启轮次。用户撰写的领取同时重置预算与收尾，故每个输入纪元至多 K+1 个被唤醒轮次——活性守卫被替换为响亮的上限，而非移除。

收尾指名 memory 工具，因为 child 的暂存区只存在于其会话中；持久化才是日后任何人来戳一下都能生效的前提。

## 备选方案

- 机器所有者无限唤醒——否决：自激唤醒链仍需设界，只是边界形状与人类所有者不同。
- 纯粹按所有者的策略旋钮、不区分类别——作为主机制予以否决：每个部署都必须知道去配置它，否则静默重现停滞；来源分类持久化在 header 中，零配置。该旋钮仍然存在（`machineOwnerWakeBudget`），供想要不同上限的部署使用。
- 任何被领取的消息（包括插件通知）都回补预算——否决：这恰恰删除了阻止 wake/start/complete 循环的那道界限。

## 后果

- 交互式会话零行为变化；既有快照夹具保持不变。
- 受托派 child 在长后台任务链上保持存活，同时每纪元仍有界。
- 配置面增加一个键，已写入两份 README 的配置表。

## 必要验证

`tool-jobs.spec.ts` 的无密钥单元通道：机器预算唤醒序列、收尾内容、纪元重置，以及交互式所有者的回归钉（静默降级、无 memory 工具文案）。
