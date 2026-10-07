/**
 * 插件配置：默认值 + 环境变量覆盖 + 用户传入 config 合并。
 *
 * 设计纪律（沿用 CC 的开关语义，见 docs/claude-code-memory-mechanism.md 第 5 节）：
 *   - 总开关只关「自写记忆层」，不连带改变指令层；反之亦然。
 *   - 任何非法值一律回落到默认值，绝不抛错（插件不得因为一份坏配置而挂掉宿主）。
 */

/** 与 CC 的 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 对齐的禁用开关。 */
export const DISABLE_AUTO_MEMORY_ENV = 'CC_MEMORY_DISABLE_AUTO_MEMORY'
/** 记忆根目录覆盖（CC 用 `autoMemoryDirectory` 设置项做到同一件事）。 */
export const MEMORY_ROOT_ENV = 'CC_MEMORY_ROOT'
/** 指令层总开关（补缺口那一半）。 */
export const DISABLE_INSTRUCTIONS_ENV = 'CC_MEMORY_DISABLE_INSTRUCTIONS'

export const DEFAULT_CONFIG = {
  /** 插件总闸：false 时两条通路都不注入（工具仍注册但会拒绝写入）。 */
  enabled: true,

  /** DSH home；空串＝按 DSH_HOME 环境变量 / 用户目录推断。 */
  dshHome: '',
  /** 记忆根目录；非空时优先于 `memoryRootMode`，布局为 `<memoryRoot>/projects/<key>/memory`。 */
  memoryRoot: '',
  /**
   * 记忆落盘位置（用户 2026-10-06 定向）：
   *   - `'workspace'`（默认）：`<git 仓库根 或 cwd>/.cc-memory/`，记忆跟着工作区走；
   *   - `'dsh-home'`：`<dshHome>/cc-memory/projects/<key>/memory/`，机器本地（CC 的布局）。
   * 注：CC 自己永远用后者（`~/.claude/projects/<project>/memory/`，不进仓库），
   * 默认工作区模式是对 CC 的有意偏离。
   */
  memoryRootMode: 'workspace',

  // ---------- 自写记忆层 ----------
  /** 模型自写记忆总开关（对应 CC 的 autoMemoryEnabled）。 */
  autoMemoryEnabled: true,
  /** 索引注入预算：行数上限（CC：前 200 行）。 */
  indexMaxLines: 200,
  /** 索引注入预算：字节上限（CC：前 25 KB）。两者先到者为准。 */
  indexMaxBytes: 25600,
  /** 单个源文件读取上限，超过直接跳过（CC 的硬上限是 4 MiB）。 */
  maxSourceBytes: 262144,
  /** 索引超预算时的行为：'warn'＝写入成功但要求模型精简（CC 行为）/ 'strict'＝拒绝写入。 */
  budgetMode: 'warn',
  /**
   * 子代理隔离（CC 语义：主对话的自动记忆**不加载**进子代理，唯一例外是 fork）。
   * true 时，被判定为子代理的会话既不注入 `MEMORY.md`，其记忆工具也拒绝读写。
   * 指令层不受此开关影响——CLAUDE.md 族在子代理中照常加载。
   */
  subagentIsolation: true,

  // ---------- 指令层（只补 CC 独有缺口） ----------
  instructionsEnabled: true,
  /** 托管/策略层指令文件（Windows 默认路径由 paths.js 提供，不在此写死）。 */
  managedInstructionFiles: [],
  /** 是否并入平台默认的托管层路径（`%ProgramFiles%\ClaudeCode\CLAUDE.md` 等）。 */
  includeDefaultManagedFiles: true,
  /** 用户级指令文件名（相对 dshHome）；DSH 原生只认 AGENTS.md，故此处默认 CLAUDE.md。 */
  userInstructionFiles: ['CLAUDE.md'],
  /**
   * 用户级**记忆**文件（相对 dshHome，用户 2026-10-07 定向）：`scope: 'user'` 的记忆以 bullet 形式
   * 追加到该文件，不建索引；该文件同时被指令层整份注入（与 CC 的 `#`→`~/.claude/CLAUDE.md` 同构）。
   */
  userMemoryFile: 'CLAUDE.md',
  /**
   * 是否由本插件在启动时**自动创建**用户级记忆文件（用户 2026-10-07 定向）。
   * 文件不存在时写入一段 HTML 注释表头；注释在注入前被 `stripHtmlComments` 剥掉，
   * 且剥完为空则整个块不注入（instructions.js:149-150），因此这个表头**零注入开销**。
   * 已存在的文件绝不改写——用户手写在里面的内容原样保留。
   */
  ensureUserMemoryFile: true,
  /** 项目级指令文件（相对 git root / cwd）；DSH 原生只认同目录的 CLAUDE.md，不认 .claude 子目录。 */
  projectInstructionFiles: ['.claude/CLAUDE.md'],
  /** 规则目录（相对 git root / cwd），递归发现 .md。 */
  rulesDirName: '.claude/rules',
  /** `@path` 导入展开。 */
  importsEnabled: true,
  /** 递归最大跳数（CC：4）。 */
  maxImportDepth: 4,
  /** 是否允许导入工作目录之外的文件（CC：首次弹一次性批准，默认拒绝）。 */
  allowExternalImports: false,
  /**
   * 是否也为「DSH 原生加载器负责的 CLAUDE.md/AGENTS.md」展开 @path 导入。
   * 默认 false：原生已注入该文件原文，再注入一份展开版会让同一份正文出现两次
   * （违反「CLAUDE.md 主链不重复加载」的约束）。需要与 CC 逐字一致时再打开。
   */
  expandImportsInNativeFiles: false,

  /** 单个指令文件的注入字节上限。 */
  instructionMaxBytes: 65536,

  // ---------- 工具名 ----------
  writeToolName: 'cc_memory_write',
  readToolName: 'cc_memory_read',
  forgetToolName: 'cc_memory_forget',

  // ---------- `/memory` 命令 ----------
  /** 是否注册 `/memory` 检视命令（对应 CC 的 `/memory`，但只读不写）。 */
  commandsEnabled: true,
  /** 命令名（不含斜杠）。 */
  memoryCommandName: 'memory',
}

function str(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

function int(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min || i > max) return fallback
  return i
}

function strList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const out = value.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
  return out.length > 0 ? out : fallback
}

/**
 * 合并配置：默认值 → 用户 config → 环境变量（环境变量优先，便于排障时临时关掉某一半）。
 * @param {unknown} input 来自 cordis.patch.yml 的 `config`。
 */
export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const cfg = { ...DEFAULT_CONFIG }

  cfg.enabled = bool(raw.enabled, DEFAULT_CONFIG.enabled)
  cfg.dshHome = str(raw.dshHome, DEFAULT_CONFIG.dshHome)
  cfg.memoryRoot = str(raw.memoryRoot, DEFAULT_CONFIG.memoryRoot)
  cfg.memoryRootMode =
    raw.memoryRootMode === 'dsh-home' || raw.memoryRootMode === 'workspace'
      ? raw.memoryRootMode
      : DEFAULT_CONFIG.memoryRootMode

  cfg.autoMemoryEnabled = bool(raw.autoMemoryEnabled, DEFAULT_CONFIG.autoMemoryEnabled)
  cfg.indexMaxLines = int(raw.indexMaxLines, DEFAULT_CONFIG.indexMaxLines, 1, 100000)
  cfg.indexMaxBytes = int(raw.indexMaxBytes, DEFAULT_CONFIG.indexMaxBytes, 256, 4 * 1024 * 1024)
  cfg.maxSourceBytes = int(raw.maxSourceBytes, DEFAULT_CONFIG.maxSourceBytes, 1024, 4 * 1024 * 1024)
  cfg.budgetMode = raw.budgetMode === 'strict' ? 'strict' : DEFAULT_CONFIG.budgetMode
  cfg.subagentIsolation = bool(raw.subagentIsolation, DEFAULT_CONFIG.subagentIsolation)

  cfg.instructionsEnabled = bool(raw.instructionsEnabled, DEFAULT_CONFIG.instructionsEnabled)
  cfg.managedInstructionFiles = strList(raw.managedInstructionFiles, DEFAULT_CONFIG.managedInstructionFiles)
  cfg.includeDefaultManagedFiles = bool(raw.includeDefaultManagedFiles, DEFAULT_CONFIG.includeDefaultManagedFiles)
  cfg.userInstructionFiles = strList(raw.userInstructionFiles, DEFAULT_CONFIG.userInstructionFiles)
  cfg.userMemoryFile = str(raw.userMemoryFile, DEFAULT_CONFIG.userMemoryFile)
  cfg.ensureUserMemoryFile = bool(raw.ensureUserMemoryFile, DEFAULT_CONFIG.ensureUserMemoryFile)
  cfg.projectInstructionFiles = strList(raw.projectInstructionFiles, DEFAULT_CONFIG.projectInstructionFiles)
  cfg.rulesDirName = str(raw.rulesDirName, DEFAULT_CONFIG.rulesDirName)
  cfg.importsEnabled = bool(raw.importsEnabled, DEFAULT_CONFIG.importsEnabled)
  cfg.maxImportDepth = int(raw.maxImportDepth, DEFAULT_CONFIG.maxImportDepth, 0, 16)
  cfg.allowExternalImports = bool(raw.allowExternalImports, DEFAULT_CONFIG.allowExternalImports)
  cfg.expandImportsInNativeFiles = bool(raw.expandImportsInNativeFiles, DEFAULT_CONFIG.expandImportsInNativeFiles)
  cfg.instructionMaxBytes = int(raw.instructionMaxBytes, DEFAULT_CONFIG.instructionMaxBytes, 1024, 4 * 1024 * 1024)

  cfg.writeToolName = str(raw.writeToolName, DEFAULT_CONFIG.writeToolName)
  cfg.readToolName = str(raw.readToolName, DEFAULT_CONFIG.readToolName)
  cfg.forgetToolName = str(raw.forgetToolName, DEFAULT_CONFIG.forgetToolName)
  cfg.commandsEnabled = bool(raw.commandsEnabled, DEFAULT_CONFIG.commandsEnabled)
  cfg.memoryCommandName = str(raw.memoryCommandName, DEFAULT_CONFIG.memoryCommandName).replace(/^\//, '')

  const env = process.env || {}
  if (bool(env[DISABLE_AUTO_MEMORY_ENV], false)) cfg.autoMemoryEnabled = false
  if (bool(env[DISABLE_INSTRUCTIONS_ENV], false)) cfg.instructionsEnabled = false
  cfg.memoryRoot = str(env[MEMORY_ROOT_ENV], cfg.memoryRoot)

  return cfg
}
