# dsh-cc-memory

> DeepSeek Harness 的「类 Claude Code 记忆」插件：自写记忆层（`MEMORY.md` 索引 + 按需正文 + 四类型 + CC 注入预算）＋ 指令层缺口（托管/用户/项目 CLAUDE.md、带 `paths` 门控的 `.claude/rules`、`@path` 导入）。

设计红线：**行为以 Claude Code 源码为准绳**，但**不 import 任何 `@deepseek-ai/*` 运行时包**——插件自持全部逻辑，只通过 `ctx` 暴露的 `tools` / `systemPrompt` 两个硬依赖面接入宿主。

**感谢**

FuRongJun-1999/dsh-memory(https://github.com/FuRongJun-1999/dsh-memory)

Yuyz0112/claude-code-reverse(https://github.com/Yuyz0112/claude-code-reverse)

jackyrx/analysis_claude_code(https://github.com/jackyrx/analysis_claude_code_)

shareAI-lab/Kode-CLI(https://github.com/shareAI-lab/Kode-CLI/blob/main/README.zh-CN.md)

---

## 目录

- [1. 它做什么：两条通路](#1-它做什么两条通路)
- [2. 会产生哪些文件、在哪、干什么](#2-会产生哪些文件在哪干什么)
- [3. 三个时机：写入、注入、读取](#3-三个时机写入注入读取)
- [4. 架构](#4-架构)
- [5. 工具与 `/memory` 命令](#5-工具与-memory-命令)
- [6. 用户可调参数](#6-用户可调参数)
- [7. 仓库与目录结构](#7-仓库与目录结构)
- [8. 安装与自检](#8-安装与自检)
- [9. 与 Claude Code 的差异](#9-与-claude-code-的差异)
- [10. 已知限制](#10-已知限制)

---

## 1. 它做什么：两条通路

Claude Code 的记忆是**两层互补**，本插件照此拆成两条独立通路，各有独立开关，互不连带：

| 通路                              | 内容                                                                             | 谁写             | 在本插件里的入口                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------- |
| **A. 自写记忆层**（auto memory）       | `MEMORY.md` 索引常驻 + 主题文件正文按需 + `user`/`feedback`/`project`/`reference` 四类型      | **模型自主**调用专用工具 | `cc_memory_write` / `cc_memory_read` / `cc_memory_forget`，另加 `/memory` 检视命令 |
| **B. 人写指令层**（instruction files） | 托管层、用户级、项目级、cwd 级 `CLAUDE.md`；`.claude/rules/**.md`（含 `paths` 条件规则）；`@path` 导入 | **人**手写文件      | 插件只负责把 CC 独有的那几类**加载并注入**（DSH 原生已认的根 `AGENTS.md` 不重复加载）                     |

两层的开关是分开的：`autoMemoryEnabled` 只管 A，`instructionsEnabled` 只管 B，`enabled` 才是总闸。

**与 CC 的两处有意偏离**（其余逐项对齐）：

1. **落盘位置**：CC 永远写 `~/.claude/projects/<project>/memory/`（机器本地、不进仓库）；本插件默认写**工作区内的 `.cc-memory/`**，让记忆跟着仓库走（用户 2026-10-06 定向）。
2. **写入触发方**：CC v1.0.33 的写入由**用户**用 `#` 触发，交给一次**隔离的 LLM 调用** + 强制 Write 工具，主模型自身没有自动写路径；本插件为**主模型直接持有记忆工具**，但保留 CC 的三条硬约束：**只增不改**既有内容、写入是**纯落盘**、写后**重新测量索引预算**。

---

## 2. 会产生哪些文件、在哪、干什么

插件运行时只在**两处**产生文件：**工作区记忆目录** 与 **用户级记忆文件**。两者是不同作用域，写入由 `scope` 决定（见 [§3.1](#31-写入)）。

### 2.1 工作区级 —— `<锚点>/.cc-memory/`

**锚点** = 从会话 cwd 向上找到的第一个含 `.git` 的目录（git 根）；找不到时退回 cwd。
⇒ **同一仓库的所有 worktree / 子目录共享同一份记忆**，与 CC「以仓库为锚」一致。

| 文件                            | 是谁   | 作用                                      | 何时出现          |
| ----------------------------- | ---- | --------------------------------------- | ------------- |
| `.cc-memory/MEMORY.md`        | 索引   | 每条记忆一行摘要，**会话启动唯一自动加载的东西**              | 第一次写工作区记忆时自动建 |
| `.cc-memory/<type>_<slug>.md` | 主题文件 | 一条记忆的正文，**启动不加载**，要 `cc_memory_read` 才读 | 同上            |

`<type>` ∈ `user` / `feedback` / `project` / `reference`；`<slug>` 是 `name` 的短横线化形式（`slugify`）。name 已带 `type_` 前缀时不再重复加前缀。

索引行的确切格式（`store.js:309`）：

```
- **<name>** (<type>) — <摘要> `<type>_<slug>.md`
```

首次写入时会先补一行标题 `# Memory index`。索引行按**文件名**做 upsert：已存在则整行替换，不存在则追加到末尾。

主题文件格式 = YAML frontmatter + 正文：

```markdown
---
type: feedback
modified: 2026-10-07T06:47:14.000Z
---

正文……
```

`modified` 只在**文件本来就带 frontmatter** 或**首次创建**时写入（CC 的硬约束）——人写进文件的其他字段不会被插件动。

### 2.2 用户级 —— `<DSH_HOME>/CLAUDE.md`

| 文件                     | 作用                                                | 何时出现                                               |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `<DSH_HOME>/CLAUDE.md` | `scope: 'user'` 的记忆以 **bullet** 形式追加；**不建索引、不排序** | 插件加载时若**不存在或为空**则自动创建并写入表头（`ensureUserMemoryFile`） |

这个文件是**双重身份**：

- 它是**记忆文件**——`cc_memory_write(scope: "user")` 往末尾追加一条 `- ...`；
- 它同时是**指令文件**——由指令层**整份注入**每次会话（等价于 CC 的 `#` → `~/.claude/CLAUDE.md`）。

因此它**不吃** `MEMORY.md` 那套 200 行 / 25 KB 预算，也**不会**出现在注入块的 `## Memory index` 段里，而是出现在 `## Claude Code instruction files` 段（标签 `user: CLAUDE.md`）。

自动创建时写入的是一段 **HTML 注释表头**（`userMemory.js:37-48`）。用注释包住是有意的：`stripHtmlComments` 在注入前剥掉它，剥完为空则整块不注入 ⇒ **没有真实条目时该文件对上下文零占用**，同时人在编辑器里打开又能看到用法说明。**已存在的文件一个字节都不会被改动**（用户手写内容原样保留）。

### 2.3 `memoryRootMode: 'dsh-home'`（选配的 CC 布局）

把落盘位置切回 CC 的形态，文件构成与 §2.1 相同，只是目录换成：

```
<DSH_HOME>/cc-memory/projects/<projectKey>/memory/MEMORY.md
<DSH_HOME>/cc-memory/projects/<projectKey>/memory/<type>_<slug>.md
```

`projectKey` = `<锚点目录名>-<锚点绝对路径 sha1 前 12 位>`（`paths.js:39-46`）。用哈希而非完整路径做目录名，既保证同仓库共享，又避免路径过深 / 非法字符。

若显式设了 `memoryRoot`，它**优先于** `memoryRootMode`，布局为 `<memoryRoot>/projects/<projectKey>/memory/`。

### 2.4 插件**不会**产生的文件

| 路径                                                    | 归属                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `<DSH_HOME>/memory/…`                                 | **DSH 框架自带的记忆系统**（`memory_log` / `memory_note` 等工具），与本插件无关 |
| `<DSH_HOME>/AGENTS.md`、工作区根 `AGENTS.md`               | **DSH 原生指令加载器**负责，本插件不重复加载                                 |
| 工作区 `<anchor>/.claude/CLAUDE.md`、`.claude/rules/*.md` | 由**人**手写，插件只读不写                                            |
| `%ProgramFiles%\ClaudeCode\CLAUDE.md` 等托管层            | 由**人/管理员**手写，插件只读不写                                        |

## 3. 三个时机：写入、注入、读取

### 3.1 写入

**唯一的写入通路是模型调用记忆工具**（`tools.js`）。插件自身只在加载时写一次用户级文件的表头。

```
cc_memory_write / cc_memory_forget
        │
        ├─ 三道闸门 guardMemoryAccess(cfg, st)      （tools.js:67-78）
        │     1. cfg.enabled && cfg.autoMemoryEnabled     否则 throw
        │     2. !st.isolated（子代理会话拒绝读写）        否则 throw
        │
        ├─ scope = resolveScope(type, scope)        （userMemory.js:57-60）
        │     · 显式 scope 优先
        │     · 缺省按 type 兜底：type='user' → 用户级，其余 → 工作区级
        │
        ├─ 用户级 → UserMemoryFile.append(content)  （userMemory.js:138）
        │     正文压成单行（flattenBullet）→ 空文件直写 bullet、否则换行追加
        │     同文幂等：已存在逐字相同的 bullet 则 mode='deduped'，不重复写
        │
        └─ 工作区级 → MemoryStore.writeMemory(...)  （store.js:156）
              ensureDir → 写主题文件（原子写）→ upsertIndexLine → describeIndex
              mode: create（已存在则报错）/ append（默认）/ replace
              摘要优先级：显式 summary > append 时沿用旧索引摘要 > 全文首句
        │
        └─ refresh(st)  ⇒  st.dirty = true  ⇒  下一次注入重新渲染
```

**写入失败不是抛给用户，而是回给模型**——`throw` 的错误会被 DSH 当作工具结果交给模型，模型能读到原因（例如「这是子代理会话，父对话的记忆故意不可用」）。

**索引超预算时写入仍然成功**（CC 行为），只在工具返回值里带一段 WARNING 要求模型精简；`budgetMode: 'strict'` 才会改成拒绝写入。

### 3.2 注入

注入走 **DSH 的 `systemPrompt` 面**，分两条独立通路：

| 面                            | 名称                         | order   | 内容                              |
| ---------------------------- | -------------------------- | ------- | ------------------------------- |
| `ctx.systemPrompt.section()` | `dsh:cc-memory:discipline` | `10100` | **静态纪律段**：告诉模型三个工具怎么用、什么该记、索引预算 |
| `ctx.systemPrompt.context()` | `dsh:cc-memory`            | `10100` | **动态快照**：指令文件块 + `MEMORY.md` 索引 |

动态快照渲染成 **user-role 快照追加在历史尾部**（不是 system prompt），与 CC 把 CLAUDE.md 作为「system prompt 之后的 user message」注入的机理一致。内容不变时 DSH 的 agent-loop 会去重，因此 **system prompt 保持字节级稳定，不击穿前缀缓存**。

`compose()`（`plugin.js:138-170`）拼出的一切都包在 `<system-reminder> … </system-reminder>` 里，并以一段免责声明收尾：

> IMPORTANT: this context may or may not be relevant to your tasks. …

**普通会话**的块内容与顺序：

```
## Claude Code instruction files (loaded by dsh-cc-memory)   ← 仅当有指令块
### managed: CLAUDE.md           ← %ProgramFiles% 等托管层，不可排除
### user: CLAUDE.md              ← <DSH_HOME>/CLAUDE.md（即用户级记忆文件）
### .claude/rules/ts-only.md     ← 规则文件（标签是相对路径）
### project: .claude/CLAUDE.md   ← git 根
### cwd: .claude/CLAUDE.md       ← 仅当 cwd ≠ git 根

## Memory index (MEMORY.md)      ← 仅当索引非空
<索引内容（前 200 行 / 25 KB）>
Memory directory: C:\…\.cc-memory
```

超预算时在索引后面插一行 `_(index truncated for injection: limit … )_`。

**子代理会话**（`subagentIsolation: true` 且判定为子代理）只保留指令块，并把记忆段换成 `### note`：「子代理不收父对话的记忆、也不能写它，请把结论汇报回父对话」。判据只看 `origin === 'subagent'` 或 `delegationDepth > 0`，**不看 `parentSession`**——「一键接续」派生的会话带 parentSession 但仍是用户会话。

**刷新（重新计算快照）的四个触发点**：

| #   | 触发                                                             | 位置                                       |
| --- | -------------------------------------------------------------- | ---------------------------------------- |
| 1   | `agent/session-start`、`agent/created`                          | `plugin.js:284-294`                      |
| 2   | 任意记忆工具写入 / 删除后                                                 | `tools.js` 各 `execute` 末尾的 `refresh(st)` |
| 3   | `tools/result`：某次工具调用**触达了新文件路径**，且该路径命中了某条**带 `paths` 的条件规则** | `plugin.js:317-345`                      |
| 4   | 上下文面被拉取时若 `st.dirty` 且未在刷新中                                    | `plugin.js:271`                          |

`refresh` 用 `st.dirty` 标志做成**可重入的循环**：刷新期间又有新写入，就再跑一轮，直到没有新变更。

### 3.3 读取

| 读什么                                     | 时机               | 谁读                                           |
| --------------------------------------- | ---------------- | -------------------------------------------- |
| `MEMORY.md` 的**前 200 行 / 25 KB**（先到者为准） | **每次注入**         | 插件自动（`readIndexForInjection`）                |
| 主题文件正文                                  | **从不自动加载**       | 模型显式调 `cc_memory_read`，或用户敲 `/memory <name>` |
| 用户级 `CLAUDE.md` **全文**                  | **每次注入**（作为指令文件） | 插件自动                                         |
| 条件规则（带 `paths`）                         | 仅当被触达的文件命中 glob  | 插件自动                                         |

`cc_memory_read` 不传 `name` 时返回一份**总览**：记忆目录、主题文件清单、`MEMORY.md` 原文、以及 `User-scope memories (<file>)` 段（用户级 bullet 列表）。

### 3.4 一张表

| 事件         | 写入                      | 注入        | 读取               |
| ---------- | ----------------------- | --------- | ---------------- |
| 插件加载       | 用户级文件表头（仅在缺失时）          | 注册两个注入面   | —                |
| 会话开始       | —                       | 指令块 + 索引  | 索引头部             |
| 模型写记忆      | 主题文件 + 索引行 / 用户级 bullet | 该轮之后重算    | —                |
| 模型删记忆      | 删主题文件 + 摘索引行 / 删 bullet | 重算        | —                |
| 读写文件命中条件规则 | —                       | 重算（新增规则块） | 规则文件             |
| 模型要正文      | —                       | —         | `cc_memory_read` |

---

## 4. 架构

```
┌─ DSH Host ─────────────────────────────────────────────────────────┐
│  ctx.tools   ctx.systemPrompt   ctx.get('commands')   ctx.on(...)  │
└───────┬──────────────┬──────────────────┬─────────────────┬────────┘
        │              │                  │                 │
   ┌────▼──────────────▼──────────────────▼─────────────────▼─────┐
   │                    lib/plugin.js  —— 唯一入口 apply()          │
   │  会话态 sessions: Map<agent, st>   st = { store, userMemory,   │
   │                identity, cwd, isolated, touched, pendingRules, │
   │                text, dirty, refreshing, error }                │
   │  compose() 拼块 · refresh()/kick() 重算 · 四个生命周期事件      │
   └──┬────────┬─────────┬──────────┬──────────┬───────────┬───────┘
      │        │         │          │          │           │
 ┌────▼───┐ ┌──▼────┐ ┌──▼─────┐ ┌──▼──────┐ ┌─▼───────┐ ┌─▼──────┐
 │config  │ │paths  │ │store   │ │userMem  │ │tools    │ │commands│
 │默认值  │ │锚点/  │ │工作区级│ │用户级   │ │三个工具 │ │/memory │
 │+解析   │ │目录   │ │索引+正文│ │bullet   │ │+预算提示│ │检视    │
 └────────┘ └───────┘ └────────┘ └─────────┘ └─────────┘ └────────┘
      │                    │            │           │
      └────────────┬───────┴────────────┴───────────┘
              ┌────▼─────────────────┐      ┌──────────────────┐
              │ instructions.js      │      │ util.js          │
              │ 指令层四段收集 +      │      │ 纯函数：frontmat │
              │ .claude/rules + @path │      │ ter/UTF-8/注释剥 │
              └──────────────────────┘      │ 离/glob/子代理判定│
                                            └──────────────────┘
```

| 模块                    | 行数级         | 职责                                                                                                                                      |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/plugin.js`       | 369         | Host 半入口 `apply(ctx, config)`：工厂式注册工具、命令、注入面、生命周期；会话态 `sessionFor`；`compose` / `refresh`                                                |
| `lib/config.js`       | 177         | `DEFAULT_CONFIG` 全量默认值 + `resolveConfig` 合并（默认值 → 用户 config → 环境变量）                                                                     |
| `lib/paths.js`        | 85          | `resolveDshHome`、`findGitRoot`、`projectIdentity`、`workspaceMemoryDir`、托管层默认路径                                                           |
| `lib/store.js`        | 350         | **工作区级**存储：索引读写 / 预算裁剪 / 原子写（EPERM 重试）/ 主题文件 / 删除 / 摘要选取                                                                                |
| `lib/userMemory.js`   | 171         | **用户级**存储：bullet 解析（跳注释与围栏）/ 追加 / 单行化 / 精确删 / 启动自建                                                                                      |
| `lib/instructions.js` | 313         | 指令层：托管→用户→项目→cwd 四段收集、`.claude/rules` 递归发现与 `paths` 门控、`@path` 导入展开                                                                     |
| `lib/tools.js`        | 318         | 三个工具的定义（手构，不依赖 `dsh-tools`）+ `guardMemoryAccess` + `formatBudgetNotice`                                                                 |
| `lib/commands.js`     | 113         | `/memory` 命令：概览 / `<name>` / `dir` / `index`（**只读**，不接管宿主编辑器）                                                                           |
| `lib/util.js`         | 418         | 纯函数：frontmatter 解析/序列化、UTF-8 字节与裁剪、`headBudget`、`stripHtmlComments`、`visibleContentLines`、glob、`isSubagentSession`、`countMemoryEntries` |
| `locale/{en,zh}.json` | 187 / 190 B | 模块名与描述                                                                                                                                  |

**指令层加载顺序**（宽泛 → 具体，`instructions.js:252-313`）：托管层 → 用户级 → git 根的规则目录与 `.claude/CLAUDE.md` → cwd 的规则目录与 `.claude/CLAUDE.md`。同一绝对路径只注入一次（`seen` 集合）。

**规则文件的两种**：frontmatter 里**没有 `paths`** 的启动即载；**有 `paths`** 的进 `conditionalPending`，等 `tools/result` 报告文件触达时才比对 glob。frontmatter 在载入前删除，且**只读 `paths` 一个字段**（CC 同款）。

**没有外部运行时依赖**：profile 的 `node_modules` 里只有 `schemastery` / `cosmokit`，`cordis` / `dsh-tools` 不可解析，所以插件全部自持——工具定义是手构的 `{ name, description, parameters, output, execute }`。

---

## 5. 工具与 `/memory` 命令

### 三个工具

| 工具                 | 参数                                                               | 行为                                                                                          |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `cc_memory_write`  | `name`\* / `type`\* / `content`\* / `scope` / `summary` / `mode` | 写一条记忆；`type` ∈ `user`/`feedback`/`project`/`reference`；`mode` ∈ `create`/`append`/`replace` |
| `cc_memory_read`   | `name` / `type` / `scope`                                        | 有 `name` 读一条正文；无 `name` 列总览（含用户级 bullet）                                                    |
| `cc_memory_forget` | `name`\* / `type` / `scope`                                      | **永久删除**：工作区级删主题文件 + 摘索引行；用户级删那一条 bullet                                                    |

\* = 必填。

`cc_memory_forget` 在 `scope: "user"` 时，`name` 要填**裸 bullet 正文**（不是带 `- ` 前缀的整行）。删不掉时错误信息会回显现存 bullet 列表。

### `/memory`

| 输入               | 输出                                         |
| ---------------- | ------------------------------------------ |
| `/memory`        | 记忆目录 + 主题文件清单（含字节数）+ `MEMORY.md` 原文 + 预算说明 |
| `/memory <name>` | 那一条记忆的全文                                   |
| `/memory dir`    | 只打印记忆目录                                    |
| `/memory index`  | 只打印 `MEMORY.md`                            |

命令是**只读**的——CC 的 `/memory` 会用 `$EDITOR` 打开文件供编辑，本插件不接管宿主编辑器，也不改宿主 UI。子代理会话与关闭 auto memory 时返回 `{ kind: 'error' }`。

---

## 6. 用户可调参数

### 6.1 在哪里改

插件的配置来自**当前 profile 的 patch 层**——`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`

它是一个顶层 YAML 数组，按 `id` 定位条目：

```yaml
- id: cc-memory
  name: '@local/dsh-cc-memory'
  config:
    indexMaxLines: 120
    autoMemoryEnabled: true
```

- 只写 `id` 也行；`id` 来自本包自带的 `cordis.patch.yml`（`id: cc-memory`）。
- `config:` 里的键与下表同名，**未列出的键沿用默认值**。
- 也支持 `- id: cc-memory` + `disabled: true` 整条禁用。
- **改完需要重启 DSH Desktop**（配置在插件加载时读取一次）。

### 6.2 总闸与位置

| 参数               | 默认值           | 说明                                                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `enabled`        | `true`        | 插件总闸。`false` 时两条通路都不注入（工具仍注册但拒绝写入）                                                                     |
| `dshHome`        | `''`          | DSH home；空串 ⇒ 依 `DSH_HOME` 环境变量、再退回用户目录下 `.dsh`                                                        |
| `memoryRoot`     | `''`          | 记忆根目录；非空时**优先于** `memoryRootMode`，布局 `<memoryRoot>/projects/<key>/memory`                              |
| `memoryRootMode` | `'workspace'` | `'workspace'`＝工作区内 `<锚点>/.cc-memory/`；`'dsh-home'`＝`<dshHome>/cc-memory/projects/<key>/memory/`（CC 布局） |

### 6.3 自写记忆层（通路 A）

| 参数                  | 默认值              | 范围 / 取值                | 说明                                                 |
| ------------------- | ---------------- | ---------------------- | -------------------------------------------------- |
| `autoMemoryEnabled` | `true`           | 布尔                     | 模型自写记忆总开关（对应 CC 的 `autoMemoryEnabled`）             |
| `indexMaxLines`     | `200`            | 1 – 100000             | 索引注入预算：**行数**上限（CC：前 200 行）                        |
| `indexMaxBytes`     | `25600`（25 KB）   | 256 – 4 MiB            | 索引注入预算：**字节**上限。与行数**先到者为准**                       |
| `maxSourceBytes`    | `262144`（256 KB） | 1 KB – 4 MiB           | 单个源文件读取上限；超过**直接跳过**不读（CC 的硬上限是 4 MiB）             |
| `budgetMode`        | `'warn'`         | `'warn'` \| `'strict'` | 索引超预算时：`warn`＝写入成功但要求模型精简（CC 行为）；`strict`＝**拒绝写入** |
| `subagentIsolation` | `true`           | 布尔                     | 子代理会话不注入 `MEMORY.md`、记忆工具也拒绝读写。**指令层不受影响**         |

### 6.4 指令层（通路 B）

| 参数                           | 默认值                     | 说明                                                                                            |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `instructionsEnabled`        | `true`                  | 指令层总开关                                                                                        |
| `managedInstructionFiles`    | `[]`                    | 额外的托管/策略层指令文件（绝对路径列表）                                                                         |
| `includeDefaultManagedFiles` | `true`                  | 是否并入平台默认托管层路径：`%ProgramFiles%\ClaudeCode\CLAUDE.md`、`%ProgramFiles(x86)%\…`、`%ProgramData%\…` |
| `userInstructionFiles`       | `['CLAUDE.md']`         | 用户级**指令**文件名（相对 `dshHome`）。DSH 原生只认 `AGENTS.md`，故此处默认 `CLAUDE.md`                             |
| `userMemoryFile`             | `'CLAUDE.md'`           | 用户级**记忆**文件名（相对 `dshHome`）。`scope: 'user'` 的 bullet 追加到这里，且该文件同时被指令层整份注入                      |
| `ensureUserMemoryFile`       | `true`                  | 是否在**启动时自动创建**用户级记忆文件（写入 HTML 注释表头）。已存在的文件绝不改写                                                |
| `projectInstructionFiles`    | `['.claude/CLAUDE.md']` | 项目级指令文件（相对 git 根 / cwd）；DSH 原生不认 `.claude` 子目录，故由本插件补                                         |
| `rulesDirName`               | `'.claude/rules'`       | 规则目录（相对 git 根 / cwd），递归发现 `.md`                                                               |
| `importsEnabled`             | `true`                  | 是否展开 `@path` 导入                                                                               |
| `maxImportDepth`             | `4`                     | 递归最大跳数（CC：4）                                                                                  |
| `allowExternalImports`       | `false`                 | 是否允许导入工作目录之外的文件（CC：首次弹一次性批准，默认拒绝）                                                             |
| `expandImportsInNativeFiles` | `false`                 | 是否也为「DSH 原生加载器负责的 `CLAUDE.md`/`AGENTS.md`」展开 `@path` 导入。默认 `false`，否则同一份正文会出现两次               |
| `instructionMaxBytes`        | `65536`（64 KB）          | **单个指令文件**注入前的截断上限（读入上限另由 `maxSourceBytes` 管）                                                 |

### 6.5 工具名与命令

| 参数                  | 默认值                  | 说明                  |
| ------------------- | -------------------- | ------------------- |
| `writeToolName`     | `'cc_memory_write'`  | 写入工具名               |
| `readToolName`      | `'cc_memory_read'`   | 读取工具名               |
| `forgetToolName`    | `'cc_memory_forget'` | 删除工具名               |
| `commandsEnabled`   | `true`               | 是否注册 `/memory` 检视命令 |
| `memoryCommandName` | `'memory'`           | 命令名（不含斜杠）           |

### 6.6 环境变量（优先级最高，便于排障时临时关掉某一半）

| 变量                               | 作用                                                       |
| -------------------------------- | -------------------------------------------------------- |
| `CC_MEMORY_DISABLE_AUTO_MEMORY`  | 置 `1` ⇒ 关通路 A（对齐 CC 的 `CLAUDE_CODE_DISABLE_AUTO_MEMORY`） |
| `CC_MEMORY_DISABLE_INSTRUCTIONS` | 置 `1` ⇒ 关通路 B                                            |
| `CC_MEMORY_ROOT`                 | 覆盖记忆根目录（CC 用 `autoMemoryDirectory` 设置项做同一件事）             |

**非法值一律回落到默认值，绝不抛错**——插件不得因为一份坏配置而挂掉宿主。

---

## 7. 仓库与目录结构

```
plugin/
├── lib/
│   ├── plugin.js          # Host 半入口：apply() / compose() / refresh() / 生命周期
│   ├── config.js          # DEFAULT_CONFIG + resolveConfig + 三个环境变量名
│   ├── paths.js           # DSH home、git 锚点、记忆目录、托管层默认路径
│   ├── store.js           # 工作区级存储（索引 + 主题文件）
│   ├── userMemory.js      # 用户级存储（bullet 追加 / 精确删 / 启动自建）
│   ├── instructions.js    # 指令层（四段收集 + 条件规则 + @path 导入）
│   ├── tools.js           # cc_memory_write / _read / _forget
│   ├── commands.js        # /memory
│   └── util.js            # 纯函数工具箱
├── locale/
│   ├── en.json
│   └── zh.json
├── test/
│   ├── smoke.mjs          # 纯函数级单测（当前 131 条）
│   ├── harness.mjs        # 真加载插件、跑完整数据流（当前 58 条）
│   └── .harness/          # harness 的夹具工作区（home / project / …）
├── cordis.patch.yml       # 声明本插件以 id `cc-memory` 插入
├── package.json
├── icon.svg
└── README.md           
```

---

## 8. 安装与自检

**安装**：以**链接**方式装进目标 profile 的 `node_modules`，并在该 profile 的 `cordis.patch.yml` 的 `config.bundles` 里登记 `@local/dsh-cc-memory`。

> **改代码只改工作区内的 `plugin/`**：因为安装位是链接，改工作区即改运行时，**不需要**（也不应该）去改安装位里的文件。改完先跑自检，再重启 DSH Desktop。

**自检**（在仓库根执行）：

```bash
node plugin/test/smoke.mjs      # 期望 131 passed, 0 failed
node plugin/test/harness.mjs    # 期望  58 passed, 0 failed
```

`smoke.mjs` 覆盖纯函数（frontmatter、预算裁剪、注释剥离、bullet 解析、glob、索引摘要选取、子代理判定）；`harness.mjs` 在临时夹具工作区里真加载插件，覆盖四条通路：工作区写入 / 用户级写入 / 指令层收集 / 子代理隔离。

---

## 9. 与 Claude Code 的差异

**已对齐的**：索引 200 行 / 25 KB 预算与「先到者为准」、主题文件按需读取、只增不改语义、空文件直接写 bullet 不加标题、四类型、子代理不收父记忆、`@path` 4 跳、块级 HTML 注释注入前剥离、`.claude/rules` 的 `paths` 门控、`modified` 只在本来有 frontmatter 时刷新、条目计数启发式（数以 `-`/`*`/`N.` 开头的行）。

**有意偏离的**：落盘位置（工作区 `.cc-memory/` vs CC 的 `~/.claude/projects/…`）、写入触发方（模型持工具 vs CC 的 `#` + 隔离调用）。

**尚未对齐的（认账）**：

| 差距                                         | CC 的做法                                                        | 本插件现状               |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------- |
| 写入不带隔离 LLM 调用                              | 隔离调用 + 强制 Write 工具                                            | 主模型直接调工具（用户定向，视为特性） |
| 无 `toolChoice` 钉死单次 Write                  | `toolChoice: { name, type: 'tool' }`                          | 无                   |
| 无双白名单路径校验                                  | 工具名 + `file_path` 必须严格相等，否则报错                                 | 无                   |
| 无写后回读 + diff 判定                            | 写后回读刷新 `readFileState`，无 diff 报 `No changes made to … memory` | 无                   |
| fork 例外                                    | 子代理不收记忆，**fork 例外**                                           | 本插件无 fork 概念        |
| 托管层 `managed-settings.json` 的 `claudeMd` 键 | 支持                                                            | 未实现                 |

其中「写入隔离调用」与「toolChoice 钉死」这两步是否值得做，取决于 DSH 插件 SDK 是否允许插件发起独立的 agent 调用——**待确认**。

---

## 10. 已知限制

1. **注入是建议不是强制**：注入块是 `<system-reminder>` 里的一段 user-role 上下文，末尾自带免责声明。要硬约束必须走 Hook 或 `--append-system-prompt`。
2. **超预算静默丢尾部**：`MEMORY.md` 超过 200 行 / 25 KB 时，超出部分**启动时根本不加载**，靠写入时的 WARNING 纠偏。
3. **`cc_memory_forget` 不可逆**：CC 靠用户手动编辑文件，有回收余地；本插件直接删文件。
4. **配置改动需重启**：配置在插件加载时读一次。
5. **`/memory` 只读**：不接管宿主编辑器。
6. **子代理隔离依赖宿主字段**：判据是 `origin === 'subagent'` 或 `delegationDepth > 0`，宿主若不提供这两个字段则退化为「不隔离」。
