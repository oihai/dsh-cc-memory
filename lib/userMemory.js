/**
 * 用户级记忆（`scope: 'user'`）——**直接追加 bullet 到 `<DSH_HOME>/CLAUDE.md`，不建索引**。
 *
 * 用户 2026-10-07 定向的落盘规则：
 *   - 工作区级 → `<工作区>/.cc-memory/`（索引 + 主题文件，见 store.js）；
 *   - 用户级   → `<DSH_HOME>/CLAUDE.md`（本文件）。
 *
 * 为什么是「追加 bullet、不建索引」：这正是 CC v1.0.33 `#` 通路的原始形态
 * （docs/cc-memory-write-mechanism-evidence.md 第 4 节）——作用域 User 映射到 `~/.claude/CLAUDE.md`，
 * 写入 prompt 的硬约束是 `ONLY add new content - NEVER modify or remove existing content`。
 * 该文件同时是本插件指令层的用户级指令文件
 * （instructions.js 的 `userInstructionFiles`：`<dshHome>/CLAUDE.md`），所以写进去的记忆会被
 * 指令层整份注入——与 CC 把 CLAUDE.md 作为 user message 注入完全同构，无需再造一套注入通道。
 *
 * 与 CC 的一处有意偏离（用户 2026-10-07 定向）：**文件由本插件在启动时自动创建**
 * （`ensureSync()`，不等第一次写入），且创建时写一段 HTML 注释表头而不是留空文件。
 * 因为表头是注释、注入前被剥掉，所以「自动创建」不会带来任何上下文开销；
 * 代价是首条写入不再落在 CC 那个「空文件直接写 bullet、不加标题」的分支上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readTextOrEmpty, writeFileAtomic } from './store.js'
import { visibleContentLines } from './util.js'

/** 记忆作用域。 */
export const MEMORY_SCOPES = Object.freeze(['workspace', 'user'])
export const WORKSPACE_SCOPE = 'workspace'
export const USER_SCOPE = 'user'

/**
 * 自动创建用户级记忆文件时写入的表头（用户 2026-10-07 定向：该文件由本插件自动创建维护）。
 *
 * 用 HTML 注释包住是有意的：`stripHtmlComments` 在注入前剥掉它，剥完为空则整块不注入
 * （instructions.js:149-150 / 187-188），所以这个文件**在没有真实记忆条目时对上下文零占用**，
 * 同时又对人（编辑器里打开）是自解释的。绝不能用 markdown 标题——那会被整份注入进每次会话。
 */
export const USER_MEMORY_HEADER = `<!--
本文件由 dsh-cc-memory 插件的用户级记忆层维护，无需手工创建。

- 写入方式：一条记忆一个 "- " 开头的条目（bullet），追加在末尾；不建索引、不排序。
- 只增不改：插件绝不改写或删除既有内容（包括你手写的任何东西）。
- 删除方式：cc_memory_forget(scope: "user", name: "<条目正文>")，精确匹配才删。
- 本文件同时是用户级指令文件，会整份注入每次会话；本段注释在注入前即被剥离，
  因此在没有真实条目时本文件不占用任何上下文。

（可在下方直接手写内容，插件只会在末尾追加条目。）
-->
`

/** bullet 行：`- text` / `* text`（CC 的条目计数启发式同样认这两个前缀与 `N.`）。 */
const BULLET_RE = /^\s*[-*]\s+(.*)$/

/**
 * 记忆该落到哪一层：**显式 `scope` 优先，缺省时按 `type` 兜底**
 * （`type: 'user'` → 用户级，其余 → 工作区级）。用户 2026-10-07 选定的「两者结合」。
 */
export function resolveScope(type, scope) {
  if (scope === USER_SCOPE || scope === WORKSPACE_SCOPE) return scope
  return type === USER_SCOPE ? USER_SCOPE : WORKSPACE_SCOPE
}

/** 用户级记忆文件：`<DSH_HOME>/<userMemoryFile>`，默认 `CLAUDE.md`。 */
export function userMemoryPath(dshHome, cfg) {
  const name = cfg && typeof cfg.userMemoryFile === 'string' && cfg.userMemoryFile.trim() !== ''
    ? cfg.userMemoryFile.trim()
    : 'CLAUDE.md'
  return path.join(dshHome, name)
}

/** bullet 内容压成单行：记忆条目是 bullet，多行正文会被 markdown 拆成多个列表项。 */
export function flattenBullet(content) {
  return String(content == null ? '' : content)
    .replace(/\s*\r?\n+\s*/g, ' ')
    .trim()
}

/**
 * 解析出全部 bullet 及其所在行号（行号 0 基）。
 * 跳过块级 HTML 注释与围栏代码块内的 `- xxx`——自动创建的表头就是注释，
 * 绝不能被当条目列出或删除（`visibleContentLines` 保行号，故 line 仍可回原文 splice）。
 */
export function parseBullets(text) {
  const out = []
  const lines = visibleContentLines(text)
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(BULLET_RE)
    if (m && m[1].trim() !== '') out.push({ line: i, text: m[1].trim() })
  }
  return out
}

/** 用户级记忆文件：只做「追加 bullet / 读 / 精确删」三件事，不维护任何索引。 */
export class UserMemoryFile {
  /**
   * @param {string} file 绝对路径（`<DSH_HOME>/CLAUDE.md`）
   */
  constructor(file) {
    this.file = file
  }

  async read() {
    return readTextOrEmpty(this.file)
  }

  async list() {
    return parseBullets(await this.read())
  }

  /**
   * 确保文件存在（用户 2026-10-07 定向：由插件自动创建）。
   * 文件已存在且非空时**一个字节都不动**；不存在或为空时写入 `USER_MEMORY_HEADER`。
   *
   * 用同步 I/O 是有意的：这是一次性启动动作、体积是一个小文件，同步换来的是
   * 「`apply()` 返回时文件必定已存在」这条可断言、可测的硬保证。
   * @returns {{ file: string, mode: 'created'|'exists'|'error', error?: string }}
   */
  ensureSync() {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(this.file, 'utf8')
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
      if (existing !== '') return { file: this.file, mode: 'exists' }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, USER_MEMORY_HEADER, 'utf8')
      return { file: this.file, mode: 'created' }
    } catch (error) {
      return { file: this.file, mode: 'error', error: error && error.message ? error.message : String(error) }
    }
  }

  /**
   * 追加一条 bullet。已存在完全相同的条目时**不重复追加**（幂等）。
   * @returns {Promise<{ file: string, mode: 'create'|'append'|'deduped', text: string }>}
   */
  async append(content) {
    const text = flattenBullet(content)
    if (text === '') throw new Error('memory content is required')
    const existing = await this.read()
    if (parseBullets(existing).some((b) => b.text === text)) {
      return { file: this.file, mode: 'deduped', text }
    }
    const line = `- ${text}`
    const created = existing.trim() === ''
    // 文件为空/不存在 ⇒ 直接写 bullet（CC 原始语义，不加标题）；
    // 否则把新 bullet 追加在末尾——正常情况下文件已被 `ensureSync()` 建好并带注释表头，
    // 所以走的是这一支，表头原样保留。
    const body = created ? `${line}\n` : `${existing.replace(/\s*$/, '')}\n\n${line}\n`
    await writeFileAtomic(this.file, body)
    return { file: this.file, mode: created ? 'create' : 'append', text }
  }

  /**
   * 删掉正文**完全等于** `text` 的那条 bullet（用户级记忆没有 name，故用正文定位）。
   * 找不到时返回 `{ removed: false, available }`，由调用方决定怎么报错。
   */
  async remove(text) {
    const wanted = flattenBullet(text)
    if (wanted === '') throw new Error('memory text is required')
    const existing = await this.read()
    const hit = parseBullets(existing).find((b) => b.text === wanted)
    if (!hit) return { removed: false, file: this.file, available: parseBullets(existing).map((b) => b.text) }
    const lines = existing.split(/\r?\n/)
    lines.splice(hit.line, 1)
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    await writeFileAtomic(this.file, body === '' ? '' : `${body}\n`)
    return { removed: true, file: this.file, text: wanted }
  }
}
