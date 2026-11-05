# @deepseek-ai/dsh-agent-claude-code-tools

[English](README.md) | 中文

[Claude Code 席位](../agent-claude-code-driver/README.md)的**权限策略核心**。它把主机私有的输入(主机席位的策略字段、工作目录、席位名;绝不使用注册表条目)转换成一个席位运行所依据的规则集:权限规则、第二层 `PreToolUse` 钩子,以及该钩子读取的文件。它是纯策略代码,自身不是 cordis 插件;把它以 `ctx.claudeCodePolicy` 提供给驱动的 provider 是同一切片稍后的部分。它实现的契约类型位于驱动中(`policy-contract.ts`)。

## 它生成什么

- **规则**(`generateRules`)。Claude Code 的路径规则是 gitignore 风格:`//abs` 表示绝对路径,`/abs` 表示相对于项目,因此这里每条规则都输出为 `//` 加上去掉开头斜杠的路径(例如 cwd 为 `/home/steve/x` 时是 `Read(//home/steve/x/**)`;绝不是 `///`,也不使用 `~/` 形式)。每个受保护目录同时生成裸路径条目和 `/**` 条目,因为 worktree 中的 `.git` 是一个文件。只有 `Read(...)` 和 `Edit(...)` 是真正的路径限定符(`Read` 覆盖 Grep 和 Glob;`Edit` 覆盖 Write、MultiEdit 和 NotebookEdit),所以不会生成 `Write(...)` 或 `Grep(...)` 规则。所有角色得到同一套拒绝集合:`~/.claude/**`、`~/.claude.json`、`~/.ssh/**`、`~/.config/gh/**`、`~/.dsh/**`、`~/.agents/**`,以及 cwd 内的 `.git/**`、`.claude/**`、`.mcp.json`、`.husky/**`。`coder` 还会得到针对 `//<cwd>/**` 的 `Read` 与 `Edit` 允许规则;`lead` 完全没有原生工具。
- **无法写入规则的 cwd 或 home 会被拒绝**(`UnsafePathError`):不是绝对路径或未规范化、是文件系统根、含有 `* ? [ ] ! # { } \ ( )` 中任一字符、空白或控制字符、与自身的 realpath 不相等、不是目录,或者(对 cwd 而言)位于受保护的 home 位置之内。
- **设置**(`generateSeatPolicy`):`{settings, allow, disallowedTools, tools, fences}`。其中 `settings` 含有守卫钩子和 `permissions.deny`,`allow` 含有 `mcp__dsh__<name>` 条目(coder 还含有 cwd 的 `Read`/`Edit` 规则),`fences` 重申 `dontAsk`、`settingSources: []`、`strictMcpConfig: true`。只应记录结果的 SHA-256(`settingsSha256`)。没有 `canUseTool`:在 `dontAsk` 下它从不会被调用,因此钩子就是第二层。
- **工具。** lead 模板恰好是 `mailbox_send` 和 `mailbox_directory`(即 `mcp__dsh__mailbox_send` 与 `mcp__dsh__mailbox_directory`)。主机席位的 `tools` 列表会裁剪模板;一个席位若没有任何工具,就抛出驱动契约中的 `SeatMutedByPolicyError`。后续切片通过 `ContributorRegistry.registerToolContributor` 与 `registerHookContributor` 追加名称和钩子组,无需修改本包。
- **就绪状态**(`ReadinessRegistry`)。策略服务一存在,`lead` 即可服务。只有提供 `sandbox`、`canary` 和 `rules-hooks` 的贡献者全部注册后,`coder` 才可服务;`missing` 列出缺少的项。

## seat-guard 钩子

`src/bin.ts` 只是一个很薄的读取器,与守卫模块一起打包成随包发布的单个纯 JavaScript 文件 `lib/seat-guard.js`(`guardScriptPath()` 返回它;Node 不会在 `node_modules` 下剥离 TypeScript,所以 `.ts` 源码只能在工作区内使用,`buildHookCommand` 除非设置 `allowSourceGuard` 否则拒绝它)。`verifyGuardCommand(command)` 用策略必须拒绝的载荷运行生成的那条命令,并要求退出码 2 及守卫自己的 `seat-guard: denied` 原因;请在席位第一次查询之前调用。主机以原子方式写入 `<policyDir>/<seat>.json`(同目录临时文件、fsync、重命名;`writePolicyFile`),并得到这些字节的 SHA-256。钩子命令行由 `buildHookCommand` 构造:

```
env -u NODE_OPTIONS <attested node> <attested guard script> --policy <path> --sha256 <hex> --seat <name>
```

每个值都按严格语法检查(席位名 `^[a-z][a-z0-9-]{0,31}$`;路径为绝对、规范、无 shell 元字符)并加单引号;超时为 60 秒。构造命令之前,`attestFile` 会验证 node 二进制和守卫脚本:普通文件、属于操作员或 root、组和其他人不可写、所在目录链无他人可写、SHA-256 已固定。它沿用驱动 `attestClaudePath` 的规则,因为该函数拒绝脚本扩展名且无法参数化;哈希辅助函数用的是驱动自己的。

钩子从 stdin 读取 `PreToolUse` JSON,检查 `tool_input.file_path`、`path`、`notebook_path`、Glob 的 `pattern` 和 Grep 的 `glob`。对每个候选路径,它解析真实路径(新文件用父目录加文件名,更深的路径用最近的已存在祖先),并要求按完整路径段落在策略的根之内(`/a/b` 不在 `/a/bb` 之内)、不在受保护前缀之内,且不是硬链接数大于 1 的已有文件。任何位置的 `..`、开头的 `~`、符号链接逃逸、悬空符号链接以及位于外部的绝对路径都会被拒绝。策略文件只有在是不超过 64 KiB 的普通文件时才会被读取,钩子载荷上限为 1 MiB。Glob 和 Grep 的模式不得在花括号或 extglob 分组内开始新路径(`{/etc/x,y}`、`@(/etc/x|y)`),分组内也不得出现 `/`。除非策略设置 `denyDirsContainingProtected: false`(v1 文件上的可选标志,默认开启),有效搜索目录位于某个已存在的受保护位置之上的 Grep 或 Glob(例如对 git 检出的 cwd 做 `Grep`)会被拒绝:请搜索子目录。不在策略 `tools` 列表中的工具被拒绝,`mcp__` 工具必须在其中列出。

**钩子只会拒绝。** 拒绝是退出码 2 加 stderr 上的一行原因。通过是退出码 0 且完全没有输出;钩子从不打印允许决定,静态测试断言钩子源码中不存在这样的输出路径。当策略文件缺失、不可读、损坏、`v` 不为 1、属于另一个席位,或其 SHA-256 与命令行上的不一致时,它同样拒绝。生成的钩子条目里的 matcher 字符串(`Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|mcp__dsh__.*`)有单元测试针对每个原生文件工具验证覆盖。

## 测试

`tests/` 使用真实的临时目录(符号链接指向 cwd 之外、硬链接、`..`、`/a/b` 对 `/a/bb`、含通配字符的 cwd、新文件的父目录检查),并以子进程方式、用 stdin 夹具运行钩子。仓库覆盖率门禁强制每个文件 100% 覆盖。

## Known Limitations and Deferred Work

- **钩子在崩溃、超时或缺少 node 时会失效放行。** 在 Claude Code 中只有退出码 2 才会阻止调用。守卫会捕获它能捕获的一切并以 2 退出,但被杀死或不存在的进程做不到;后续切片(S7)的启动金丝雀是结构性的兜底,这也是 `coder` 在它存在之前一直被拒绝的原因。
- **把守卫改写为 Rust**(编译型,每次工具调用没有 Node 启动开销)是已登记的后续工作;目前是 Node 运行 `lib/seat-guard.js`。
- **钩子到工具之间的竞态。** 钩子检查与工具使用之间的窗口是钩子固有的,硬链接检测只能发现已经存在的链接。
- **工具对符号链接的跟随。** ripgrep 与 glob 工具是否会跟随 cwd 内预先放置的符号链接(例如模式 `lnk*/*`,守卫只按其静态前缀判断)由实机探测确定,而不是单元测试。
- **供应(provisioning)属于信任边界。** coder 工作的克隆必须由主机准备;coder 仍可编辑之后会被执行的文件(`package.json` 脚本、`lefthook.yml`),这一部分交由人工审查。
- **贡献者的钩子组未经验证。** `ContributorRegistry.extraHookGroups` 原样返回 S6/S7 贡献者注册的内容;这些切片必须审计自己加入的内容。
- **大小写不敏感的文件系统会被拒绝**(受保护条目同时响应其大写名称时),cwd 等于 home 目录或位于受保护的 home 位置之内同样被拒绝。
- **规则匹配无法离线证明。** SDK 没有导出权限求值器,所以生成的规则字符串只能由本切片的实机探测针对真实 CLI 来证明;单元测试可以完整演练的是钩子这一层。
- **路径守卫看不到 shell。** 原生 `Bash` 被禁用;shell 沙箱属于后续切片。
- **cwd 中的模式字符被拒绝而不是转义。** 请把工作移到不含这些字符的路径。
