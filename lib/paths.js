/**
 * 路径解析：DSH home、项目身份锚点、记忆目录、托管层指令文件默认位置。
 *
 * 项目身份锚点照抄 CC 的语义（docs/claude-code-memory-mechanism.md 第 3 节）：
 * **以 git 仓库为锚**，同一仓库的所有 worktree / 子目录共享一个记忆目录；
 * 非 git 目录退回「绝对路径哈希」，保证同一目录稳定、不同目录不串。
 *
 * 默认落盘位置由用户 2026-10-06 定向：**工作区内 `.cc-memory/`**（见 `workspaceMemoryDir`）；
 * `<DSH_HOME>/cc-memory/projects/<key>/memory` 保留为 `memoryRootMode: 'dsh-home'` 选配。
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { sha1Hex } from './util.js'

/** DSH home：优先显式配置，其次 `DSH_HOME`，最后用户目录下的 `.dsh`。 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  const env = process.env || {}
  if (env.DSH_HOME && env.DSH_HOME.trim() !== '') return path.resolve(env.DSH_HOME.trim())
  const home = env.USERPROFILE || env.HOME || process.cwd()
  return path.join(home, '.dsh')
}

/** 从 startDir 逐级向上找含 `.git` 的目录（文件或目录都算，兼容 worktree 的 `.git` 文件）。 */
export function findGitRoot(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 项目身份：`<仓库目录名>-<gitRoot 的 sha1 前 12 位>`。
 * 用哈希而非完整路径做目录名，既满足「同仓库共享」，又避免路径过深/非法字符。
 */
export function projectIdentity(cwd) {
  const start = path.resolve(cwd || process.cwd())
  const gitRoot = findGitRoot(start)
  const root = gitRoot || start
  const base = path.basename(root) || 'root'
  const suffix = sha1Hex(root).slice(0, 12)
  return { root, gitRoot, key: `${base}-${suffix}` }
}

/** 该项目的记忆目录（CC：`~/.claude/projects/<project>/memory/`）。 */
export function memoryDirFor(memoryRoot, projectKey) {
  return path.join(memoryRoot, 'projects', projectKey, 'memory')
}

/**
 * 工作区内记忆目录名。用户 2026-10-06 定向：**工作区里产生的记忆保存在工作区目录内**，
 * 于是默认落盘位置从 `<DSH_HOME>/cc-memory/projects/<key>/memory` 改为工作区内的 `.cc-memory/`。
 * 这是对 CC 布局（`~/.claude/projects/<project>/memory/`，机器本地、不进仓库）的有意偏离。
 */
export const WORKSPACE_MEMORY_DIR = '.cc-memory'

/**
 * 工作区模式的记忆目录：`<锚点>/.cc-memory`。
 * 锚点优先 **git 仓库根**（同一仓库的所有 worktree / 子目录共享一份记忆，与 CC「以仓库为锚」一致），
 * 非 git 目录退回 cwd。此处返回的就是记忆目录本身，里面直接放 `MEMORY.md` 与主题文件。
 */
export function workspaceMemoryDir(cwd) {
  const start = path.resolve(cwd || process.cwd())
  const root = findGitRoot(start) || start
  return path.join(root, WORKSPACE_MEMORY_DIR)
}

/**
 * 托管/策略层指令文件的默认候选。CC 在 Windows 上是
 * `C:\Program Files\ClaudeCode\CLAUDE.md`（见机制文档第 1 节）；该层不可被排除，
 * 故本插件把它放在加载顺序的**最前面**。
 */
export function defaultManagedInstructionFiles() {
  const files = []
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  files.push(path.join(pf, 'ClaudeCode', 'CLAUDE.md'))
  files.push(path.join(pf86, 'ClaudeCode', 'CLAUDE.md'))
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  files.push(path.join(programData, 'ClaudeCode', 'CLAUDE.md'))
  return files
}
