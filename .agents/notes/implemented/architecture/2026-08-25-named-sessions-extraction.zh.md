# Agent Note: 把 named-sessions 从 headless 中抽取出来

Status: implemented

[English](2026-08-25-named-sessions-extraction.md) | 中文

**Date:** 2026-08-25 · **Packages:** `@deepseek-ai/dsh-named-sessions`（新增）、`@deepseek-ai/dsh-headless` · **Kind:** architecture

**取代了** [2026-08-25-headless-named-sessions.md](2026-08-25-headless-named-sessions.md) **中描述的包内放置方式**：派生逻辑与锁约定本身没有变化；变的只是它们的归属（那份笔记中"位于 packages/bundle/headless 内部"的放置方式，现在变成了这里的一个共享包）。

## Problem

命名会话的基元——文法校验、id 派生、带陈旧 pid 接管的按名锁，以及 id 到锁路径的代数——过去只存在于 headless bundle 自己的 `src/named-session.ts` 内部，私有于该包。当 headless 是该基元的唯一消费方时，这已经够用；但 mailbox 桥接（当时正在设计）需要冷恢复休眠的命名会话，并通过同一个锁文件把自己排除在存活的 headless 运行器之外，这意味着现在有第二个消费方需要计算出完全相同的派生 id、抵达完全相同的锁路径。在第二个包里再实现一遍派生逻辑，会有让两处 token 计算悄悄产生分歧的风险，因为一旦首次写入完成，此后就再也没有任何东西会重新比对这个名字——这正是单向哈希会掩盖的那类分歧。

## Decision

命名会话的基元——文法校验、id 派生（`named-` + 32 位十六进制 SHA-256 token）、带陈旧 pid 接管的按名锁，以及 id 到锁路径的代数——原样从 headless bundle 自己的 `src/named-session.ts` 搬到了新的工具包 `@deepseek-ai/dsh-named-sessions` 中。id/锁关系不变量也随之搬迁；headless 现在携带一个有正当理由的空 invariant companion。headless 依赖这个新包，其行为不变：相同的派生 id、相同位于 `headless/locks/<token>.lock` 的锁文件、相同的失败信息。

## 为什么现在抽取

mailbox 桥接（正在设计）会冷恢复休眠的命名会话，并且必须通过**同一个**锁文件把自己排除在存活的运行器之外。在两个消费方里各自复制一份派生逻辑，会让两处 token 计算发生分歧——这正是单向哈希会掩盖的那类静默分歧，因为首次写入之后就再也没有东西会重新比对这个名字。只有一个所有者，才能让锁文件位置与文法在唯一一处地方成为承重约束。

## `maxAgeMs` 接管界限

`acquireNamedSessionLock(name, { maxAgeMs })` 新增了一条接管路径：一个可证明仍然存活、但其记录的 `createdAt` 早于该界限的持有者，会失去该文件。默认（缺省）情况下完全保持已发布的语义——pid 存活性是唯一的接管路径。即便设置了该界限，一个负载中缺少可读时间戳的存活持有者仍然会被拒绝：年龄无法被证明，因此保守的判断胜出。这为桥接的延迟投递循环提供了一个有界等待的退出口，同时不削弱 runner 的互斥性。

## Required verification

- 迁移后的测试套件（`packages/session/named-sessions/tests/named-session.spec.ts`）覆盖派生、文法、获取/释放、陈旧 pid 与撕裂文件的接管、真实 OS 存活探测，以及三个新的 `maxAgeMs` 场景（老化接管、年轻拒绝、无时间戳拒绝）。
- headless 的单元测试与真实组合测试套件针对该包导入原样通过。
- 迁移后的 invariant 在已宣告的命名 id 缺少对应持有锁时，仍然响亮失败。

## Alternatives considered

- **把基元留在 headless 内、从 bundle 里导入**：反转了依赖方向——bundle 组合各个包，工具包绝不能依赖 bundle。
- **把基元并入 `dsh-home-paths` 或其他工具包**：把互斥语义混入一个不相关的归属地；锁代数值得拥有自己的 invariant companion。

## Consequences

headless 现在对 `@deepseek-ai/dsh-named-sessions` 有了一个新依赖，并且现在携带一个有正当理由的空 invariant companion，而不是自己直接拥有 id/锁关系不变量。任何未来的消费方——包括 mailbox 桥接——只要依赖这个包而不是重新实现它，就能获得完全相同的派生与锁行为，这正是这次搬迁的意义所在；但这也意味着派生算法与锁文件路径（`headless/locks/<token>.lock`）现在是一份共享约定：改动其中任何一个，如今都会一次性影响每一个消费方，而不再是孤立地影响一个包。新的 `maxAgeMs` 接管界限随同这次改动一起发布，对每一个消费方都可用，而不仅仅是促成它的那一个；headless 自己的锁行为之所以保持不变，只是因为它没有传入这个选项。
