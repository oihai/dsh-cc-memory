/**
 * 自写记忆层的存储层：`MEMORY.md` 索引 + 每记忆一个主题文件。
 *
 * 与 CC 对齐的硬约束（docs/claude-code-memory-mechanism.md 第 4 节）：
 *   - 索引行的**具体格式**官方文档未定义 → 本插件自定义为
 *       `- **<name>** (<type>) — <summary> `<file>``
 *     单行、可 grep、与主题文件名一一对应。
 *   - 主题文件在会话开始时**完全不加载**，由模型按需 Read。
 *   - `modified` 只在**已有 frontmatter** 的文件被写入时刷新；永远不会给
 *     没有 frontmatter 的文件凭空加上 frontmatter。
 *   - 索引预算「前 200 行或前 25 KB，先到者为准」；写入后**重新测量**，
 *     超预算时写入仍然成功，但返回值要求模型精简索引（CC 的行为）。
 */
import path from 'node:path'
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises'
import {
  byteLength,
  countMemoryEntries,
  headBudget,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
} from './util.js'

export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

export const INDEX_FILE = 'MEMORY.md'
export const INDEX_HEADING = '# Memory index'

const INDEX_LINE_RE_CACHE = new Map()

/**
 * 索引行的定位正则。
 *
 * ★ 必须**限制在单行内**（`[^\n]*?`，不是 `[\s\S]*?`）：索引里每条记忆都占一行，用跨行
 * 惰性匹配会让「找 user_role.md 那一行」从**上一条记忆**的开头开始匹配、一路吃到目标行，
 * 于是 upsert 会把中间若干条记忆一起替换掉、remove 会把它们一起删掉——静默丢数据。
 * 这个 bug 是被 `index keeps other lines` 用例抓出来的。
 */
function indexLineRe(file) {
  let re = INDEX_LINE_RE_CACHE.get(file)
  if (!re) {
    re = new RegExp(
      `^-\\s*\\*\\*[^*]+\\*\\*\\s*\\([^)]*\\)\\s*—[^\\n]*?\`${escapeForRe(file)}\`[ \\t]*$`,
      'm',
    )
    INDEX_LINE_RE_CACHE.set(file, re)
  }
  return re
}

function escapeForRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Windows 上 rename 覆盖已存在文件时的瞬时失败码（目标被别的句柄打开）。 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
let tmpCounter = 0

/**
 * 原子写：先写临时文件再 rename，避免宿主在写入中途读到半个文件。
 *
 * Windows 的 `rename` 覆盖已存在文件时，只要目标被任何句柄打开就会**瞬时**报
 * `EPERM`/`EACCES`/`EBUSY` —— 触发者可能是宿主并发读到该文件、杀毒或索引器扫过、
 * 也可能是本插件紧接着的下一次写入。这不是逻辑错误，所以做有限次退避重试；
 * 重试用尽才把原始错误抛给调用方（写失败必须是显式的，不能静默丢记忆）。
 */
export async function writeFileAtomic(target, content) {
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  tmpCounter += 1
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`)
  await writeFile(tmp, content, 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target)
      return
    } catch (error) {
      if (attempt >= 20 || !RENAME_RETRY_CODES.has(error && error.code)) {
        await unlink(tmp).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
    }
  }
}

export async function readTextOrEmpty(target) {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

export class MemoryStore {
  /**
   * @param {string} dir 记忆目录（默认工作区内的 `<锚点>/.cc-memory`；`memoryRootMode: 'dsh-home'` 时是 `<memoryRoot>/projects/<projectKey>/memory`）
   * @param {{ indexMaxLines: number, indexMaxBytes: number }} budget
   */
  constructor(dir, budget) {
    this.dir = dir
    this.budget = budget
  }

  get indexPath() {
    return path.join(this.dir, INDEX_FILE)
  }

  topicPath(file) {
    return path.join(this.dir, file)
  }

  /** 主题文件名：`<type>_<slug>.md`，已带 type 前缀时沿用。 */
  topicFileFor(name, type) {
    const slug = slugify(name)
    if (slug.startsWith(`${type}_`)) return `${slug}.md`
    return `${type}_${slug}.md`
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true })
  }

  async readIndex() {
    return readTextOrEmpty(this.indexPath)
  }

  /** 注入用索引：按「前 N 行或前 M 字节」裁剪。 */
  async readIndexForInjection() {
    const raw = await this.readIndex()
    const head = headBudget(raw, this.budget.indexMaxLines, this.budget.indexMaxBytes)
    return { ...head, total: raw, entries: countMemoryEntries(raw) }
  }

  async listTopicFiles() {
    try {
      const names = await readdir(this.dir)
      return names.filter((n) => n.endsWith('.md') && n !== INDEX_FILE).sort()
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async readTopic(file) {
    return readTextOrEmpty(this.topicPath(file))
  }

  /**
   * 写入/追加一条记忆。
   * @param {{ name: string, type: string, content: string, summary?: string, mode?: 'create'|'append'|'replace', now?: Date }} input
   * @returns {Promise<object>} 供工具回显的结构化结果
   */
  async writeMemory(input) {
    const name = String(input.name || '').trim()
    const type = MEMORY_TYPES.includes(input.type) ? input.type : 'project'
    const content = String(input.content == null ? '' : input.content).trim()
    if (name === '') throw new Error('memory name is required')
    if (content === '') throw new Error('memory content is required')

    await this.ensureDir()
    const file = this.topicFileFor(name, type)
    const target = this.topicPath(file)
    const existingRaw = await readTextOrEmpty(target)
    const existing = parseFrontmatter(existingRaw)
    const existed = existingRaw !== ''

    const mode = input.mode === 'replace' || input.mode === 'create' ? input.mode : existed ? 'append' : 'create'
    if (mode === 'create' && existed) {
      throw new Error(`memory file ${file} already exists; use mode=append or mode=replace`)
    }

    let body
    if (mode === 'replace' || !existed) body = content
    else body = `${existing.body.replace(/\s+$/, '')}\n\n${content}`

    // `modified` 只在本来就带 frontmatter 的文件上刷新（CC 的硬约束）。
    const attrs = { type }
    if (!existed || existing.hasFrontmatter) {
      attrs.modified = (input.now instanceof Date ? input.now : new Date()).toISOString()
    }
    const nextText = `${serializeFrontmatter(attrs)}${body.replace(/\s+$/, '')}\n`
    await writeFileAtomic(target, nextText)

    // 摘要选取（索引行是会话启动**唯一**会注入的东西，选错等于把记忆的主旨换掉）：
    //   - 显式给了 summary → 用它；
    //   - mode=append 且索引里已有这一行 → **沿用旧摘要**。否则摘要会变成「刚追加那一段」
    //     的首句，把记忆原本的主旨顶掉（`feedback_user_memory_autocreate` 上真踩过）；
    //   - 其余情况（create / replace / append 但索引行不存在）→ 用**全文**正文的首句，
    //     而不是本次 content 片段的首句。
    const explicitSummary = String(input.summary || '').trim()
    let summary = explicitSummary
    if (summary === '') {
      const prior = mode === 'append' ? await this.readIndexSummary(file) : ''
      summary = prior !== '' ? prior : firstSentence(body)
    }
    const indexResult = await this.upsertIndexLine({ name, type, summary, file })

    return {
      file,
      path: target,
      mode: existed ? mode : 'create',
      type,
      bytes: byteLength(nextText),
      index: indexResult,
    }
  }

  /**
   * @deprecated 保留旧名以免破坏调用方；行为已改为「删文件 + 摘索引行」。
   * 原先的实现只把主题文件写成空串，会在索引里留下一条指向空文件的孤儿行。
   */
  async removeMemory(name, type) {
    return this.forgetMemory({ name, type })
  }

  /**
   * 彻底删除一条记忆：删主题文件 + 从索引里摘掉那一行。
   *
   * 这是「索引超预算就精简：合并或删除陈旧条目」这条纠偏话术必须有的能力——
   * CC 的 `/memory` 允许直接编辑文件达到同一效果，本插件给模型一个工具入口，
   * 避免它只能靠 `mode=replace` 把正文清空却在索引里留下孤儿行。
   *
   * @param {{ name: string, type?: string }} input
   * @returns {Promise<object>} `{ removed, file, path, index }`
   */
  async forgetMemory(input) {
    const name = String((input && input.name) || '').trim()
    if (name === '') throw new Error('memory name is required')
    const requested = input && MEMORY_TYPES.includes(input.type) ? input.type : ''
    // 不指定 type 时逐个候选找第一个真实存在的文件（read 工具用同一顺序）。
    const candidates = requested ? [requested] : MEMORY_TYPES
    let file = ''
    for (const type of candidates) {
      const candidate = this.topicFileFor(name, type)
      if ((await readTextOrEmpty(this.topicPath(candidate))) !== '') {
        file = candidate
        break
      }
    }
    if (file === '') {
      const files = await this.listTopicFiles()
      return {
        removed: false,
        file: '',
        reason: `no memory named "${name}" exists`,
        available: files,
      }
    }

    const target = this.topicPath(file)
    await unlink(target).catch((error) => {
      if (!error || error.code !== 'ENOENT') throw error
    })
    const indexResult = await this.removeIndexLine(file)
    return { removed: true, file, path: target, index: indexResult }
  }

  /** 摘掉索引里指向 `file` 的那一行；文件空了则连标题一起清掉。 */
  async removeIndexLine(file) {
    const before = await this.readIndex()
    const re = indexLineRe(file)
    let after = before
    if (re.test(before)) {
      after = before.replace(re, '').replace(/\n{3,}/g, '\n\n')
      // 只剩标题（没有任何条目行）时，把索引还原成空文件，避免留一个空壳。
      if (after.trim() === INDEX_HEADING) after = ''
      await writeFileAtomic(this.indexPath, after)
    }
    return this.describeIndex(after)
  }

  /** 把一份索引文本折算成工具回显需要的度量（与 upsertIndexLine 的返回结构同形）。 */
  describeIndex(text) {
    const head = headBudget(text, this.budget.indexMaxLines, this.budget.indexMaxBytes)
    return {
      path: this.indexPath,
      totalLines: text === '' ? 0 : text.split(/\r?\n/).length,
      totalBytes: byteLength(text),
      injectedLines: head.lines,
      injectedBytes: head.bytes,
      overBudget: head.truncated,
      entries: countMemoryEntries(text),
      limit: { maxLines: this.budget.indexMaxLines, maxBytes: this.budget.indexMaxBytes },
    }
  }

  /**
   * 读回某个主题文件当前在索引里的摘要。索引行不存在或不成形时返回空串。
   * 用于 append 时**保住原有摘要**，别让追加把索引行改成追加片段的首句。
   */
  async readIndexSummary(file) {
    const text = await this.readIndex()
    const m = text.match(indexLineRe(file))
    if (!m) return ''
    // 摘要本身可能含反引号，所以从「行尾那个 `<file>`」往回切：只有它前面才紧贴行尾。
    const parts = m[0].match(/—\s*([\s\S]*?)\s*`[^`]*`\s*$/)
    return parts ? parts[1].trim() : ''
  }

  /**
   * 索引行 upsert：按文件名匹配旧行替换，找不到就追加。
   * 索引超预算时**仍然写入成功**，只把超限事实回报给调用方（CC 行为）。
   */
  async upsertIndexLine({ name, type, summary, file }) {
    const before = await this.readIndex()
    const line = `- **${name}** (${type}) — ${summary} \`${file}\``
    let after
    const re = indexLineRe(file)
    if (re.test(before)) {
      after = before.replace(re, line)
    } else {
      const base = before.trim() === '' ? `${INDEX_HEADING}\n` : before.replace(/\s+$/, '')
      after = `${base}\n${line}\n`
    }
    await writeFileAtomic(this.indexPath, after)
    return this.describeIndex(after)
  }
}

/** 取正文第一句当默认索引摘要（无摘要参数时的兜底）。 */
export function firstSentence(text) {
  const flat = String(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return 'memory'
  let cut = -1
  for (let i = 0; i < flat.length; i += 1) {
    const ch = flat[i]
    // 中文句末标点无条件断句（中文不加空格）。
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
      cut = i
      break
    }
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ';') continue
    // 英文句末标点：后面必须是空白或行尾，否则是版本号/域名/方法调用里的点（`v0.1.0`、`Node.js`、`a.b()`）。
    const next = flat[i + 1]
    if (next !== undefined && !/\s/.test(next)) continue
    // 前面是单个字母的按缩写处理（`e.g.`、`i.e.`、`U.S.`），不断句。
    const word = (flat.slice(0, i).match(/[A-Za-z]+$/) || [''])[0]
    if (word.length === 1) continue
    cut = i
    break
  }
  const raw = cut > 0 ? flat.slice(0, cut) : flat
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw
}
