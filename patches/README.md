# Native command input correction / 原生命令输入修补

`harness-command-input.patch` targets the DeepSeek Harness releases in
[compatibility.json](../compatibility.json): `0.1.5-rc.3`
(`a4c74a91e06b00fe0b0937bde982170c526cc842`) and `0.1.7-rc.1`
(`46a7f68b0922371ce7144b668b90e377d8e799f4`). It is a host editor correction,
not an Agent Swarm command handler change. The defect is present unchanged in
both releases (and was in `0.1.5-rc.1` and `0.1.6-alpha.2`); only the token
color differs.

The editor splits the highlighted `/command ` prefix from newly entered text.
Lexical copies the prefix style to both halves, then can merge them again before
the trailing node's transform clears that style. This creates an endless
split/merge loop when input extends an already styled text node. Clear the
overflow style immediately after splitting. The patch adds no input interception
and does not change submission, keyboard, or IME behavior.

Run the focused regression without modifying the Harness checkout:

```sh
node scripts/check-harness-command-input.mjs /absolute/path/to/deepseek-harness
```

The probe applies this exact patch to a temporary source copy and checks both
the original failure and corrected typing, insertion, deletion, and claim release.
These are headless Lexical checks; they do not emulate an operating-system IME.
The patch is not automatically applied by installing Agent Swarm. A preview that
needs it loads an isolated, rebuilt `ui-conversation` package through its preview
overlay; the original Harness checkout is unchanged. Remove that local override
once the host includes the correction.

---

这份补丁修复 DSH `0.1.5-rc.3` 和 `0.1.7-rc.1` 原生编辑器中的命令高亮缺陷（`0.1.5-rc.1`
和 `0.1.6-alpha.2` 同样存在；0.1.5 与 0.1.7 只有高亮颜色不同）：拆分命令前缀时，正文继承了同样的
样式，Lexical 可能立即把两段合并，从而陷入重复拆分、合并。修法是在拆分后立即清除正文继承的
命令样式，不新增输入拦截器，不修改提交、键盘或输入法行为。

上面的命令会在临时副本中应用实际补丁，验证原始故障及修复后的文本操作，
不会改动 Harness 源码。它不等于真实系统输入法测试。安装 Agent Swarm 不会
自动修补宿主；需要它的试用环境通过独立构建的原生组件副本加载该修补。
宿主正式包含修复后即可移除本地覆盖。
