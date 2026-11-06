# @deepseek-ai/dsh-agent-claude-code-registry

[English](README.md) | 中文

[Claude Code 席位驱动](../agent-claude-code-driver/README.md)的**注册表胶水包**。它把两个互不相识的包连接起来:邮箱桥(掌握组织注册表的唯一视图,并在每次投递时传入冻结的席位绑定)与驱动(掌握 Agent SDK、主机私有的席位条目和邮件准入接缝)。它没有配置、不保存状态,只需要 agent 注册表(`inject = ['agents']`)。

它在上下文上提供两样东西:

- **`ctx.claudeCodeSeatSource`。** 驱动遇到静态配置中没有的席位时调用。它接收邮箱桥放在 `agentOptions.seatBinding` 中的绑定(`{seat, rowHash, row}`),重新计算条目的哈希,与邮箱桥当前条目的哈希(`ctx.mailboxSeatRows.current(seat)`,只返回条目哈希、驱动和两个准入列表,不含 cwd、会话 id 或工具)比较,只有两者一致才返回 `{seat, row}`。它拒绝:没有绑定的请求(因此 api-proxy 和其他任何调用方都无法打开 Claude Code 席位)、缺少 `mailboxSeatRows` 服务、条目与自身哈希不符的绑定(伪造)、过期的绑定(邮箱桥绑定之后注册表条目已变化)、邮箱桥没有有效条目的席位,以及没有选择 `driver: claude-code` 的条目。
- **`ctx.claudeCodeMailHooks = { admit }`。** 驱动对每次 send 和 steer 运行 `admit`。它通过邮箱桥使用的同一个纯函数(`dsh-mailbox` 中的 `admitsMail`)应用条目的 `admit_from`(席位接受其邮件的席位;为空表示无人)与 `admit_sender_classes`。它失败即关闭:没有条目服务、未知席位、未标明发送者的邮件,或注册表没有对应名称的跳类别,一律拒绝。该对象**没有 `lease` 属性**:邮箱租约接收端属于后续切片,在此之前驱动保留自己的租约处理。

## 注册表条目能做什么、不能做什么

注册表条目是不受信任的请求:它只指明驱动以及谁可以给席位发邮件,别无其他。模型、effort、限额、`claude_path`、其 sha256、`fable_ok`、工作目录固定值和最宽的发送者列表,都是驱动 profile 行中 `hostSeats` 下的**主机条目**,由创始人拥有,任何席位都无法写入。胶水包从不读取主机配置。能编辑注册表的人可以让某个席位拒绝服务、缩小它的发送者列表,或切换它的驱动(邮箱桥会拒绝在带有另一驱动历史的日志上切换)。他们无法选择二进制文件、启用 fable 模型、更改模型、限额或工作目录,也无法把 `admit_from` 扩大到创始人的 `admit_from_ceiling` 之外。

```yaml
# profile cordis.patch.yml: two rows, two owners
- insert:
    - id: agent-claude-code-driver            # host config, founder-owned
      name: '@deepseek-ai/dsh-agent-claude-code-driver'
      config:
        stateDir: claude-code
        claudePathPrefixes: [/home/me/.local/share/claude/versions]
        hostSeats:
          mail-triage:
            model: haiku
            role: mail-only
            claude_path: /home/me/.local/share/claude/versions/2.1.317/claude
            cwd: /home/me/work/mail-triage
            admit_from_ceiling: [ops-lead]
    - id: agent-claude-code-registry          # this package: no config
      name: '@deepseek-ai/dsh-agent-claude-code-registry'
```

带有全部可选字段注释的完整示例是 [`tests/fixtures/profile.cordis.patch.yml`](tests/fixtures/profile.cordis.patch.yml);一个规格会解析它并用驱动自己的 `Config` 模式校验。同一席位的注册表条目写明 `driver: claude-code`、`admit_from` 列表和类别。两者可按任意顺序挂载(驱动与胶水包彼此惰性读取),并且席位要打开还必须挂载邮箱桥。

## 谁可以给 Claude Code 席位发邮件

通俗地说:Claude Code 席位只接受其条目在 `admit_from` 中列出的席位发来的邮件,并且只接受其条目在 `admit_sender_classes` 中列出的类别。两个列表默认都是无人。

- `dsh-mailbox send --from steve` 属于 `unverified` 类别:steve 不是名册中的席位,传输层会加上 `guest:` 前缀。Claude Code 席位会拒绝它,除非条目列出 `unverified` 并写明该发送者,而雇用脚本只在测试席位上允许这样做。
- `seat` 类别的意思是"名册中的任何席位",而不是"可信"。邮箱桥对其服务的每个地址都放行访客邮件,因此每个默认循环的被服务席位都算作对外暴露。代码只检查条目的列表落在创始人的 `admit_from_ceiling` 之内;该上限是创始人对这些席位无法从外部到达的担保。
- 邮箱桥自己的准入是发送者看到的裁决。本包的 `admit` 是它背后的纵深防御,针对绕过邮箱桥直接到达驱动的调用方。

## 测试

`tests/source.spec.ts`(验证来源)、`tests/admit.spec.ts`(允许与拒绝矩阵)、`tests/composition.spec.ts`(胶水包、真实驱动和伪造的邮箱桥,覆盖全部六种挂载顺序)与 `tests/fixture.spec.ts`(示例 profile)。邮箱桥被替换为只提供条目服务的伪造品;SDK 和 `claude` 二进制文件从不启动。

## Known Limitations and Deferred Work

- **邮箱租约尚未接入** — `claudeCodeMailHooks` 不带 `lease`,因此被拒绝或暂停的席位的邮件会排队,而邮箱桥已把它记为已投递;发送者看到的是已投递。邮箱租约接收端(切片 S8)将解决这一点。
- **主机条目检查是延迟的警告** — 注册表在挂载之后才加载,条目服务无法区分"尚未加载"与"不存在",因此没有注册表条目的主机条目只在挂载后不久报告一次,而不是在挂载的瞬间。
- **只支持 `mail-only` 席位** — 在权限切片(S5)落地之前,主机条目中的任何其他角色都会被拒绝。
