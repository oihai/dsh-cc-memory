/**
 * 人写指令层——**只补 DSH 原生加载器不做的部分**。
 *
 * 原生 `@deepseek-ai/dsh-agent-instructions`（lib/index.js:17-18、141）已经负责：
 *   - 项目根（`.git` 标记）→ cwd 逐级 `AGENTS.md` / `CLAUDE.md`，宽泛→具体拼接；
 *   - 同目录 `AGENTS.local.md` / `CLAUDE.local.md` overlay；
 *   - 用户级 `<dshHome>/AGENTS.md`；
 *   - 惰性追加、同目录内容去重、超预算截断。
 *
 * 本文件因此**明确不做**以上任何一条**（否则同一份 CLAUDE.md 会被注入两次）**，只补：
 *   1. 托管/策略层 CLAUDE.md（优先级最高、不可排除）；
 *   2. 用户级 `<dshHome>/CLAUDE.md`（原生只认该目录的 AGENTS.md）；
 *   3. `./.claude/CLAUDE.md`（原生只看目录直接子文件，不下钻 `.claude/`）；
 *   4. `.claude/rules/**.md`：无 `paths` 者启动即载，有 `paths` 者为条件规则；
 *   5. `@path` 导入展开（4 跳，跳过代码块，引号路径不导入）。
 */
import path from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import {
  byteLength,
  dedupeStrings,
  expandBraces,
  matchesAnyGlob,
  parseFrontmatter,
  relativePosix,
  stripHtmlComments,
  truncateUtf8,
} from './util.js'
import { defaultManagedInstructionFiles, findGitRoot } from './paths.js'

const MAX_WALK_DEPTH = 8

async function statType(target) {
  try {
    const info = await stat(target)
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
  } catch {
    return undefined
  }
}

async function readIfFile(target, maxBytes) {
  const type = await statType(target)
  if (type !== 'file') return undefined
  try {
    const text = await readFile(target, 'utf8')
    if (byteLength(text) > maxBytes) return undefined
    return text
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------ @path 导入展开

async function resolveImportToken(raw, fromFile, ctx) {
  if (ctx.depth >= ctx.maxDepth) return undefined
  const candidate = String(raw).replace(/[.,;:)\]]+$/, '')
  if (candidate === '' || candidate.includes('"') || candidate.includes("'")) return undefined
  const resolved = path.resolve(path.dirname(fromFile), candidate)
  if (ctx.visited.has(resolved)) return undefined
  const rel = relativePosix(ctx.rootDir, resolved)
  if (rel === undefined && !ctx.allowExternal) return undefined
  const content = await readIfFile(resolved, ctx.maxBytes)
  if (content === undefined) return undefined
  const nextVisited = new Set(ctx.visited)
  nextVisited.add(resolved)
  const nested = await expandImportsInText(stripHtmlComments(content), resolved, {
    ...ctx,
    depth: ctx.depth + 1,
    visited: nextVisited,
  })
  // 就地内联，且**不加**额外标记：CC 在注入前会剥离全部块级 HTML 注释
  // （见 docs/claude-code-memory-mechanism.md 第 2 节），加 HTML 注释形式的标记等于白加。
  return `\n${nested.trim()}\n`
}

async function substituteSegment(segment, fromFile, ctx) {
  const re = /(^|[\s(])@([^\s@]+)/g
  const jobs = []
  let m
  while ((m = re.exec(segment)) !== null) {
    jobs.push({ start: m.index, end: re.lastIndex, prefix: m[1], raw: m[2] })
  }
  if (jobs.length === 0) return segment
  let out = ''
  let last = 0
  for (const job of jobs) {
    out += segment.slice(last, job.start) + job.prefix
    last = job.end
    const replacement = await resolveImportToken(job.raw, fromFile, ctx)
    out += replacement === undefined ? `@${job.raw}` : replacement
  }
  return out + segment.slice(last)
}

async function substituteLine(line, fromFile, ctx) {
  const segments = line.split(/(`[^`]*`)/)
  const out = []
  for (const segment of segments) {
    if (segment.length > 1 && segment.startsWith('`') && segment.endsWith('`')) {
      out.push(segment)
      continue
    }
    out.push(await substituteSegment(segment, fromFile, ctx))
  }
  return out.join('')
}

/** 逐行展开导入；围栏代码块内原样保留（CC 同款语义）。 */
export async function expandImportsInText(text, filePath, ctx) {
  if (!ctx.enabled) return text
  const lines = String(text).split(/\r?\n/)
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^(```+|~~~+)/.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(await substituteLine(line, filePath, ctx))
  }
  return out.join('\n')
}

// ------------------------------------------------------------ 指令文件收集

function makeImportContext({ rootDir, config }) {
  return {
    enabled: config.importsEnabled === true,
    depth: 0,
    maxDepth: config.maxImportDepth,
    allowExternal: config.allowExternalImports === true,
    maxBytes: config.maxSourceBytes,
    rootDir,
    visited: new Set(),
  }
}

async function loadInstructionFile(file, { label, rootDir, config }) {
  const raw = await readIfFile(file, config.maxSourceBytes)
  if (raw === undefined) return undefined
  const expanded = await expandImportsInText(raw, file, makeImportContext({ rootDir, config }))
  const stripped = stripHtmlComments(expanded)
  if (stripped.trim() === '') return undefined
  const text = truncateUtf8(stripped.trim(), config.instructionMaxBytes)
  return { label, file, text, truncated: byteLength(stripped.trim()) > config.instructionMaxBytes }
}

/** 递归发现规则目录下的 .md（CC：递归发现，无 paths 者启动即载）。 */
async function walkMarkdown(dir, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkMarkdown(target, out, depth + 1)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(target)
  }
}

/**
 * 收集规则文件：无 `paths` frontmatter 者进 unconditional，有者进 conditional。
 * frontmatter 在载入前删除，且**只读 `paths` 一个字段**（CC 同款）。
 */
async function collectRules(rulesDir, { rootDir, config }) {
  const unconditional = []
  const conditional = []
  const files = []
  await walkMarkdown(rulesDir, files)
  for (const file of files) {
    const raw = await readIfFile(file, config.maxSourceBytes)
    if (raw === undefined) continue
    const parsed = parseFrontmatter(raw)
    const patterns = normalizePathsValue(parsed.attrs.paths)
    const expanded = await expandImportsInText(parsed.body, file, makeImportContext({ rootDir, config }))
    const text = stripHtmlComments(expanded).trim()
    if (text === '') continue
    const rel = relativePosix(rootDir, file) || path.basename(file)
    const label = rel.replace(/\\/g, '/')
    const entry = {
      label,
      file,
      text: truncateUtf8(text, config.instructionMaxBytes),
    }
    if (patterns.length > 0) conditional.push({ ...entry, patterns })
    else unconditional.push(entry)
  }
  return { unconditional, conditional }
}

function normalizePathsValue(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v !== '')
  const single = String(value).trim()
  if (single === '') return []
  return single
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** CC 的预算：整个 `paths` 列表共享 1000 个展开模式 + 4 MiB。此处只做展开数保护。 */
export function expandRulePatterns(patterns, budget = 1000) {
  const out = []
  for (const pattern of patterns) {
    for (const expanded of expandBraces(pattern, Math.max(1, budget - out.length))) out.push(expanded)
    if (out.length >= budget) break
  }
  return out
}

/**
 * 一条条件规则是否被触碰的路径激活。
 * @param {{patterns: string[]}} rule
 * @param {string[]} touched 本次会话已触达的绝对路径
 * @param {string} rootDir 用于把绝对路径折成相对 glob 可匹配的形式
 */
export function ruleMatchesTouched(rule, touched, rootDir, extraRoots = []) {
  const patterns = expandRulePatterns(rule.patterns)
  if (patterns.length === 0) return false
  const candidates = []
  for (const abs of touched) {
    const rel = relativePosix(rootDir, abs)
    if (rel !== undefined && rel !== '') candidates.push(rel)
    for (const root of extraRoots) {
      const alt = relativePosix(root, abs)
      if (alt !== undefined && alt !== '') candidates.push(alt)
    }
    candidates.push(String(abs).replace(/\\/g, '/'))
  }
  return matchesAnyGlob(patterns, candidates)
}

// ------------------------------------------------------------ 主入口

/**
 * 汇总本插件负责的指令块（宽泛 → 具体）。
 * @param {{ cwd: string, dshHome: string, config: any, touched?: string[] }} input
 * @returns {Promise<{ blocks: Array<{label: string, file: string, text: string}>, conditionalPending: Array<object> }>}
 */
export async function collectInstructionBlocks({ cwd, dshHome, config, touched = [] }) {
  const blocks = []
  const seen = new Set()
  const gitRoot = findGitRoot(cwd) || cwd
  const rootBase = gitRoot
  const roots = dedupeStrings([config.rulesDirName])

  const push = (block) => {
    if (!block) return
    const key = path.resolve(block.file)
    if (seen.has(key)) return
    seen.add(key)
    blocks.push(block)
  }

  // 1) 托管/策略层：优先级最高，不可排除。
  const managedFiles = dedupeStrings([
    ...config.managedInstructionFiles,
    ...(config.includeDefaultManagedFiles === false ? [] : defaultManagedInstructionFiles()),
  ])
  for (const file of managedFiles) {
    push(await loadInstructionFile(file, { label: `managed: ${path.basename(file)}`, rootDir: rootBase, config }))
  }

  // 2) 用户级 CLAUDE.md（原生只认 <dshHome>/AGENTS.md）。
  for (const name of config.userInstructionFiles) {
    const file = path.join(dshHome, name)
    push(await loadInstructionFile(file, { label: `user: ${name}`, rootDir: dshHome, config }))
  }

  // 3) 项目根：规则目录 + `.claude/CLAUDE.md`。
  const pending = []
  const rulesRoot = path.join(gitRoot, roots[0])
  const rootRules = await collectRules(rulesRoot, { rootDir: gitRoot, config })
  for (const rule of rootRules.unconditional) push(rule)
  for (const rule of rootRules.conditional) {
    if (ruleMatchesTouched(rule, touched, gitRoot)) push(rule)
    else pending.push(rule)
  }
  for (const rel of config.projectInstructionFiles) {
    const file = path.join(gitRoot, rel)
    push(await loadInstructionFile(file, { label: `project: ${rel.replace(/\\/g, '/')}`, rootDir: gitRoot, config }))
  }

  // 4) cwd（与项目根不同的目录）：规则目录 + `.claude/CLAUDE.md`。
  const resolvedCwd = path.resolve(cwd)
  if (resolvedCwd !== path.resolve(gitRoot)) {
    const rulesCwd = path.join(resolvedCwd, roots[0])
    const cwdRules = await collectRules(rulesCwd, { rootDir: resolvedCwd, config })
    for (const rule of cwdRules.unconditional) push(rule)
    for (const rule of cwdRules.conditional) {
      if (ruleMatchesTouched(rule, touched, resolvedCwd)) push(rule)
      else pending.push(rule)
    }
    for (const rel of config.projectInstructionFiles) {
      const file = path.join(resolvedCwd, rel)
      push(await loadInstructionFile(file, { label: `cwd: ${rel.replace(/\\/g, '/')}`, rootDir: resolvedCwd, config }))
    }
  }

  return { blocks, conditionalPending: pending, gitRoot }
}
