/**
 * 纯函数工具箱：frontmatter、字节/行截断、HTML 注释剥离、`@path` 扫描、glob。
 * 本文件不触碰 ctx / fs 服务，全部可单测。
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------- 哈希与 slug

export function sha1Hex(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

/** CC 的主题文件名形如 `user_role.md`；此处统一成 `<type>_<slug>` 的素材。 */
export function slugify(name) {
  const s = String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return s === '' ? 'memory' : s
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/**
 * 解析 YAML frontmatter 的**平铺键值子集**（CC 的记忆 frontmatter 只用 `type`/`modified`
 * 这类标量，`paths` 也允许逗号或数组写法，故此处额外支持 `[a, b]` 与 `- item` 列表）。
 * 无法解析时按「没有 frontmatter」处理，绝不抛错。
 */
export function parseFrontmatter(text) {
  const src = String(text == null ? '' : text)
  const m = FRONTMATTER_RE.exec(src)
  if (!m) return { attrs: {}, hasFrontmatter: false, body: src }
  const attrs = {}
  const lines = m[1].split(/\r?\n/)
  let listKey = null
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item && listKey) {
      if (!Array.isArray(attrs[listKey])) attrs[listKey] = []
      attrs[listKey].push(unquote(item[1].trim()))
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value === '') {
      listKey = key
      attrs[key] = []
      continue
    }
    listKey = null
    if (value.startsWith('[') && value.endsWith(']')) {
      attrs[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter((v) => v !== '')
      continue
    }
    attrs[key] = unquote(value)
  }
  return { attrs, hasFrontmatter: true, body: src.slice(m[0].length) }
}

function unquote(value) {
  const v = String(value)
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** 序列化平铺 frontmatter；空对象返回空串（即不加 frontmatter）。 */
export function serializeFrontmatter(attrs) {
  const keys = Object.keys(attrs).filter((k) => {
    const v = attrs[k]
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
  })
  if (keys.length === 0) return ''
  const lines = keys.map((k) => {
    const v = attrs[k]
    return Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`
  })
  return `---\n${lines.join('\n')}\n---\n`
}

// ---------------------------------------------------------------- 字节与行

export function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

/** UTF-8 安全截断：不切断多字节字符（CC 的 4 MiB 上限处理同款要求）。 */
export function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8')
  if (buf.length <= maxBytes) return String(text)
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/**
 * CC 的索引预算语义：**前 N 行或前 M 字节，先到者为准**。
 * 返回 `{ text, truncated, lines, bytes }`。
 */
export function headBudget(text, maxLines, maxBytes) {
  const src = String(text == null ? '' : text)
  const allLines = src.split(/\r?\n/)
  let truncated = false
  let kept = allLines.slice(0, maxLines)
  if (kept.length < allLines.length) truncated = true
  let out = kept.join('\n')
  if (byteLength(out) > maxBytes) {
    out = truncateUtf8(out, maxBytes)
    truncated = true
  }
  // 行数统计以**实际保留**的内容为准（截断可能发生在行中间）。
  const lines = out === '' ? 0 : out.split(/\r?\n/).length
  return { text: out, truncated, lines, bytes: byteLength(out) }
}

// ---------------------------------------------------------------- HTML 注释

/**
 * 块级 HTML 注释在注入前剥离；代码块（``` / ~~~ 围栏）内保留。
 * 行内代码里出现的 `<!--` 属罕见边界，按注释剥离处理（与「先剥注释」的整体语义一致）。
 */
export function stripHtmlComments(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const out = []
  let inFence = false
  let inComment = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inComment && /^(```+|~~~+)/.test(trimmed)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const startedInComment = inComment
    let cur = line
    let result = ''
    for (;;) {
      if (inComment) {
        const end = cur.indexOf('-->')
        if (end < 0) {
          cur = ''
          break
        }
        cur = cur.slice(end + 3)
        inComment = false
        continue
      }
      const start = cur.indexOf('<!--')
      if (start < 0) {
        result += cur
        break
      }
      result += cur.slice(0, start)
      cur = cur.slice(start + 4)
      inComment = true
    }
    // 整行都被跨行注释吃掉时，连它占的那一行一起删掉（否则会留下一串空行）。
    if (startedInComment && result === '') continue
    out.push(result)
  }
  return out.join('\n')
}

/**
 * 逐行返回「剥掉块级 HTML 注释与围栏代码块之后」的文本，**行数与原文本严格一致**
 * （被吃掉的行留空串占位，不删行）。
 *
 * 存在的唯一理由是让 bullet 解析不被注释骗到：自动创建的用户级表头是 HTML 注释，
 * 里面为了人类可读写了几行 `- ...`；如果解析器只看行首前缀，就会把表头当成记忆条目
 * 列出来、甚至允许被 `remove()` 删掉。同时又不能像 `stripHtmlComments` 那样删行——
 * `remove()` 要靠行号回到原文 splice，行号必须对得上。
 */
export function visibleContentLines(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const out = []
  let inFence = false
  let inComment = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inComment && /^(```+|~~~+)/.test(trimmed)) {
      inFence = !inFence
      out.push('')
      continue
    }
    if (inFence) {
      out.push('')
      continue
    }
    let cur = line
    let result = ''
    for (;;) {
      if (inComment) {
        const end = cur.indexOf('-->')
        if (end < 0) {
          cur = ''
          break
        }
        cur = cur.slice(end + 3)
        inComment = false
        continue
      }
      const start = cur.indexOf('<!--')
      if (start < 0) {
        result += cur
        break
      }
      result += cur.slice(0, start)
      cur = cur.slice(start + 4)
      inComment = true
    }
    out.push(result)
  }
  return out
}

// ---------------------------------------------------------------- @path 导入

/**
 * 扫描 `@path` 导入（CC 语义，见 docs/claude-code-memory-mechanism.md 第 2 节）：
 *   - 跳过围栏代码块与行内代码内的 `@...`；
 *   - 双引号包裹的路径**不**导入；
 *   - 路径不得含空白（一个 token）；
 *   - 去重后按出现顺序返回。
 */
export function scanImportPaths(text) {
  const found = []
  const seen = new Set()
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  let inFence = false
  for (let line of lines) {
    const trimmed = line.trim()
    if (/^(```+|~~~+)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // 去掉行内代码后再扫，避免 `@README` 被当成导入。
    line = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    const re = /(^|[\s(])@([^\s@]+)/g
    let m
    while ((m = re.exec(line)) !== null) {
      const raw = m[2]
      if (raw.startsWith('"') || raw.startsWith("'")) continue
      const candidate = raw.replace(/[.,;:)\]]+$/, '')
      if (candidate === '' || candidate.includes('"')) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      found.push(candidate)
    }
  }
  return found
}

// ---------------------------------------------------------------- glob

const RE_SPECIAL = /[.+^${}()|[\]\\]/g

function escapeRe(ch) {
  return ch.replace(RE_SPECIAL, '\\$&')
}

function segmentToRegExp(segment) {
  let out = ''
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeRe(ch)
  }
  return out
}

function compileSegments(segments) {
  if (segments.length === 0) return ''
  const [head, ...rest] = segments
  if (head === '**') {
    const tail = compileSegments(rest)
    return tail === '' ? '.*' : `(?:[^/]*/)*${tail}`
  }
  const tail = compileSegments(rest)
  return tail === '' ? segmentToRegExp(head) : `${segmentToRegExp(head)}/${tail}`
}

/** 大括号展开（`*.{ts,tsx}`），带总预算保护（CC：整个 paths 列表共享 1000 个展开模式）。 */
export function expandBraces(pattern, budget = 1000) {
  const out = []
  const stack = [String(pattern)]
  while (stack.length > 0 && out.length < budget) {
    const p = stack.pop()
    const m = /\{([^{}]*)\}/.exec(p)
    if (!m) {
      out.push(p)
      continue
    }
    for (const alt of m[1].split(',')) {
      stack.push(p.slice(0, m.index) + alt.trim() + p.slice(m.index + m[0].length))
    }
  }
  return out
}

export function globToRegExp(pattern) {
  const normalized = String(pattern)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  const segments = normalized.split('/').filter((s) => s !== '')
  const body = compileSegments(segments)
  if (body === '') return /^$/
  // 无斜杠的模式（如 `*.ts`）按“任意深度”匹配，契合 gitignore 风格的直觉。
  if (!normalized.includes('/')) return new RegExp(`(?:^|/)${body}$`)
  return new RegExp(`^${body}$`)
}

export function matchesAnyGlob(patterns, candidates) {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (const raw of list) {
    for (const pat of expandBraces(raw)) {
      if (pat === '') continue
      const re = globToRegExp(pat)
      for (const c of candidates) {
        if (typeof c === 'string' && c !== '' && re.test(c)) return true
      }
    }
  }
  return false
}

/** 把绝对路径转成相对某个根的 posix 风格相对路径；不在根之下返回 undefined。 */
export function relativePosix(root, absolute) {
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
  const a = String(absolute).replace(/\\/g, '/')
  if (a === r) return ''
  if (!a.startsWith(`${r}/`)) return undefined
  return a.slice(r.length + 1)
}

// ---------------------------------------------------------------- 其它

export function dedupeStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

// ---------------------------------------------------------------- 会话归属

/**
 * 从各种可能形态里取出 DSH 会话头部：`agent.session.header` / `agent.header` / `agent.session`。
 * 字段缺失一律返回 null（调用方据此放行，绝不因读不到头部而误判）。
 */
export function sessionHeaderOf(source) {
  try {
    if (!source) return null
    if (source.session && source.session.header) return source.session.header
    if (source.header) return source.header
    if (source.session) return source.session
    return source
  } catch {
    return null
  }
}

/**
 * 是否**明确**是子代理会话。判据只看两个字段（不把 `parentSession` 当依据）：
 *   - `header.origin === 'subagent'`，或
 *   - `header.delegationDepth > 0`
 *
 * 依据：DSH 会话头部里「子代理」是 `origin: 'subagent'` + `delegationDepth: 1`，而
 * 「一键接续」派生的**接续会话**是 `delegationDepth: 0` + `origin` 缺省 —— 后者是用户
 * 真实会话，绝不能因为带 `parentSession` 就被排除。字段缺失一律放行（安全优先）。
 *
 * CC 语义（docs/claude-code-memory-mechanism.md 第 4 节）：主对话的**自动记忆**不加载进
 * 子代理，唯一例外是 fork；指令文件（CLAUDE.md 族）在子代理中照常加载。
 */
export function isSubagentSession(source) {
  const header = sessionHeaderOf(source)
  if (!header) return false
  try {
    if (String(header.origin || '') === 'subagent') return true
    const depth = Number(header.delegationDepth)
    if (Number.isFinite(depth) && depth > 0) return true
  } catch {
    return false
  }
  return false
}

/** 记忆条目计数启发式，照抄 CC `LE5`（chunks.97.mjs:2495-2514）。 */
export function countMemoryEntries(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t.startsWith('-') || t.startsWith('*') || /^\s*\d+\./.test(line)
    }).length
}
