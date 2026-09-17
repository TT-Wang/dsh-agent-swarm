# 安装与运维指南

[English](operations.md) · [简体中文](operations.zh-CN.md) · [产品介绍](../README.zh-CN.md)

这份指南介绍 Agent Swarm 的安装、存储配置、任务运行和中断恢复。配置项面向 Harness 的运维者；普通用户通过 `/agent-swarm` 发起任务时，团队和任务预算由主 agent 决定。

## 支持的环境

仓库的 [compatibility.json](../compatibility.json) 记录了以下精确支持的 Harness 版本：

| Harness 版本 | 发布提交 |
| --- | --- |
| [0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` |
| [0.1.6-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2) | `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| [0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` |
| [0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |

三个版本都是预发行版。开发链接器检查记录的发布提交，不只检查包版本号。插件不承诺兼容 `0.1.0-rc.5`、未发布提交或任意自定义 profile。Better Sidebar 集成在 0.18.0 上经过验证。

运行需要：

- Node.js `^22.19.0 || >=24.0.0`、Git，以及 macOS 或 Linux。检查命令和语法探测使用 `/bin/sh`，交付操作依赖 POSIX 链接语义；不支持 Windows 执行环境。
- 上表中一个受支持版本的 Harness 源码检出，已安装依赖并构建 CLI 和 Web 应用。
- Harness 中可用的模型和供应商配置。**API key 和凭据由 Harness 管理**；插件默认使用主会话的模型。请在宿主中配置凭据，无需把 key 复制到插件中。
- 本地 Git 项目。目前未实现分布式 worker 或非 Git 工作区。

## 构建与安装

```sh
git clone https://github.com/TT-Wang/dsh-agent-swarm.git
cd dsh-agent-swarm

export DSH_HARNESS_ROOT="/absolute/path/to/deepseek-harness"
npm run link:dsh
npm run build
```

`link:dsh` 从该 Harness 检出链接共享运行时包和构建工具。插件目录不需要另行执行 `npm install`。

使用匹配版本的 Harness CLI，在插件仓库根目录选择以下**一种**挂载方式。

### 直接挂载插件

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "link:$PWD"
```

插件包本身成为 profile 的一个 bundle 层。请保留被链接的目录。

### 通过声明式 bundle 挂载

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "file:$PWD/profile"
```

[Bundle profile](../profile/README.md) 将插件和 Web 客户端一起安装，在必需的 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 层之后挂载。它显式声明可移植的存储根目录：优先使用 `$DSH_AGENT_SWARM_ROOT`，否则使用 `$DSH_HOME/agent-swarm`。可以通过该变量覆盖路径，或使用针对 `dsh-external-agent-swarm` 行的 `--patch` 覆盖层。

**不要同时使用两种方式。** 两者会插入相同的 Loader 行，bundle 元数据已声明此冲突。

### 启动与更新

```sh
cd /absolute/path/to/your-project
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" --profile web
```

打开 Harness 输出的认证启动链接。登录交换会设置浏览器 cookie；直接访问未认证的裸地址会返回 HTTP 401。插件在宿主认证之外还会检查任务和会话的归属。

直接 `link:` 挂载时，重新构建插件后重启 profile 并刷新浏览器。声明式 `file:` 挂载会打包插件内容：重新构建后，还须在插件仓库根目录再次执行对应的 `plugin --profile web add "file:$PWD/profile"` 命令（或使用匹配的 CLI 执行 `dsh plugin --profile web install`），然后重启 profile 并刷新浏览器。

同一台机器运行多个 Harness 版本时，请为每个版本使用独立的链接检出或构建副本；重新链接共享插件目录会改变所有使用该目录的宿主所加载的依赖。

## 运行一个任务

在以 Git 项目为工作目录的会话中选择模型，然后输入：

```text
/agent-swarm 为这个项目添加搜索功能，保留现有接口，并验证相关测试通过。
```

主 agent 选择成员、任务结构、验证命令和资源上限，用户无需填写 worker 数量或 token 预算。高级手动规划器仍然可用；保存草稿不会启动 worker。

规划开始前，插件将已跟踪文件的改动和未被忽略的新文件捕获为私有 Git 快照。源项目的分支、暂存区和工作文件保持原样。规划检出与 worker 使用同一个固定基线，重启后也不改变。未解决的合并冲突、存在未提交改动的子模块以及不支持的仓库布局会返回可操作的错误，不会静默遗漏文件。

新自动计划默认把负责人视为偏好。偏好成员忙碌或不可用时，满足执行条件的空闲成员可接取从未开始的待办；在途任务与恢复中的任务仍走既有生命周期。需要特定成员或模型时，主 agent 可设置 `assignmentMode: pinned`，禁止常态借调及启动故障时自动改用其他路线；主 agent 可在核对要求后显式修改负责人。未包含该字段的手动草稿和旧任务保持原绑定；在手动编辑器中选择负责人会强绑定，清空负责人会同时清除模式。无需新增用户配置或规划轮次，步数与 token 预算仍由主 agent 决定。

### 打开侧边栏

插件按顺序选择第一个可用界面：

1. **Harness 原生右侧边栏**：在受支持的 0.1.5 版本中，打开 Files 旁的 **New tab → Start → Agent Swarm**。命令和会话卡片会打开同一个标签页。
2. **Better Sidebar**：较早的受支持宿主已安装该插件时，从 **+** 标签菜单选择 **Agent Swarm**。
3. **独立 dock**：位于会话旁并记忆宽度；窄屏时移到会话下方。

同一时间只挂载一个界面。隐藏侧栏只停止显示更新，不停止 worker。成员活动显示宿主观察到的操作和信号新鲜度，不会逐 token 流式展示模型输出，也不保证每个活跃操作都产生有效进展。断线后，保留的活动会标记为最后观测状态，计时冻结；缺少新信号时会停止忙碌动画，但不会直接认定 worker 失败。

### 控制与交付

- **暂停 / 恢复**：暂停工作，再从持久状态恢复。提高上限不会自动恢复暂停的任务，也不会清零用量。执行时长额度不计入暂停和空闲/资源等待；明确指定的 `deadlineAt` 仍是绝对截止时间，恢复不重置累计消耗或该截止时间。
- **停止**：侧栏需要第二次点击确认。停止的任务不再向主 agent 投递通知；暂停时保留未回答的问题，其他报告等待恢复。自动完成的任务保留排队中的事实通知。
- **完成**：当所需独立验收覆盖任务标准时通常自动完成，也保留手动控制入口。
- **查看改动 / 应用结果**：代码任务完成后，可查看独立验收过的提交，并按原始项目快照计算和应用改动。应用保留分支和暂存区，在写入前报告冲突，不会自动暂存、提交或推送。如果应用超时，请先查询宿主回执，再明确重试。

<a id="storage-and-configuration"></a>

## 存储与配置

配置属于 Loader 行 `dsh-external-agent-swarm`，完整 schema 见 [src/index.ts](../src/index.ts)。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `statePath` | `~/.dsh/agent-swarm/swarm.sqlite` | 持久协调状态；每个文件只允许一个活跃运行时。 |
| `workspacesRoot` | `~/.dsh/agent-swarm/workspaces` | 快照、成员 worktree 和验证检出，必须位于源仓库之外。 |
| `verificationDependencyDirs` | `["node_modules", ".venv", "venv", "vendor", ".tox"]` | 提供给干净验证检出的已安装依赖目录。 |
| `verificationDependencyMode` | `"link"` | 未启用下方显式链接读取许可时，实际生效模式是 `copy`。 |
| `allowDependencyLinkReads` | `false` | 允许配置的 `link` 模式，包括沿链接读取源项目工具链。 |
| `checkConcurrency` | `2` | 每个宿主同时执行的声明式检查数，其余按 FIFO 排队。 |
| `cacheReadWeight` | `0.1` | 缓存读取计入 token 预算的权重，原始用量单独保留。 |
| `budgetWarnAt` | `[0.7, 0.9]` | 各资源维度达到这些比例时通知主 agent。 |
| `authorizedWorkspaces` | `[]` | 人工配置的会话工作目录之外的授权根：`{ path, note?, expiresAt? }`。 |
| `planningTimeoutMs` | `600000` | 启动前规划看门狗，主 agent 可说明原因后延长。 |
| `workerStartTimeoutMs` | `60000` | 原生 worker 启动上限；恢复时各成员独立启动，放弃的启动会被取消。这是宿主生命周期限制，不是模型步数或 token 预算。 |
| `checkTimeoutMs` | `600000` | 任务未指定时，单条检查命令的兜底超时。 |
| `leaseMs` | `120000` | attempt 租约，在观察到真实操作时续租。 |
| `tickMs` | `1000` | 调度器 tick 间隔。 |

**仅修改 `DSH_HOME` 不会隔离插件的默认存储。** 多个独立 Harness 进程应通过 profile 覆盖层各自设置绝对路径的 `statePath` 和 `workspacesRoot`，或使用 bundle 的显式根目录。数据库 owner 锁会拒绝第二个活跃运行时，并指出持有进程。已退出进程遗留的锁可以回收；不要通过删除协调状态来解决活跃进程之间的所有权冲突。

这些基础设施配置不替代主 agent 对具体任务预算和策略的决策。保留的 worktree 和 Git refs 需要显式清理。

### 授权其他工作区

任务可以使用调用会话的工作目录，或 realpath 位于 `authorizedWorkspaces` 某个授权根内的路径。修改授权根需要用户编辑 profile 或 `cordis.patch.yml`，然后重启 Harness。任何模型可调用工具都不能添加、扩大或撤销授权根。

解析后的工作区和匹配到的授权会持久记录。未授权路径返回 `[workspace_not_authorized]` 及修正说明。删除某个根并重启后，系统拒绝在该目录创建新任务；现有任务在下一次准备工作区或创建验证检出时会被阻止继续，并记录 blocked 原因和主 agent 通知。

授权不等于保密隔离。它不提供独立的网络或凭据隔离；配置文件的写权限以及授权根被替换仍是相关风险。详见[已知限制](known-limitations.md)。

## 资源用量

主 agent 选择成员和任务上限，也可以说明原因后调整。恢复任务不重置用量。规划要求显式填写每项任务的步数和 finding 上限；如果使用了兜底值，`ceilingProvenance` 会在重新校验和重启后保留这一事实。

- **用量分桶**：按成员和任务记录未缓存输入、缓存读取、缓存写入、输出和实际请求数。推理用量是输出的一部分，不应再次叠加。
- **预算权重**：缓存读取按 `cacheReadWeight`（默认 `0.1`）计入预算。因此原始 token 量与预算计费量不同；这是一种权重策略，不是精确的供应商账单。
- **主会话**：它的用量单独归属和记录，不计入 worker 资源池。
- **预警与准入**：主 agent 收到阈值提醒；允许下一步前会计入在途请求的估算用量。异常大的请求仍可能跨过上限，供应商未报告的用量也无法统计。
- **检查命令**：宿主在 `checkConcurrency` 限制下记录排队和执行时长，使用任务指定的超时或配置兜底值。

## 恢复与排查

| 情况 | 系统行为与处理方式 |
| --- | --- |
| 任务尚未创建，规划已超时 | 保存的请求、固定快照和用量仍在。使用侧栏的**重试**或**停止**；agent/API 也可通过保存的 `requestId` 控制。重试会推进规划 epoch，旧回调不能启动已取消工作。 |
| 任务暂停或预算耗尽 | 让主 agent 检查原因，按需调整计划或上限后再恢复。恢复不会重置已用资源或截止时间。 |
| Worker 或宿主中断 | 持久状态和已捕获工件保留。宿主导致的停止会将任务重新置为 pending，不消耗恢复额度；attempt 租约阻止旧 worker 继续写入。反复执行失败仍受恢复上限约束。 |
| 供应商配额、限流或可用性故障 | 已分类故障保留 attempt，不消耗恢复额度。故障类别变化时通知主 agent；有可用成员时可以重新路由工作。 |
| 任务被驳回，下游持续等待 | 主 agent 可准入保留原验收标准的 replacement；replacement 验收通过后，下游依赖会解析到它。 |
| 主 agent 离线或原生调用挂起 | 通知持久保留。主 agent 恢复可用并到达原生 inbox 边界后才能行动；运行时取消不依赖它。通知投递不保证模型立即响应。 |
| 数据库被截断或丢失 | 存储拒绝继续运行并指出快照。主 agent 可通过 `swarm_restore` 暂存一个已校验快照，下次宿主启动时会在打开数据库前应用。 |
| 检查找不到命令 | 检查已安装工具链和 `verificationDependencyDirs`。命令缺失属于环境失败；插件不会代为安装项目依赖。 |
| 浏览器返回 HTTP 401 | 使用当前 Harness profile 输出的认证启动链接。 |
| 缺少供应商 key | 在 Harness 中配置模型路由和凭据。插件没有独立的 API-key 存储。 |

验证会针对精确的提交工件执行任务声明的命令。agent 的成功声明不能豁免失败命令，但检查通过也不意味着命令覆盖了全部需求。默认将被忽略的依赖目录复制到验证检出中；它们是已安装的工具链状态，不是全新的 CI 安装。显式启用链接模式可能允许沿链接读取源项目。

复制模式支持本身为符号链接的依赖目录，并重定位目录内部的链接。指向外部普通可执行文件的链接，例如虚拟环境中的 Python 解释器，会物化为复制的可执行文件，仍可能依赖系统库。损坏链接、指向源项目其他内容的链接，以及指向外部目录或非可执行数据的链接，会被拒绝并给出修复提示。请使用自包含依赖；若宿主明确接受外部读取，需同时配置 `verificationDependencyMode: link` 和 `allowDependencyLinkReads: true`。

快照以当前 Git 暂存区确定文件范围：已取消跟踪且现在被忽略的文件，即使 HEAD 曾经跟踪，也不会纳入。捕获后会再次比较私有暂存区和当前文件内容，对检测到的编辑竞争重试；这仍不是并发多文件编辑下的原子快照。

实时增量数据异常时，侧栏保留最后有效视图，并退避重试完整快照；持续异常会明确显示连接故障，不会虚构进度。主 agent 可以在暂停、停止或完成后结算已有问题，无需重新启动 worker。Trace 指标明确标注所覆盖的 span 窗口及截断状态，完整持久记录另行保留。

Worker 隔离依赖配置的 Harness 沙箱；共享临时目录仍可能成为成员之间的通信路径。交付阶段的 Git 子进程、准入阶段同步执行的 ignore 探测也保留了进程管理例外，详见[已知限制](known-limitations.md)。

<a id="companion-context-policy"></a>

## 配套的上下文策略

[dsh-slice-agent-loop](https://github.com/TT-Wang/dsh-slice-agent-loop)（`@dsh-external/dsh-slice-agent-loop`）是可选的配套插件，用于管理每个会话保留的上下文。Agent Swarm 协调多个 worker 的任务；slice 策略管理每个原生会话内部的历史，并通过 `recall_turn`、`recall_search`、`recall_step` 和 `expand_result` 取回之前的内容。上下文管理不改变 swarm 的验收、工作区或预算规则，也不保证特定的缓存命中率或供应商费用。

按照两个项目各自的安装说明，将 swarm 和 slice 层挂载到同一个 profile。两者的工具命名没有重叠。Slice 包已经包含工具结果折叠，不要再同时安装独立的 folding 插件。Swarm 存储仍需要前文说明的显式根目录。

<a id="development-and-verification"></a>

## 开发与验证

链接受支持的 Harness 检出后：

```sh
npm run verify
```

该命令执行类型检查、构建、行为测试、打包工件加载、真实 Loader 组合、CLI profile 安装、声明式 bundle 检查和两条浏览器工作流。

| 命令 | 覆盖范围 |
| --- | --- |
| `npm test` | 构建和完整行为测试。 |
| `npm run test:faults` | 故障注入；每个场景须证明故障实际发生。 |
| `npm run test:replay` | 基于持久日志的确定性回放。 |
| `npm run test:load` | 负载下的准入和调度。 |
| `npm run test:isolation` | 仅宿主执行的沙箱和工作区隔离检查。 |
| `npm run test:harness` | 真实 Harness Loader 组合。 |
| `npm run test:pack` / `npm run test:packed` | 打包工件加载与声明行为。 |
| `npm run test:profile` | 真实 CLI profile 安装与生命周期。 |
| `npm run test:bundle` | Bundle 元数据、可移植根目录、宿主组合与真实 profile 启动。 |
| `npm run test:web` / `npm run test:command-web` | 侧栏和 `/agent-swarm` 浏览器工作流。 |

这些测试使用临时 profile 和 Git 工作区，供应商回复由脚本提供。它们验证集成行为，不代表模型规划成功率。`npm run test:deepseek` 和 `npm run test:command-deepseek` 会发起真实供应商请求，可能产生费用，不包含在 `verify` 中。已完成的运行及其边界记录在[验证文档](validation.md)。

## 修订估算，继续原任务

主 agent 会提前收到持久的预算提醒，覆盖总体资源和任务步数/发现数量，并注明模型在途用量估计。提醒不改变任务形态。`swarm_budget(missionId, taskId, taskBudget, reason)` 修改原任务的有限额度；省略 `taskId` 并提供 `budget` 可调整总体预算。累计消耗、任务身份和工件不变；如果只是资源等待，扩额并确认停止后会继续，用户主动暂停仍需恢复。发现数量只作复核信号。用户明确暂停和停止仍然有效。

`swarm_control(missionId, taskId, action: "amend", changes, reason)` 修订尚未提交的范围、依赖、检查或负责人；修复准备条件/检查环境后，用 `action: "resume"` 继续同一任务。复核重试仍绑定原提交；真实断言失败需要正确实现及独立审查。旧 worker 停止并保存工作区后，才能重新分配。

集成 worker 可按 `.swarm-integration-conflicts.json` 编辑冲突文件，移除清单后提交。宿主保留已验收依赖提交，并检查最终工件范围。未知脚本和从自然语言推测出的路径只作规划提示；授权、范围、真实检查与独立复核继续强制执行。失败计划可以编辑重试，保留原请求、快照、已准入任务及消耗。

复核改派会恢复同一固定源版本的已保存草稿；新复核人仍须独立检查 `sourceCommit` 并引用自己的工具证据。复核工作树可能包含前人的实验，主机检查始终使用精确工件的新检出。

只要必要的合成或复核仍未完成，任务就不能标为完成，即使其他已验收任务重复了相同验收文字。依赖失效的原任务会保留并通知主 agent，可直接 amend 依赖或负责人。确实不再需要的工作应由主 agent 明确 `swarm_cancel`；完成动作本身不会取消任务。

检查环境将配置的 `dependencyLinks.dirs` 集合与本次实际找到的相对路径 `materializedPaths` 分开记录。目录顺序和未安装的可选依赖目录不改变配置策略；真实的目录集合或复制/链接模式差异仍会拒绝不一致的验收。

## 编排问题的恢复方式

依赖过期时，优先修改原任务，避免创建重复交付物。`changes.dependencies` 会替换整个依赖列表，返回值列出新增和移除的依赖；取消前置任务会返回 `strandedDependents`。替换必须沿现有修复链继续，不能绕过仍在执行或已经接受的后代，另开祖先分支。

旧执行必须真正停止并完成草稿保存，才能把成员工作区交给新任务。队列等待超时会返回可处理的错误，不会并发切换同一工作区；主 agent 仍可暂停、停止、查看状态或处理其他 mission。确定性的保存失败会保留占用保护，并按任务、轮次和原因去重通知。修复提示的条件后，可用 `swarm_control(action: "resume", taskId, reason)` 重试清理；已取消的任务也能清理，但不会被重新启动。

任务明确声明且在 scope 内的忽略文件会进入私有恢复快照；不会扫描收集任意忽略文件。未声明文件发生覆盖冲突时，会停止工作区切换并报告路径。`swarm_verify.deliverables` 可选地捕获独立复核报告的不可变内容；不提交报告文件时，复核裁决仍然持久保存。被审查的源工件和主机检查始终绑定原提交。

预算提醒会计入已知待补复核所需的任务名额。`suggestedLimit` 只表示退出预警区间所需的余量，主 agent 必须结合剩余工作与实际进展决定预算。消息已入队不等于成员已收到：投递失败会出现在精简成员视图中，并通知主 agent。提醒在真正进入上下文时会再次核对，因此停止任务、已回答问题、被新预算取代的旧提醒不会额外触发决策轮；已经读过的历史消息仍保留在会话记录中。
