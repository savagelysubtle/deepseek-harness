# @deepseek-ai/dsh-agent-claude-code-tools

[English](README.md) | 中文

[Claude Code 席位](../agent-claude-code-driver/README.md)的**权限策略核心**。它把主机私有的输入(主机席位的策略字段、工作目录、席位名;绝不使用注册表条目)转换成一个席位运行所依据的规则集:权限规则、第二层 `PreToolUse` 钩子,以及该钩子读取的文件。本包同时是以 `ctx.claudeCodePolicy` 向驱动提供它的 cordis 插件,并带有每个席位一个的 `dsh` MCP 工具服务器(`mailbox_send`、`mailbox_directory`);见下文。它实现的契约类型位于驱动中(`policy-contract.ts`)。

## 它生成什么

- **规则**(`generateRules`)。Claude Code 的路径规则是 gitignore 风格:`//abs` 表示绝对路径,`/abs` 表示相对于项目,因此这里每条规则都输出为 `//` 加上去掉开头斜杠的路径(例如 cwd 为 `/home/steve/x` 时是 `Read(//home/steve/x/**)`;绝不是 `///`,也不使用 `~/` 形式)。每个受保护目录同时生成裸路径条目和 `/**` 条目,因为 worktree 中的 `.git` 是一个文件。只有 `Read(...)` 和 `Edit(...)` 是真正的路径限定符(`Read` 覆盖 Grep 和 Glob;`Edit` 覆盖 Write、MultiEdit 和 NotebookEdit),所以不会生成 `Write(...)` 或 `Grep(...)` 规则。所有角色得到同一套拒绝集合:`~/.claude/**`、`~/.claude.json`、`~/.ssh/**`、`~/.config/gh/**`、`~/.dsh/**`、`~/.agents/**`,以及 cwd 内的 `.git/**`、`.claude/**`、`.mcp.json`、`.husky/**`。`coder` 还会得到针对 `//<cwd>/**` 的 `Read` 与 `Edit` 允许规则;`lead` 完全没有原生工具。
- **无法写入规则的 cwd 或 home 会被拒绝**(`UnsafePathError`):不是绝对路径或未规范化、是文件系统根、含有 `* ? [ ] ! # { } \ ( )` 中任一字符、空白或控制字符、与自身的 realpath 不相等、不是目录,或者(对 cwd 而言)位于受保护的 home 位置之内。
- **设置**(`generateSeatPolicy`):`{settings, allow, disallowedTools, tools, fences}`。其中 `settings` 含有守卫钩子和 `permissions.deny`,`allow` 含有 `mcp__dsh__<name>` 条目(coder 还含有 cwd 的 `Read`/`Edit` 规则),`fences` 重申 `dontAsk`、`settingSources: []`、`strictMcpConfig: true`。只应记录结果的 SHA-256(`settingsSha256`)。没有 `canUseTool`:在 `dontAsk` 下它从不会被调用,因此钩子就是第二层。
- **工具。** lead 模板恰好是 `mailbox_send` 和 `mailbox_directory`(即 `mcp__dsh__mailbox_send` 与 `mcp__dsh__mailbox_directory`)。主机席位的 `tools` 列表会裁剪模板;一个席位若没有任何工具,就抛出驱动契约中的 `SeatMutedByPolicyError`。后续切片通过 `ContributorRegistry.registerToolContributor` 与 `registerHookContributor` 追加名称和钩子组,无需修改本包。
- **就绪状态**(`ReadinessRegistry`)。策略服务一存在,`lead` 即可服务。只有提供 `sandbox`、`canary` 和 `rules-hooks` 的贡献者全部注册后,`coder` 才可服务;`missing` 列出缺少的项。

## dsh 工具服务器与 provider

本包同时是一个 cordis 插件(`name: agent-claude-code-tools`,配置 `policyDir`,可选 `home`、`nodePath`、`guardPath`、`allowedCwdRoots`)。挂载它会注册驱动在使用时读取的 `claudeCodePolicy` 服务,因此它可以先于或后于驱动挂载。每次查询(`extend`),provider 会:

1. 拒绝 `mail-only` 席位,以及就绪注册表无法服务的角色;
2. 固定席位的工作目录:设置了 `allowedCwdRoots` 时,不在任何根目录之内的 `cwd`(按完整路径段做字面比较,因此根目录必须是规范路径;空列表拒绝所有席位)会抛出错误;随后第一次查询确定 `cwd`,之后任何 `cwd` 哪怕只差一个字符的查询都会抛出错误;
3. 在写入任何内容之前,先对照工具模板和策略模板检查主机条目的 `tools`,并让席位静音(`SeatMutedByPolicyError`,列出所有缺失的名称);
4. 验证 node 二进制和守卫脚本(每次查询都重新检查),按席位、cwd 和主机字段只生成一次席位策略,策略文件缺失或在磁盘上被改动时原子地重写;写入失败会抛出错误,驱动让邮件继续排队;
5. 第一次见到某个 node、守卫、策略哈希组合时,对那条确切的钩子命令运行 `verifyGuardCommand`,失败即抛出,所以无法启动(会失效放行)的守卫永远拿不到服务器;
6. 返回 `{settings, mcpServers: {dsh}, allow}`,其中服务器是本次查询新建的。`allow` 恰好是每个暴露工具的 `mcp__dsh__<name>`(coder 还有 cwd 的 `Read`/`Edit` 规则),不含其他任何内容,因为 CLI 报告的工具列表与之不符时驱动会让该回合失败。自动记忆由驱动自己关闭,provider 不返回该设置。

服务器(`createSeatMcpServer`)是 SDK 的进程内服务器,名为 `dsh`,每个席位每次查询一个。每个工具都在各自的闭包上构建(席位自己的 agent id、`send_to`、`allow_blocking`、实时的污染与已投递 trace 控制),所以两个服务器永不共享状态。输入模式是严格的 zod 对象:未知键(`from`、`seat`、`tainted`、`chain` 或任何其他键)在处理函数运行之前就被 SDK 层拒绝,而不是被剥离。每个模式在构造时转换为 JSON Schema,结果必须是封闭对象;无法转换的模式在那时就抛出错误,而不是在调用时。工具返回的每个字符串都经过清洗器(去掉除换行和制表符以外的控制字符,操作员 home 或席位 cwd 下的任何路径替换为 `[path]`,长度上限 4000)。工具可以按调用收窄这一行为:`context.scrub(text, {scrubRoots, maxLength})`(以及 `textResult` 对应的第四个参数)接受由 `'home'` 和/或 `'cwd'` 组成的 `scrubRoots`(默认两者都有,即邮箱工具的行为;至少需要一个,空列表会抛出错误;bash 工具因为在真实 cwd 下运行而传入 `['home']`)和 `maxLength`(不超过 1 MiB 的正安全整数,否则抛出错误)。当 `'cwd'` 不在其中且 cwd 位于 home 之下时,cwd 内的路径保持原样(模型本来就知道自己的 cwd,把它隐去会破坏 home 下克隆的工具协同),home 下的其他路径仍被隐去。闭包还带有在构造时固定的席位 `cwd`,处理函数的第二个参数是 MCP 调用的中止信号。

**每个工具都必须声明污染属性。** 每个工具都必须带有 `taint: 'always' | 'never'`(缺失或不是这两个值时,`defineSeatTool` 和 `createSeatMcpServer` 会拒绝并指出工具名),`'never'` 工具还必须带有非空的 `taintReason`。`createSeatMcpServer` 是唯一调用处理函数的地方:对 `'always'` 工具,它在处理函数运行之前就把会话标记为被污染(`tool:<name>`),所以处理函数读取内容之后抛错或超时,会话仍然被污染。工具自己从不调用 `markTainted`。`tests/mcp/taint-registry.spec.ts` 以快照列出每个 `'never'` 工具及其理由(以及声明了它的源文件),新增一个会在差异中显现(通过对 `packages/*/*/src` 和 `apps/*/src` 的文本扫描找出声明了它的源文件;通过常量给出的污染属性会被标记为需要人工复查)。`neverTaintTools(server)` 返回服务器实际提供的 `'never'` 工具的 `name -> taintReason`,使快照可以针对完整注册表运行。“没有通往处理函数的路径”测试只是对导入本包的文件做的文本警戒线,不是证明:`SeatToolTemplate.build` 和 `SeatTool.handler` 是公开的,构建出工具的代码仍可直接调用其处理函数而跳过污染步骤。服务器还会在构造时只读取一次每个工具的 `taint` 和 `name`。

lead 模板恰好是 `mailbox_send` 和 `mailbox_directory`。主机条目的 `tools` 必须是它的子集(未知名称或空列表都会让席位静音)。不提供 `check_inbox`、`await` 和跟踪器工具:邮件由驱动投递,延迟结果机制属于 S6。S6 和 S7 通过在 `SeatToolTemplate` 上注册工厂、在 `ContributorRegistry` 上注册名称来追加工具,无需修改 S5 文件。

### `mailbox_send` 规则

- **(a) 身份。** `from` 是构造服务器时捕获的席位自己的邮箱 agent id。它从不从输入读取,也绝不是 Claude 会话 id。
- **(b) 目的地。** 消息只发给 `to`,且 `to` 必须在主机条目的 `send_to` 中。`send_to` 为空时,每次发送都被拒绝,理由中点名配置键 `send_to`。
- **(c) 回复标签。** 只有当 `replyToTraceId` 在驱动报告的已投递给该席位的 trace id 集合中时才被接受。它只是作为 trace id 复制到发出消息上的标签;绝不用于寻找目的地(没有 trace 查询,也没有基于 trace 的路由)。未知的 trace id 被拒绝。
- **(d) 阻塞。** 除非主机条目设置 `allow_blocking: true`,否则 `blocking: true` 被拒绝。
- **(e) 污染。** 来自被污染会话的发送带有 `tainted: true`,不带 `chain`:`from` 已经指明来源,桥接会自己把每一跳追加到 `chain`。**盖章只是给消息打标签,从不拒绝发送。** 未被污染的会话不作任何声明(缺省表示未声明,绝不表示干净)。两个邮箱工具都声明 `taint: 'never'`,因为它们只返回操作员配置的名称和 trace id;任何返回邮件正文或其他外部内容的工具都声明 `taint: 'always'`。
- **(f) 校验。** 消息通过邮箱服务发布(`ctx.mailbox.publish`,发送时才查找),由它执行邮箱发布校验。发布被拒绝时,以固定的错误结果返回给模型(邮箱自己的文字只写入主机日志),而不是抛出。
- **(g) 结果文本。** 简短、经过清洗,且只点名被发送的那个席位(`Sent to <to>. Trace id <id>.`)。

正文上限为 64 KiB 的 UTF-8(邮箱包自身没有声明上限,所以由本包设置)。一个服务器(一次查询)最多可发送 `MAX_SENDS_PER_TURN` = 20 条消息;第 21 条会被拒绝,拒绝原因点明该上限,被拒绝的发送不计入。

### 就绪状态

`lead` 除本插件外不需要任何东西。`coder` 需要提供 `sandbox`、`canary` 和 `rules-hooks` 的贡献者;`sandbox` 来自 S6 的 bash 插件,`canary` 和 `rules-hooks` 来自 S7 的包 `agent-claude-code-seat-checks`。三者全部注册之前,coder 策略一直报告未就绪(`sandbox` 注册后为 `missing: canary, rules-hooks`),驱动在创建时以缺失项名称拒绝该席位。不伪造任何贡献者。`ReadinessRegistry` 还保留一个非契约的 `notes` 映射(`note(id, code)`、`notesText()`,最多 64 个 id):失败的贡献者在此记录简短代码,例如 `canary FAILED attest`,`extend()` 会把它附加到未就绪错误之后。凡不是简短普通短语的内容(路径、摘要、片段)都会被替换为 `see host log`;探测器改为在 error 级别记录完整原因。被冻结的 `PolicyReadiness` 报告不变,也从不携带 notes。

### 克隆检查与守卫探测(S7 接缝)

- **`CloneCheckRegistry`**(`registries.cloneChecks`)。插件注册 `{id, roles, check({seat, cwd})}`;`extend()` 在每次查询时、固定 cwd 之后、构建策略之前,运行该席位角色的所有检查。检查通过抛出 `CloneCheckError(seat, code, reason)` 来拒绝,它继承自 `SeatMutedByPolicyError`,因此驱动会记录 `claude-code/refused` 并抛出带类型的回合错误。抛出的任何其他值都会被包装成代码为 `check-failed` 的 `CloneCheckError`(失败即关闭)。coder 查询还会在未注册 id 为 `clone-hooks-check`(`CLONE_HOOKS_CHECK_ID`)的检查时抛错(`check-missing`),所以仅靠一个伪造的 `rules-hooks` 就绪贡献者无法解除强制执行。
- **`claudeCodeGuardProbe`** 服务(`probe(signal?, timeoutMs?)`)。为保留席位 `dsh-canary-probe`(同名的真实席位会被 `extend()` 拒绝)在 `policyDir` 自己的子目录下生成真实的 coder 策略,通过 `/bin/sh` 运行完全相同的钩子命令,并要求:未知工具被守卫以其自身文本拒绝;对 `<cwd>/.git/config` 的 `Edit` 因受保护位置被拒绝;被授权的 `Read` 被放行且 stderr 为空(负向对照,可识破“一律拒绝”的伪守卫);随后重新核对 node、守卫副本和策略文件的哈希。结果为 `{ok: true, nodeSha256, guardSha256, policySha256}` 或 `{ok: false, code, reason}`,code 为 `attest`、`timeout`、`exit`、`reason`、`control`、`changed`、`spawn`、`error` 之一。它从不 reject;调用方只有在 `ok: true` 时才注册 `canary`。它证明的是经 `/bin/sh` 运行的生成命令,而不是 Claude CLI 会调用该钩子并遵从退出码 2(那由 S8 的实机探测证明)。
- 坦白说明:认证无法防御同一 uid 的进程替换 node 或守卫并改写 0700 的策略文件;每次查询的重新认证(大小、mtime、ctime、inode)把窗口缩短到一个回合。

## seat-guard 钩子

`src/bin.ts` 只是一个很薄的读取器,与守卫模块一起打包成随包发布的单个纯 JavaScript 文件 `lib/seat-guard.js`(`guardScriptPath()` 返回它;Node 不会在 `node_modules` 下剥离 TypeScript,所以 `.ts` 源码只能在工作区内使用,`buildHookCommand` 除非设置 `allowSourceGuard` 否则拒绝它)。`verifyGuardCommand(command)` 用策略必须拒绝的载荷运行生成的那条命令,并要求退出码 2 及守卫自己的 `seat-guard: denied` 原因;请在席位第一次查询之前调用。主机以原子方式写入 `<policyDir>/<seat>.json`(同目录临时文件、fsync、重命名;`writePolicyFile`),并得到这些字节的 SHA-256。钩子命令行由 `buildHookCommand` 构造:

```
/usr/bin/env -u NODE_OPTIONS <attested node> <attested guard script> --policy <path> --sha256 <hex> --seat <name>
```

`env` 是绝对路径 `/usr/bin/env`,与 node 一样经过验证,绝不通过 PATH 查找(SDK 没有按钩子设置的环境变量,命令行是固定它的唯一位置)。钩子并不直接运行包内的 `lib/seat-guard.js`:提供者把它复制到 `<policyDir>/seat-guard.js`(权限 0500;该目录必须是 0700 且属于主机用户,已存在但权限、属主不符或是符号链接的目录会被拒绝并给出补救办法),按源文件哈希验证该副本,并用副本路径构造命令。只有当副本的哈希或权限不一致时才会重写,且始终从首次使用时固定的源文件复制;源文件之后若有变化会被拒绝(`restart the host`),而不是被复制,因此被篡改的包文件无法到达席位。

每个值都按严格语法检查(席位名 `^[a-z][a-z0-9-]{0,31}$`;路径为绝对、规范、无 shell 元字符)并加单引号;超时为 60 秒。构造命令之前,`attestFile` 会验证 node 二进制和守卫脚本:普通文件、属于操作员或 root、组和其他人不可写、所在目录链无他人可写、SHA-256 已固定。它沿用驱动 `attestClaudePath` 的规则,因为该函数拒绝脚本扩展名且无法参数化;哈希辅助函数用的是驱动自己的。

钩子从 stdin 读取 `PreToolUse` JSON,检查 `tool_input.file_path`、`path`、`notebook_path`、Glob 的 `pattern` 和 Grep 的 `glob`。对每个候选路径,它解析真实路径(新文件用父目录加文件名,更深的路径用最近的已存在祖先),并要求按完整路径段落在策略的根之内(`/a/b` 不在 `/a/bb` 之内)、不在受保护前缀之内,且不是硬链接数大于 1 的已有文件。任何位置的 `..`、开头的 `~`、符号链接逃逸、悬空符号链接以及位于外部的绝对路径都会被拒绝。策略文件只有在是不超过 64 KiB 的普通文件时才会被读取,钩子载荷上限为 1 MiB。Glob 和 Grep 的模式不得在花括号或 extglob 分组内开始新路径(`{/etc/x,y}`、`@(/etc/x|y)`),分组内也不得出现 `/`。除非策略设置 `denyDirsContainingProtected: false`(v1 文件上的可选标志,默认开启),有效搜索目录位于某个已存在的受保护位置之上的 Grep 或 Glob(例如对 git 检出的 cwd 做 `Grep`)会被拒绝:请搜索子目录。不在策略 `tools` 列表中的工具被拒绝,`mcp__` 工具必须在其中列出。

**钩子只会拒绝。** 拒绝是退出码 2 加 stderr 上的一行原因。通过是退出码 0 且完全没有输出;钩子从不打印允许决定,静态测试断言钩子源码中不存在这样的输出路径。当策略文件缺失、不可读、损坏、`v` 不为 1、属于另一个席位,或其 SHA-256 与命令行上的不一致时,它同样拒绝。生成的钩子条目里的 matcher 字符串(`Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|mcp__dsh__.*`)有单元测试针对每个原生文件工具验证覆盖。

## 测试

`tests/` 使用真实的临时目录(符号链接指向 cwd 之外、硬链接、`..`、`/a/b` 对 `/a/bb`、含通配字符的 cwd、新文件的父目录检查),并以子进程方式、用 stdin 夹具运行钩子。provider 与工具测试(`tests/provider.spec.ts`、`tests/mcp/**`)通过 SDK 服务器自己的请求处理器调用工具,从而运行其输入校验,发布到真实的 SQLite 邮箱,并运行真实的守卫证明(见关于已构建守卫的限制)。仓库覆盖率门禁强制每个文件 100% 覆盖。

## Known Limitations and Deferred Work

- **钩子在崩溃、超时或缺少 node 时会失效放行。** 在 Claude Code 中只有退出码 2 才会阻止调用。守卫会捕获它能捕获的一切并以 2 退出,但被杀死或不存在的进程做不到;启动金丝雀(S7,`claudeCodeGuardProbe`)是结构性的兜底,这也是 `coder` 在金丝雀通过之前一直被拒绝的原因。
- **把守卫改写为 Rust**(编译型,每次工具调用没有 Node 启动开销)是已登记的后续工作;目前是 Node 运行 `lib/seat-guard.js`。
- **钩子到工具之间的竞态。** 钩子检查与工具使用之间的窗口是钩子固有的,硬链接检测只能发现已经存在的链接。
- **工具对符号链接的跟随。** ripgrep 与 glob 工具是否会跟随 cwd 内预先放置的符号链接(例如模式 `lnk*/*`,守卫只按其静态前缀判断)由实机探测确定,而不是单元测试。
- **供应(provisioning)属于信任边界。** coder 工作的克隆必须由主机准备;coder 仍可编辑之后会被执行的文件(`package.json` 脚本、`lefthook.yml`),这一部分交由人工审查。
- **贡献者的钩子组未经验证。** `ContributorRegistry.extraHookGroups` 原样返回 S6/S7 贡献者注册的内容;这些切片必须审计自己加入的内容。
- **大小写不敏感的文件系统会被拒绝**(受保护条目同时响应其大写名称时),cwd 等于 home 目录或位于受保护的 home 位置之内同样被拒绝。
- **规则匹配无法离线证明。** SDK 没有导出权限求值器,所以生成的规则字符串只能由本切片的实机探测针对真实 CLI 来证明;单元测试可以完整演练的是钩子这一层。
- **路径守卫看不到 shell。** 原生 `Bash` 被禁用;shell 沙箱属于后续切片。
- **cwd 中的模式字符被拒绝而不是转义。** 请把工作移到不含这些字符的路径。
- **守卫是构建产物。** `lib/seat-guard.js` 被 gitignore,由 `pnpm run typecheck`(或包构建)生成。守卫文件缺失的 provider 永远不会返回扩展(验证会拒绝它);运行守卫的测试在文件缺失时会先构建它。
- **只有三个贡献者全部注册后,coder 策略才就绪。** `sandbox` 贡献者(S6)以及 `canary` 与 `rules-hooks` 贡献者(S7 seat-checks 包)都通过 `claudeCodePolicyRegistries` 注册;在它们注册之前,报告会列出缺少的项,例如 `missing: canary, rules-hooks`,驱动拒绝该席位。就绪状态以 `provides` 字符串为键,而不是以注册者为键,所以第二个声称提供 `sandbox` 的贡献者不会改变任何事(测试固定了两点)。这里不伪造任何贡献者。
- **注册表通过服务共享,挂载顺序不限。** `claudeCodePolicyRegistries` 是 `{readiness, contributors, tools, cloneChecks}`,与策略使用的是同一批实例。后续插件在其 `inject` 中列出 `claudeCodePolicyRegistries`,无论谁先挂载,都会在 provider 挂载后启动。注册工具分两步:在 `tools` 上注册工厂,并在 `contributors` 上为允许的角色注册名称(只在其中之一出现的名称会让席位静音,并指出缺少的名称)。
- **污染盖章只打标签,不拒绝。** 被操纵的受污染会话仍可在其 `send_to` 列表内发送。
- **工具结果是经过清洗的文本。** 操作员 home 或席位 cwd 下的路径被替换为 `[path]`(工具可以只选 `home`);其他路径原样通过。
- **策略目录对文件工具是拒绝的。** `generateRules` 和 `generateSeatPolicy` 把(规范化的)策略目录加入拒绝规则和策略文件的拒绝前缀,因此即使该目录位于席位根目录之下,策略文件和 0500 的守卫副本也无法被规则读取或写入;cwd 若等于策略目录、位于其中或包含它,都会被拒绝(`extend` 在固定任何内容之前给出两个路径),因为 bash 沙箱以读写方式绑定整个 cwd,这会让策略文件和守卫副本可从 shell 写入。仅靠 0500 副本无法防御同一 uid 的写入者。
- **处理函数在主机进程中运行**,拥有主机的权限并接收由模型控制的参数;严格的模式、用闭包而非参数传递身份,以及 `send_to` 列表是仅有的围栏。
- **钩子使用的 node 及其每一级父目录都不得对他人可写。** `attestFile` 始终拒绝对其他人可写的文件或目录(链中带粘滞位的目录如 `/tmp` 除外)。组可写位只有在该组是所有者的私有组时才被接受,并且直接读取 `/etc/passwd` 和 `/etc/group`(不经 NSS)来判断:所有者是运行用户或 root,该组与所有者的 passwd 条目同名,成员列表为空或仅有所有者,且没有其他 passwd 条目把该组作为主组。fnm 安装需要这一点(其版本目录权限为 775,属组是所有者的私有组)。如果任一数据库无法读取,或在其中找不到该用户(LDAP 等 NSS 账户),则适用严格规则,操作员需执行 `chmod g-w`。驱动自己的 `attestClaudePath` 不变。实机探测的第 0 项会打印拒绝信息。
- **守卫文件的权限由构建固定。** tsdown 的 `onSuccess` 步骤把 `lib/seat-guard.js` 设为 0644,因为 664(umask 002)的文件会被同一验证拒绝;测试断言构建出的文件对组和其他人都不可写。
- **实机探测所见:cwd 内的硬链接文件只由守卫拒绝。** CLI 自身的规则会读取它;若钩子失效放行,就没有其他东西阻止该读取。
- **实机探测所见:Glob `lnk*/*` 被守卫拒绝仅仅是因为搜索目录包含 `.git`。** 在非 git 的 cwd 中守卫不会拒绝该模式(它只按静态前缀判断);CLI 对它没有返回任何文件。
- **实机探测所见:服务器暴露但允许列表省略的 `mcp__dsh__` 工具仍会出现在 init 工具列表中**,且只由守卫拒绝。因此 provider 只用允许的工具构建服务器(`policy.tools`),暴露的集合与允许列表是同一个集合。
- **邮箱拒绝以一句固定的话到达模型**(`mailbox_send refused: the mailbox rejected the message`);邮箱自己的文字只进入主机日志。
- **验证运行最多会阻塞主机 15 秒。** `verifyGuardCommand` 是同步的,因为驱动的 `extend` 是同步的(已冻结的契约);它对每个守卫、node 和策略哈希只运行一次,而守卫的响应远低于一秒。改成异步需要修改驱动契约,留给后续切片。
- **策略缓存以注册表为键。** 在席位策略被缓存之后才注册的贡献者、钩子组或工具会使版本计数器增加,下一次查询会重新生成策略。磁盘检查以非阻塞方式打开策略文件,仅当它是不超过 64 KiB 的普通文件时才读取。
