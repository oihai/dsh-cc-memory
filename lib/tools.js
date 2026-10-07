/**
 * 专用记忆工具——「主模型持有专用记忆工具、自主调用」是本项目选定的唯一写入触发通路。
 *
 * 与 CC v1.0.33 的关系（docs/cc-memory-write-mechanism-evidence.md 第 3 节）：
 * CC 当时的 `#` 通路是**用户触发**的，且写入交给一次隔离的 LLM 调用 + 强制 Write 工具；
 * 主模型自身**没有任何自动写路径**。本插件按用户定向改为「主模型直接持有工具」，
 * 保留的是 CC 的三条硬约束：只增不改既有内容、写入是纯落盘、写后重新测量索引预算。
 *
 * 工具定义是手构的（不 import `@deepseek-ai/dsh-tools`），形态与运行中的第三方插件一致：
 * `{ name, description, parameters, output: { schema, render }, execute }`。
 */
import { byteLength } from './util.js'
import { MEMORY_TYPES } from './store.js'
import { MEMORY_SCOPES, USER_SCOPE, resolveScope } from './userMemory.js'

/** 手构工具（不依赖 dsh-tools 的运行时常量）。 */
function defineTool({ name, description, parameters, execute }) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    const prop = { type: spec.type || 'string', description: spec.description || '' }
    if (spec.enum) prop.enum = spec.enum
    if (spec.items) prop.items = spec.items
    properties[key] = prop
    if (spec.required) required.push(key)
  }
  return {
    name,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const result = await execute(args && typeof args === 'object' ? args : {}, exec)
      return typeof result === 'string' ? result : JSON.stringify(result)
    },
  }
}

export function formatBudgetNotice(index, mode, cfg) {
  if (!index) return ''
  const forget = cfg && cfg.forgetToolName ? `\`${cfg.forgetToolName}\`` : 'the forget tool'
  if (!index.overBudget) {
    return `Index now ${index.totalLines} lines / ${index.totalBytes} bytes (${index.entries} entries).`
  }
  const head =
    `WARNING: MEMORY.md now exceeds the injection budget (limit ${index.limit.maxLines} lines / ` +
    `${index.limit.maxBytes} bytes; the file is ${index.totalLines} lines / ${index.totalBytes} bytes). ` +
    `The write succeeded, but only the first ${index.injectedLines} lines / ${index.injectedBytes} bytes ` +
    `are loaded at session start.`
  const fix =
    'Condense the index now: keep one line per memory, move detail out of the index into the memory body, ' +
    `and merge or delete stale entries (delete with ${forget}).`
  return mode === 'strict' ? `${head} ${fix} (strict budget mode: rewrite MEMORY.md before adding more.)` : `${head} ${fix}`
}

/**
 * 三道闸门，三个记忆工具共用：
 *   1. 插件总闸 / 自写层开关；
 *   2. 子代理隔离（CC 语义：主对话的自动记忆不加载进子代理）。
 * 直接 `throw` 而不是返回错误串——DSH 会把工具异常作为工具结果回给模型，模型能读到原因。
 */
function guardMemoryAccess(cfg, st) {
  if (!cfg.enabled || !cfg.autoMemoryEnabled) {
    throw new Error('cc-memory: auto memory is disabled by configuration')
  }
  if (st && st.isolated) {
    throw new Error(
      'cc-memory: this is a subagent session, where the parent conversation\'s auto memory is deliberately ' +
        'unavailable (Claude Code semantics). Report what you learned back to the parent conversation and let it ' +
        'decide what to remember.',
    )
  }
}

/**
 * @param {{ cfg: any, sessionFor: (exec: any) => any, refresh: (st: any) => void }} deps
 */
export function defineWriteTool(deps) {
  const { cfg, sessionFor, refresh } = deps
  return defineTool({
    name: cfg.writeToolName,
    description:
      'Save one durable memory that should survive into future conversations (Claude Code compatible auto memory). ' +
      'Two storage scopes: `workspace` (the default for most types) writes a topic file under the workspace ' +
      '`.cc-memory/` directory and keeps the one-line `MEMORY.md` index in sync; `user` appends a single bullet to ' +
      'the user-level `CLAUDE.md` under the harness home (`<DSH_HOME>/CLAUDE.md`), with no index — that file is ' +
      'injected whole, exactly like Claude Code\'s `#` → `~/.claude/CLAUDE.md` path. When `scope` is omitted, ' +
      '`type: "user"` routes to the user-level file and every other type routes to the workspace. ' +
      'Use a short stable `name` so the same topic updates in place instead of piling up. ' +
      'Never store secrets, credentials, or tokens.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Short topic id, e.g. "user_role" or "feedback_testing". Reuse it to update the same memory.',
      },
      type: {
        type: 'string',
        required: true,
        enum: [...MEMORY_TYPES],
        description:
          'user = who the user is; feedback = guidance about how to work; project = ongoing work not derivable from code; ' +
          'reference = pointers to external resources.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The memory body in Markdown. Facts only, no commentary about the act of remembering.',
      },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description:
          'workspace = a topic file plus a `MEMORY.md` index line (default for feedback/project/reference); ' +
          'user = one bullet appended to `<DSH_HOME>/CLAUDE.md` (default for type=user). Explicit value wins.',
      },
      summary: {
        type: 'string',
        description: 'One-line index entry. Defaults to the first sentence of `content`. Workspace scope only.',
      },
      mode: {
        type: 'string',
        enum: ['create', 'append', 'replace'],
        description:
          'append (default when the memory exists) adds to the body; replace overwrites the body; create fails if it exists.',
      },
    },
    async execute(args, exec) {
      const st = sessionFor(exec)
      guardMemoryAccess(cfg, st)
      const scope = resolveScope(args.type, args.scope)
      if (scope === USER_SCOPE) {
        const result = await st.userMemory.append(args.content)
        refresh(st)
        const how =
          result.mode === 'deduped'
            ? 'That bullet already exists verbatim, so nothing was added.'
            : `Appended as a bullet (${result.mode}).`
        return [
          `Saved memory "${args.name}" (${args.type}, scope=user) to ${result.file}`,
          how,
          'This file is injected whole as user-level instructions — no index is kept for user-scope memories.',
        ].join('\n')
      }
      const result = await st.store.writeMemory({
        name: args.name,
        type: args.type,
        content: args.content,
        summary: args.summary,
        mode: args.mode,
      })
      refresh(st)
      const notice = formatBudgetNotice(result.index, cfg.budgetMode, cfg)
      return [
        `Saved memory "${args.name}" (${result.type}, mode=${result.mode}) to ${result.path}`,
        `Index: ${result.index.path}`,
        notice,
      ]
        .filter((line) => line !== '')
        .join('\n')
    },
  })
}

/**
 * @param {{ cfg: any, sessionFor: (exec: any) => any }} deps
 */
export function defineReadTool(deps) {
  const { cfg, sessionFor } = deps
  return defineTool({
    name: cfg.readToolName,
    description:
      'Read the full body of one stored memory by `name`, or list every memory and the raw `MEMORY.md` index when ' +
      '`name` is omitted. Only the index is loaded automatically at session start; use this to pull a memory body on demand. ' +
      'User-scope memories live as bullets in `<DSH_HOME>/CLAUDE.md` and have no name or topic file — pass ' +
      '`scope: "user"` to read that file, or omit `name` to list both scopes.',
    parameters: {
      name: {
        type: 'string',
        description: 'Topic id used when the memory was written. Omit to list all memories.',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Optional; used to resolve the topic file name when two types share a name.',
      },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description: 'workspace = topic files under `.cc-memory/`; user = the bullet list in `<DSH_HOME>/CLAUDE.md`.',
      },
    },
    async execute(args, exec) {
      const st = sessionFor(exec)
      guardMemoryAccess(cfg, st)
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (args.scope === USER_SCOPE) {
        const text = await st.userMemory.read()
        const bullets = await st.userMemory.list()
        return [
          `User-scope memory file: ${st.userMemory.file}`,
          `Entries: ${bullets.length}`,
          '',
          text.trim() === '' ? '(empty)' : text.trim(),
        ].join('\n')
      }
      if (name === '') {
        const index = await st.store.readIndex()
        const files = await st.store.listTopicFiles()
        const userBullets = await st.userMemory.list()
        return [
          `Memory directory: ${st.store.dir}`,
          '',
          'Topic files:',
          ...(files.length === 0 ? ['(none yet)'] : files.map((f) => `- ${f}`)),
          '',
          'MEMORY.md:',
          index.trim() === '' ? '(empty)' : index.trim(),
          '',
          `User-scope memories (${st.userMemory.file}):`,
          ...(userBullets.length === 0 ? ['(none yet)'] : userBullets.map((b) => `- ${b.text}`)),
        ].join('\n')
      }
      for (const type of args.type ? [args.type] : MEMORY_TYPES) {
        const file = st.store.topicFileFor(name, type)
        const text = await st.store.readTopic(file)
        if (text !== '') {
          return `Memory "${name}" (${file}) — ${byteLength(text)} bytes\n\n${text.trim()}`
        }
      }
      const files = await st.store.listTopicFiles()
      throw new Error(
        `No memory named "${name}" was found. Available: ${files.length === 0 ? '(none)' : files.join(', ')}. ` +
          `User-scope memories have no name — read them with scope: "${USER_SCOPE}".`,
      )
    },
  })
}

/**
 * 删除工具。存在理由：索引超预算时的纠偏话术要求模型「合并或删除陈旧条目」，
 * 而 CC 的 `/memory` 允许直接编辑文件达到同一效果——本插件必须给模型等价的能力，
 * 否则它只能把正文清空、在索引里留下孤儿行。
 *
 * 「删除」在本插件里是**不可逆**的（CC 靠用户手动编辑，有回收余地）；因此工具描述里
 * 明确要求先确认该记忆确实过时，并且删除结果会把删掉的文件名回显出来。
 *
 * @param {{ cfg: any, sessionFor: (exec: any) => any, refresh: (st: any) => void }} deps
 */
export function defineForgetTool(deps) {
  const { cfg, sessionFor, refresh } = deps
  return defineTool({
    name: cfg.forgetToolName,
    description:
      'Delete one stored memory permanently: removes its topic file and the matching `MEMORY.md` index line. ' +
      'For user-scope memories (bullets in `<DSH_HOME>/CLAUDE.md`) pass `scope: "user"` and give the **exact bullet ' +
      'text** as `name`; that bullet is then removed from the file. ' +
      'Use this only for memories that are stale, wrong, or superseded — especially when a memory write reported ' +
      'that the index is over budget and needs to be condensed. Merging is usually better than deleting: write the ' +
      'merged result with `' +
      cfg.writeToolName +
      '` (mode=replace) first, then delete the redundant entries.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description:
          'Topic id of the memory to delete, as used with `' +
          cfg.writeToolName +
          '`. With `scope: "user"`, this is the exact bullet text instead (user-scope memories have no name).',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Optional; only needed to disambiguate when two memories of different types share a name.',
      },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description: 'workspace (default) deletes a topic file + its index line; user deletes one bullet from `<DSH_HOME>/CLAUDE.md`.',
      },
    },
    async execute(args, exec) {
      const st = sessionFor(exec)
      guardMemoryAccess(cfg, st)
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') throw new Error('memory name (or, for scope=user, the exact bullet text) is required')
      const scope = resolveScope(args.type, args.scope)
      if (scope === USER_SCOPE) {
        const result = await st.userMemory.remove(name)
        if (!result.removed) {
          const available = Array.isArray(result.available) ? result.available : []
          throw new Error(
            `No user-scope bullet matching "${name}" was found in ${result.file}. ` +
              `Existing bullets: ${available.length === 0 ? '(none)' : `\n- ${available.join('\n- ')}`}`,
          )
        }
        refresh(st)
        return `Deleted the user-scope bullet from ${result.file}\n- ${result.text}`
      }
      const result = await st.store.forgetMemory({ name, type: args.type })
      if (!result.removed) {
        const available = Array.isArray(result.available) ? result.available : []
        throw new Error(
          `No memory named "${name}" was found. Available: ${available.length === 0 ? '(none)' : available.join(', ')}`,
        )
      }
      refresh(st)
      const notice = formatBudgetNotice(result.index, cfg.budgetMode, cfg)
      return [`Deleted memory "${name}" (${result.file}) at ${result.path}`, notice].filter((l) => l !== '').join('\n')
    },
  })
}
