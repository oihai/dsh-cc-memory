/**
 * `/memory` 检视命令。
 *
 * 对应关系（docs/claude-code-memory-mechanism.md 第 5 节 + cc-memory-write-mechanism-evidence.md 第 5 节）：
 *   - CC v1.0.33 的 `/memory` 是 `type: "local-jsx"` 命令，列出已知 CLAUDE.md（含从
 *     `readFileState` 里扫出来的**嵌套**文件），再用 `$EDITOR`/`$VISUAL` 打开供用户编辑；
 *   - 本插件不接管宿主编辑器，也不改宿主 UI，因此命令落在**检视**这一半：
 *     打印记忆目录、`MEMORY.md` 索引与主题文件清单；给参数则打印那一条记忆的全文。
 *
 * 注册走 `commands` Service（可选依赖）：`register(definition)` 返回 disposer。
 * 命令 result 的形态由宿主契约固定：
 *   `{ kind: 'success', text? } | { kind: 'error', text }`。
 */
import { byteLength } from './util.js'
import { MEMORY_TYPES } from './store.js'

/** 概览文本：记忆目录 + 索引 + 主题文件清单。纯函数式，便于离线单测。 */
export async function memoryOverview(store, cfg) {
  const index = await store.readIndex()
  const files = await store.listTopicFiles()
  const lines = [`Memory directory: ${store.dir}`, '']

  if (files.length === 0) {
    lines.push('No memories stored yet.')
  } else {
    lines.push(`Memories (${files.length}):`)
    for (const file of files) {
      const text = await store.readTopic(file)
      lines.push(`- ${file} (${byteLength(text)} bytes)`)
    }
  }

  lines.push('', `MEMORY.md${index.trim() === '' ? ' (empty)' : ''}:`)
  lines.push(index.trim() === '' ? '(empty)' : index.trim())
  if (index.trim() !== '') {
    lines.push(
      '',
      `Only the first ${cfg.indexMaxLines} lines / ${cfg.indexMaxBytes} bytes of MEMORY.md are loaded into a ` +
        'conversation; the topic files above are never loaded automatically.',
    )
  }
  return lines.join('\n')
}

/** 一条记忆的全文（按 type 顺序探测文件名，与 `cc_memory_read` 同序）。 */
async function readOne(store, name, type) {
  for (const candidate of type ? [type] : MEMORY_TYPES) {
    const file = store.topicFileFor(name, candidate)
    const text = await store.readTopic(file)
    if (text !== '') return { file, text }
  }
  return null
}

/**
 * @param {{ cfg: any, sessionFor: (agent: any) => any }} deps
 * @returns {object|null} CommandDefinition，或 null（未启用）
 */
export function defineMemoryCommand(deps) {
  const { cfg, sessionFor } = deps
  if (!cfg.enabled || !cfg.commandsEnabled) return null
  return {
    name: cfg.memoryCommandName,
    description: 'Show the memory directory, the MEMORY.md index, and every stored memory (/memory <name> for one).',
    input: { hint: '[name]' },
    async handler(invocation) {
      try {
        const st = sessionFor(invocation && invocation.agent)
        if (!cfg.autoMemoryEnabled) {
          return { kind: 'error', text: 'cc-memory: auto memory is disabled by configuration.' }
        }
        if (st.isolated) {
          return {
            kind: 'error',
            text:
              'cc-memory: this is a subagent session, which has no access to the parent conversation\'s auto ' +
              'memory (Claude Code semantics).',
          }
        }
        // `rawInput` 的两种可能口径都容忍：纯参数（'user_role'），或整行（'/memory user_role'）。
        let arg = String((invocation && invocation.rawInput) || '').trim()
        const slash = `/${cfg.memoryCommandName}`
        if (arg.toLowerCase().startsWith(`${slash.toLowerCase()} `)) arg = arg.slice(slash.length).trim()
        else if (arg.toLowerCase() === slash.toLowerCase()) arg = ''
        if (/^".*"$/.test(arg) || /^'.*'$/.test(arg)) arg = arg.slice(1, -1).trim()
        if (arg === '') {
          return { kind: 'success', text: await memoryOverview(st.store, cfg) }
        }
        if (arg === 'dir') {
          return { kind: 'success', text: st.store.dir }
        }
        if (arg === 'index') {
          const index = await st.store.readIndex()
          return { kind: 'success', text: index.trim() === '' ? '(MEMORY.md is empty)' : index.trim() }
        }
        const one = await readOne(st.store, arg, '')
        if (!one) {
          const files = await st.store.listTopicFiles()
          return {
            kind: 'error',
            text: `No memory named "${arg}". Available: ${files.length === 0 ? '(none)' : files.join(', ')}`,
          }
        }
        return {
          kind: 'success',
          text: `Memory "${arg}" (${one.file}) — ${byteLength(one.text)} bytes\n\n${one.text.trim()}`,
        }
      } catch (error) {
        return { kind: 'error', text: `cc-memory: ${error && error.message ? error.message : String(error)}` }
      }
    },
  }
}
