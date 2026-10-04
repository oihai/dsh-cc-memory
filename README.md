# @local/dsh-cc-memory

DSH 的「类 Claude Code 记忆」插件。独立自足：不依赖、不 import 任何其他插件的运行时服务，也不 import `@deepseek-ai/*` 运行时包（只用 `node:*`）。

## 两条通路

### A. 自写记忆层（全部自建）

对齐 CC 的 auto memory（`docs/claude-code-memory-mechanism.md` 第 4 节）：

| 机制 | 实现 |
| --- | --- |
| 两级结构 | `MEMORY.md` 索引常驻 + 每记忆一个主题文件，主题文件**启动时不加载** |
| 四类型 | frontmatter `type: user \| feedback \| project \| reference` |
| 注入预算 | 索引只注入**前 200 行或前 25 KB，先到者为准**（`indexMaxLines` / `indexMaxBytes`） |
| 写入后重新测量 | 超预算时**写入仍然成功**，返回值带 `WARNING` 要求模型精简索引 |
| `modified` | 只在**本来就有 frontmatter** 的文件上刷新时间戳 |
| 存储位置 | `<DSH_HOME>/cc-memory/projects/<仓库名>-<gitRoot 哈希>/memory/`，以 **git 仓库**为锚 |
| 写入触发 | 主模型持有专用工具 `cc_memory_write` 自主调用（本项目选定路线，CC 当时是 `#` 用户触发） |

### B. 人写指令层（**只补 DSH 原生加载器不做的部分**）

DSH 原生 `@deepseek-ai/dsh-agent-instructions`（`lib/index.js:17-18`、`:141`）已经负责：项目根（`.git` 标记）→ cwd 逐级 `AGENTS.md`/`CLAUDE.md`、`.local` overlay、用户级 `<DSH_HOME>/AGENTS.md`、惰性追加、去重、截断。

**本插件因此绝不重复加载这些文件**（否则同一份 `CLAUDE.md` 会被注入两次），只补 CC 独有缺口：

1. 托管/策略层 `%ProgramFiles%\ClaudeCode\CLAUDE.md` 等（优先级最高、不可排除）；
2. 用户级 `<DSH_HOME>/CLAUDE.md`（原生只认该目录的 `AGENTS.md`）；
3. `./.claude/CLAUDE.md`（原生只看目录直接子文件，不下钻 `.claude/`）；
4. `.claude/rules/**/*.md`：无 `paths` frontmatter 者启动即载；有 `paths` 者为**条件规则**，只在模型读写命中 glob 的文件后激活；
5. `@path` 导入：相对**包含导入的文件**解析，递归最大 4 跳，跳过围栏代码块与行内代码，引号包裹的路径不导入，默认拒绝工作目录外的导入。

注入前统一剥离块级 HTML 注释（代码块内保留）。

## 注入通道

`ctx.systemPrompt.context()` → 渲染成 user-role 快照追加在历史尾部，与 CC 把 `CLAUDE.md` 作为「system prompt 之后的 user message」注入的机理一致（CC `Ie1(A,B)`，`chunks.94.mjs:564-578`）。内容不变时 DSH 的 agent-loop 会去重，因此 system prompt 保持字节级稳定，不击穿前缀缓存。

## 工具与命令

- `cc_memory_write` — `{ name, type, content, summary?, mode? }`，写主题文件并同步索引行。
- `cc_memory_read` — `{ name?, type? }`，读一个记忆正文；省略 `name` 时列出全部记忆与原始索引。
- `cc_memory_forget` — `{ name, type? }`，**删除**一条记忆（删主题文件 + 摘掉索引行）。存在理由：索引超预算时的纠偏话术要求「合并或删除陈旧条目」，而 CC 靠用户直接编辑文件达到同一效果，插件必须给模型等价能力，否则它只能清空正文、在索引里留下孤儿行。
- `/memory [name]` — 检视命令（`commands` Service，可选依赖）。无参数打印记忆目录、索引与主题文件清单；给 `name` 打印那一条全文；另有 `dir` / `index` 两个子命令。**只读**，不接管宿主编辑器。

索引行格式（官方文档未定义，本插件自定义）：

```
- **<name>** (<type>) — <summary> `<file>`
```

## 子代理隔离

CC 语义：主对话的**自动记忆**不加载进子代理（唯一例外是 fork），指令文件照常加载。本插件据此判定（`subagentIsolation`，默认 `true`）：

- 判据只看 `header.origin === 'subagent'` 与 `header.delegationDepth > 0`，**不看 `parentSession`**——「一键接续」派生的接续会话带 `parentSession` 但 `delegationDepth: 0`，是用户真实会话，误排除会导致功能失效。
- 命中时：不注入 `MEMORY.md`，三个记忆工具一律拒绝；指令层照常加载，并附一句说明它是子代理。
- 字段缺失一律**放行**（安全优先：漏判的代价是少一次隔离，误判的代价是用户会话失去记忆）。

## 配置（`cordis.patch.yml` 的 `config`）

`enabled`、`autoMemoryEnabled`、`instructionsEnabled`、`indexMaxLines`(200)、`indexMaxBytes`(25600)、`budgetMode`(`warn`/`strict`)、`subagentIsolation`(true)、`memoryRoot`、`dshHome`、`managedInstructionFiles`、`includeDefaultManagedFiles`、`userInstructionFiles`、`projectInstructionFiles`、`rulesDirName`、`importsEnabled`、`maxImportDepth`(4)、`allowExternalImports`(false)、`expandImportsInNativeFiles`(false)、`instructionMaxBytes`(65536)、`maxSourceBytes`(262144)、`writeToolName`、`readToolName`、`forgetToolName`、`commandsEnabled`(true)、`memoryCommandName`(`memory`)。

环境变量覆盖：`CC_MEMORY_DISABLE_AUTO_MEMORY=1`、`CC_MEMORY_DISABLE_INSTRUCTIONS=1`、`CC_MEMORY_ROOT`。

## 已验证的边界（v1 未做）

- `expandImportsInNativeFiles` 默认 `false`：原生加载器负责的 `CLAUDE.md`/`AGENTS.md` 里的 `@path` **不展开**——展开它会和原生已注入的原文重复。需要逐字对齐 CC 时打开，代价是正文出现两次。
- 托管层的 `managed-settings.json` 的 `claudeMd` 键（仅托管层有效）未实现；用 `managedInstructionFiles` 显式列路径代替。
- `/compact` 之后的自动记忆行为、记忆去重/合并算法、并发写冲突：官方文档与手头源码都没有依据，v1 采用「索引行按文件名 upsert 覆盖 + 删除走 `cc_memory_forget`」这一最保守定义。
- fork 例外未实现：DSH 会话头部目前无法把「fork」与普通子代理区分开（`origin` 都是 `subagent`），因此 fork 也被隔离。要放宽只能整体关掉 `subagentIsolation`。
- 写入用「临时文件 + rename」原子落盘，但没有跨进程版本守卫（CC 同样没有）；同一记忆被两个会话同时写时是**后写覆盖**。

## 自检

```
node plugin/test/smoke.mjs
```

当前基线：**100 passed, 0 failed**，覆盖 util（frontmatter / 预算截断 / 注释剥离 / `@path` 扫描 / glob / 会话归属判定）、store（写入、追加、索引 upsert、**删除与孤儿行**、预算告警）、instructions（加载顺序、条件规则门控、导入内联位置、嵌套 cwd）、tools（预算话术）、commands（`/memory` 四种参数形态）、config（默认值与非法值回落）。

其中「更新第 2 条记忆时不能吃掉第 1 条」这条回归用例抓出过一个真实的数据丢失 bug：索引行定位正则原先用了跨行的 `[\s\S]*?`，会从上一条记忆的行首开始匹配、一路吃到目标行，导致 upsert 覆盖掉中间若干条、remove 删掉它们。已改为单行内匹配 `[^\n]*?`。
