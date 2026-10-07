/**
 * DSH「类 Claude Code 记忆」插件 —— Host 半入口。
 *
 * 两条通路，分别对应 CC 的两层记忆（docs/claude-code-memory-mechanism.md 第 1 节）：
 *   A. 自写记忆层（全部自建）：`MEMORY.md` 索引常驻 + 主题文件按需 + 四类型 frontmatter
 *      + 200 行 / 25 KB 注入预算与写入后纠偏；写入由主模型持有的专用工具触发
 *      （`cc_memory_write` / `cc_memory_read` / `cc_memory_forget`），另给 `/memory` 检视命令。
 *   B. 人写指令层（只补 CC 独有缺口）：托管层、用户级 `<dshHome>/CLAUDE.md`、
 *      `./.claude/CLAUDE.md`、`.claude/rules/`（含 `paths` 条件规则）、`@path` 导入。
 *      用户级记忆文件由本插件在启动时**自动创建**（用户 2026-10-07 定向；见下方 ensureSync 段）。
 *
 * 子代理隔离（CC 语义）：`origin === 'subagent'` 或 `delegationDepth > 0` 的会话不注入
 * `MEMORY.md`，其记忆工具也拒绝写入；指令文件照常加载。判据只看这两个字段，不看
 * `parentSession`——「一键接续」派生的接续会话带 parentSession 但仍是用户会话。
 *
 * 注入通道：`ctx.systemPrompt.context()` —— 渲染成 user-role 快照追加在历史尾部，
 * 与 CC 把 CLAUDE.md 作为「system prompt 之后的 user message」注入的机理一致
 * （CC 的 `Ie1(A,B)`，chunks.94.mjs:564-578）；内容不变时 DSH 的 agent-loop 会去重，
 * 因此 system prompt 保持字节级稳定，不击穿前缀缓存。
 *
 * 本插件不 import 任何 `@deepseek-ai/*` 运行时包（profile 的 node_modules 里只有
 * `schemastery`/`cosmokit`，`cordis`/`dsh-tools` 不可解析），全部自持。
 */
import path from 'node:path'
import { resolveConfig } from './config.js'
import { MemoryStore } from './store.js'
import { memoryDirFor, projectIdentity, resolveDshHome, workspaceMemoryDir } from './paths.js'
import { collectInstructionBlocks, ruleMatchesTouched } from './instructions.js'
import { defineForgetTool, defineReadTool, defineWriteTool } from './tools.js'
import { UserMemoryFile, userMemoryPath } from './userMemory.js'
import { defineMemoryCommand } from './commands.js'
import { isSubagentSession } from './util.js'

export const name = 'cc-memory'

/** `tools` 与 `systemPrompt` 是硬依赖；其余能力一律可选探测。 */
export const inject = ['tools', 'systemPrompt']

/** 排在同为 10000 的第三方记忆插件之后，保证我们的块整体靠后（更具体）。 */
const CONTEXT_ORDER = 10100
const SECTION_ORDER = 10100

const STATIC_DISCIPLINE = `# Memory

You have persistent, file-based memory that survives across conversations, compatible with Claude Code's auto memory. Three tools:

- \`cc_memory_write\` — save a memory. Give it a short \`name\` (a topic id such as \`user_role\` or \`feedback_testing\`), a \`type\`, and the body. It appends by default and keeps the \`MEMORY.md\` index in sync.
- \`cc_memory_read\` — read one memory's full body by \`name\`, or list every memory when \`name\` is omitted.
- \`cc_memory_forget\` — delete one memory permanently when it is stale, wrong, or superseded.

Write a memory when the information will still matter in a later conversation and cannot be re-derived by reading the repository:

- \`user\` — who the user is: role, expertise, durable preferences.
- \`feedback\` — guidance the user gave about how you should work, corrections included.
- \`project\` — ongoing work, goals, deadlines, or constraints that the code does not reveal.
- \`reference\` — pointers to external resources (URLs, dashboards, tickets).

Do not save: anything you can re-derive from the repository, and anything an instruction file (CLAUDE.md / AGENTS.md) already states. Never save secrets, credentials, or tokens.

Only \`MEMORY.md\` is loaded at session start, and only its first 200 lines / 25 KB. Keep each index entry to one line and put the detail in the memory body. When a write reports the index is over budget, condense the index before adding more.`

const SUBAGENT_NOTE =
  'Subagents do not receive the parent conversation\'s memory, and cannot write to it (Claude Code semantics). ' +
  'Report findings back to the parent conversation instead of saving them here.'

const DISCLAIMER =
  'IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context ' +
  'or otherwise consider it in your response unless it is highly relevant to your task. Most of the time, it is not relevant.'

const TOUCH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'paths', 'files']

function asArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const dshHome = resolveDshHome(cfg.dshHome)
  /** DSH_HOME 模式（`memoryRootMode: 'dsh-home'`）的记忆根；工作区模式不使用它。 */
  const dshHomeMemoryRoot = path.join(dshHome, 'cc-memory')

  /**
   * 该会话的记忆目录。优先级：显式 `memoryRoot` → `memoryRootMode`
   * （`'workspace'`＝工作区内 `.cc-memory/`，默认；`'dsh-home'`＝`<DSH_HOME>/cc-memory/projects/<key>/memory`）。
   */
  function memoryDirForCwd(cwd, identity) {
    if (cfg.memoryRoot) return memoryDirFor(cfg.memoryRoot, identity.key)
    if (cfg.memoryRootMode === 'dsh-home') return memoryDirFor(dshHomeMemoryRoot, identity.key)
    return workspaceMemoryDir(cwd)
  }

  /** @type {Map<object, any>} agent → per-session state */
  const sessions = new Map()
  /** @type {Array<() => void>} */
  const disposers = []

  function sessionFor(execOrAgent) {
    const agent = execOrAgent && execOrAgent.agent ? execOrAgent.agent : execOrAgent
    const key = agent && typeof agent === 'object' ? agent : { __cwdOnly: true }
    let st = sessions.get(key)
    if (st) return st
    let cwd = ''
    try {
      cwd = (agent && agent.session && agent.session.header && agent.session.header.cwd) || ''
    } catch {
      cwd = ''
    }
    if (cwd === '') cwd = process.cwd()
    const identity = projectIdentity(cwd)
    const store = new MemoryStore(memoryDirForCwd(cwd, identity), {
      indexMaxLines: cfg.indexMaxLines,
      indexMaxBytes: cfg.indexMaxBytes,
    })
    // 用户级记忆：`<DSH_HOME>/CLAUDE.md`，bullet 追加、不建索引（用户 2026-10-07 定向）。
    const userMemory = new UserMemoryFile(userMemoryPath(dshHome, cfg))
    // CC 语义：主对话的自动记忆不加载进子代理，其记忆工具也一并拒绝（指令层不受影响）。
    const isolated = cfg.subagentIsolation && isSubagentSession(agent)
    st = {
      agent,
      cwd,
      identity,
      store,
      userMemory,
      isolated,
      touched: new Set(),
      pendingRules: [],
      text: '',
      dirty: true,
      refreshing: false,
      error: '',
    }
    sessions.set(key, st)
    return st
  }

  function compose(st, instructionBlocks, index) {
    const parts = []
    if (st.isolated) {
      // 子代理：只保留指令层，并明确告诉它为什么这里没有记忆。
      parts.push('## Claude Code instruction files (loaded by dsh-cc-memory)')
      for (const block of instructionBlocks) {
        parts.push(`### ${block.label}\n${block.text}`)
      }
      parts.push(`### note\n${SUBAGENT_NOTE}`)
      const body = parts.join('\n\n').replaceAll('</system-reminder>', '<\\/system-reminder>')
      return `<system-reminder>\n${body}\n\n${DISCLAIMER}\n</system-reminder>`
    }
    if (instructionBlocks.length > 0) {
      parts.push('## Claude Code instruction files (loaded by dsh-cc-memory)')
      for (const block of instructionBlocks) {
        parts.push(`### ${block.label}\n${block.text}`)
      }
    }
    if (index.text.trim() !== '') {
      parts.push('## Memory index (MEMORY.md)')
      parts.push(index.text.trim())
      if (index.truncated) {
        parts.push(
          `_(index truncated for injection: limit ${cfg.indexMaxLines} lines / ${cfg.indexMaxBytes} bytes; ` +
            `file is ${index.entries} entries. Read a memory body with \`cc_memory_read\`.)_`,
        )
      }
      parts.push(`Memory directory: ${st.store.dir}`)
    }
    if (parts.length === 0) return ''
    const body = parts.join('\n\n').replaceAll('</system-reminder>', '<\\/system-reminder>')
    return `<system-reminder>\n${body}\n\n${DISCLAIMER}\n</system-reminder>`
  }

  async function refresh(st) {
    if (st.refreshing) {
      st.dirty = true
      return
    }
    st.refreshing = true
    try {
      do {
        st.dirty = false
        let blocks = []
        if (cfg.enabled && cfg.instructionsEnabled) {
          const collected = await collectInstructionBlocks({
            cwd: st.cwd,
            dshHome: dshHome,
            config: cfg,
            touched: [...st.touched],
          })
          blocks = collected.blocks
          st.pendingRules = collected.conditionalPending
        } else {
          st.pendingRules = []
        }
        let index = { text: '', truncated: false, entries: 0 }
        if (cfg.enabled && cfg.autoMemoryEnabled && !st.isolated) {
          index = await st.store.readIndexForInjection()
        }
        st.text = compose(st, blocks, index)
        st.error = ''
      } while (st.dirty)
    } catch (error) {
      st.error = error && error.message ? error.message : String(error)
    } finally {
      st.refreshing = false
    }
  }

  function kick(st) {
    void refresh(st).catch(() => {})
  }

  // ------------------------------------------------------------ 工具
  const toolDeps = { cfg, sessionFor, refresh: kick }
  try {
    disposers.push(ctx.tools.register(defineWriteTool(toolDeps)))
    disposers.push(ctx.tools.register(defineReadTool(toolDeps)))
    disposers.push(ctx.tools.register(defineForgetTool(toolDeps)))
  } catch (error) {
    ctx.logger?.warn?.(`cc-memory: failed to register tools: ${error && error.message}`)
  }

  // ------------------------------------------------------------ `/memory` 命令（可选依赖）
  try {
    const commands = ctx.get ? ctx.get('commands') : undefined
    if (commands && typeof commands.register === 'function') {
      const definition = defineMemoryCommand({ cfg, sessionFor })
      if (definition) disposers.push(commands.register(definition))
    }
  } catch (error) {
    ctx.logger?.warn?.(`cc-memory: failed to register /${cfg.memoryCommandName}: ${error && error.message}`)
  }

  // ------------------------------------------------------------ 用户级记忆文件（自动创建）
  // 用户 2026-10-07 定向：`<DSH_HOME>/CLAUDE.md` 由本插件负责创建与维护，不要求用户手工建。
  // 同步执行 ⇒ `apply()` 返回时文件必定已存在；已存在则一个字节都不动。
  if (cfg.enabled && cfg.autoMemoryEnabled && cfg.ensureUserMemoryFile) {
    const ensured = new UserMemoryFile(userMemoryPath(dshHome, cfg)).ensureSync()
    if (ensured.mode === 'created') {
      ctx.logger?.info?.(`cc-memory: created user-level memory file ${ensured.file}`)
    } else if (ensured.mode === 'error') {
      ctx.logger?.warn?.(`cc-memory: failed to create user-level memory file: ${ensured.error}`)
    }
  }

  // ------------------------------------------------------------ 静态纪律段
  if (cfg.enabled) {
    try {
      disposers.push(
        ctx.systemPrompt.section({
          name: 'dsh:cc-memory:discipline',
          order: SECTION_ORDER,
          text: () => STATIC_DISCIPLINE,
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.(`cc-memory: failed to register static section: ${error && error.message}`)
    }
  }

  // ------------------------------------------------------------ 动态上下文注入
  try {
    disposers.push(
      ctx.systemPrompt.context({
        name: 'dsh:cc-memory',
        order: CONTEXT_ORDER,
        text: (context) => {
          try {
            const agent = context && context.agent
            if (!agent) return ''
            const st = sessionFor(agent)
            if (st.dirty && !st.refreshing) kick(st)
            return st.text || ''
          } catch {
            return ''
          }
        },
      }),
    )
  } catch (error) {
    ctx.logger?.warn?.(`cc-memory: failed to register context surface: ${error && error.message}`)
  }

  // ------------------------------------------------------------ 生命周期接线
  const onSessionStart = (payload) => {
    try {
      const agent = payload && payload.agent ? payload.agent : payload
      if (!agent || typeof agent !== 'object') return
      kick(sessionFor(agent))
    } catch {
      /* 绝不因记忆插件打断会话启动 */
    }
  }
  ctx.on('agent/session-start', onSessionStart)
  ctx.on('agent/created', onSessionStart)

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload && payload.agent ? payload.agent : payload
      if (agent && typeof agent === 'object') sessions.delete(agent)
    } catch {
      /* ignore */
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      if (!session) return
      for (const [key, st] of sessions) {
        if (key && key.session === session) sessions.delete(key)
      }
    } catch {
      /* ignore */
    }
  })

  // 触达更深目录 / 命中条件规则：`tools/result` 是最早能看到「刚读写过哪个文件」的持久点。
  ctx.on('tools/result', (exec) => {
    try {
      const agent = exec && exec.agent
      if (!agent || typeof agent !== 'object') return
      const st = sessionFor(agent)
      const args = (exec && (exec.arguments || exec.args || exec.input)) || {}
      const gained = []
      for (const key of TOUCH_KEYS) {
        for (const value of asArray(args[key])) {
          if (typeof value !== 'string' || value === '') continue
          const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(st.cwd, value)
          if (!st.touched.has(abs)) {
            st.touched.add(abs)
            gained.push(abs)
          }
        }
      }
      if (gained.length === 0) return
      if (st.pendingRules && st.pendingRules.length > 0) {
        const hit = st.pendingRules.some((rule) => ruleMatchesTouched(rule, gained, st.identity.root, [st.cwd]))
        if (hit) {
          st.dirty = true
          kick(st)
        }
      }
    } catch {
      /* ignore */
    }
  })

  disposers.push(
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
        sessions.clear()
      },
      'cc-memory:teardown',
    ),
  )

  ctx.logger?.info?.(
    `cc-memory: ready (memory ${cfg.memoryRoot ? `root ${cfg.memoryRoot}` : `in workspace .cc-memory/ (mode ${cfg.memoryRootMode})`}; ` +
      `auto memory ${cfg.autoMemoryEnabled ? 'on' : 'off'}; ` +
      `instructions ${cfg.instructionsEnabled ? 'on' : 'off'}; subagent isolation ` +
      `${cfg.subagentIsolation ? 'on' : 'off'}; /${cfg.memoryCommandName} ${cfg.commandsEnabled ? 'on' : 'off'})`,
  )
}
