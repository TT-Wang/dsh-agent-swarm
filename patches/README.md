# Native command input correction / 原生命令输入修补

`harness-command-input.patch` corrects dsh-external#637 on the two DeepSeek
Harness releases its `Targets:` line names: `0.1.5-rc.3`
(`a4c74a91e06b00fe0b0937bde982170c526cc842`) and `0.1.7-rc.1`
(`46a7f68b0922371ce7144b668b90e377d8e799f4`). It is a host editor correction,
not an Agent Swarm command handler change. The defect is present unchanged in
both releases (and was in `0.1.5-rc.1` and `0.1.6-alpha.2`); only the token
color differs.

`0.2.1-rc.2` is not affected. Upstream fixed the loop in `92b23cb792`
(`0.2.1-alpha.2`) and then replaced `claim-decor.ts` with atomic command chips
in `98d93db18f` (`0.2.1-alpha.4`). A 0.2.x host needs neither the patch nor a
rebuilt `ui-conversation`.

The editor splits the highlighted `/command ` prefix from newly entered text.
Lexical copies the prefix style to both halves, then can merge them again before
the trailing node's transform clears that style. This creates an endless
split/merge loop when input extends an already styled text node. Clear the
overflow style immediately after splitting. The patch adds no input interception
and does not change submission, keyboard, or IME behavior.

The patch declares its targets on the `Targets:` line of its preamble, which
`git apply` ignores. Run the focused regression without modifying the Harness
checkout:

```sh
node scripts/check-harness-command-input.mjs /absolute/path/to/deepseek-harness
```

On a targeted release the probe applies this exact patch to a temporary source
copy and checks both the original failure and corrected typing, insertion,
deletion, and claim release. These are headless Lexical checks; they do not
emulate an operating-system IME. On a release that ships no `claim-decor.ts` it
prints `NOT AFFECTED` and exits 0. A release that still ships the file without
being targeted is refused until the defect is checked there and the release is
added to the `Targets:` line. `tests/command-input-patch.test.mjs` keeps every
target a release `compatibility.json` supports.

The patch is not automatically applied by installing Agent Swarm. A preview that
needs it keeps an isolated, rebuilt `ui-conversation` in
`<preview>/compat/ui-conversation` and loads it through its preview overlay; the
original Harness checkout is unchanged. That build belongs to the release it was
rebuilt from: `scripts/update-preview.mjs` refuses to boot the preview on any
other release, and `scripts/start-preview.mjs` and `scripts/start-lab.mjs` never
compose one. Remove the patch, this file and the check script when 0.1.5-rc.3
and 0.1.7-rc.1 leave `compatibility.json`.

---

这份补丁修复 dsh-external#637，只针对补丁 `Targets:` 行列出的两个 DSH 版本：`0.1.5-rc.3`
和 `0.1.7-rc.1`（`0.1.5-rc.1` 和 `0.1.6-alpha.2` 同样存在该缺陷；0.1.5 与 0.1.7 只有高亮颜色不同）。
缺陷在原生编辑器的命令高亮：拆分命令前缀时，正文继承了同样的样式，Lexical 可能立即把两段合并，
从而陷入重复拆分、合并。修法是在拆分后立即清除正文继承的命令样式，不新增输入拦截器，不修改提交、
键盘或输入法行为。

`0.2.1-rc.2` 不受影响：上游先在 `92b23cb792`（`0.2.1-alpha.2`）修复了这个循环，随后在
`98d93db18f`（`0.2.1-alpha.4`）用原子命令标签替换了 `claim-decor.ts`。0.2.x 宿主既不需要这份补丁，
也不需要重新构建的 `ui-conversation`。

补丁在前言的 `Targets:` 行声明目标版本，`git apply` 会忽略这段前言。上面的命令在目标版本上会
在临时副本中应用实际补丁，验证原始故障及修复后的文本操作，不会改动 Harness 源码，也不等于真实
系统输入法测试。宿主不含 `claim-decor.ts` 时，它输出 `NOT AFFECTED` 并以 0 退出；宿主仍含该文件
却不在目标版本中时，它会拒绝，直到在该版本上核实缺陷并把版本加入 `Targets:` 行。
`tests/command-input-patch.test.mjs` 确保每个目标版本都在 `compatibility.json` 的支持列表中。

安装 Agent Swarm 不会自动修补宿主。需要它的试用环境把独立构建的 `ui-conversation` 放在
`<preview>/compat/ui-conversation`，通过试用覆盖层加载。这份构建只属于构建它的那个版本：
`scripts/update-preview.mjs` 拒绝在其他版本上启动该试用环境，`scripts/start-preview.mjs` 和
`scripts/start-lab.mjs` 从不组合它。0.1.5-rc.3 和 0.1.7-rc.1 退出 `compatibility.json` 时，
连同本文件和检查脚本一起删除这份补丁。
