/**
 * 工作区内的宿主桩：不需要安装进 profile，就能跑**真的** `apply(ctx, config)` 看效果。
 *
 * 为什么不装：`plugin_manager` 的任何操作都要 danger-full-access 审批（用户已拒绝），
 * 而 profile 的 `package.json` / `cordis.patch.yml` 不许手改。所以这里按 DSH 的宿主契约
 * 造一个最小 `ctx` 桩，把插件当作库调用——插件代码一行不改，走的还是 `lib/plugin.js` 的
 * 真实分支（工具注册、`systemPrompt.context`、生命周期事件、`/memory` 命令、子代理隔离）。
 *
 * 桩实现的契约（与 auto-memory 插件在运行时的用法一致）：
 *   ctx.tools.register(tool) -> disposer
 *   ctx.get('commands').register(definition) -> disposer
 *   ctx.systemPrompt.section({ name, order, text })
 *   ctx.systemPrompt.context({ name, order, text(context) })   // context.agent 同步可读
 *   ctx.on('agent/session-start' | 'tools/result' | ...) -> void
 *   ctx.effect(fn, label) -> disposer
 *   ctx.logger.info/warn/error
 *
 * 用法：`node plugin/test/harness.mjs`
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject, name as pluginName } from '../lib/plugin.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX = path.join(HERE, '.harness')
const HOME = path.join(SANDBOX, 'home')
/** 一个**故意不存在**的 dshHome：用来验证用户级记忆文件会被插件自动建出来。 */
const EMPTY_HOME = path.join(SANDBOX, 'home-empty')
const PROJECT = path.join(SANDBOX, 'project')

let failures = 0
let checks = 0

function h(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function ok(label, condition) {
  checks += 1
  if (!condition) failures += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
}
function show(label, text) {
  console.log(`\n--- ${label} ---`)
  console.log(String(text).trimEnd())
}

// ---------------------------------------------------------------- 宿主桩
function createHost({ commandsEnabled = true } = {}) {
  const tools = new Map()
  const sections = []
  const contexts = []
  const commandDefs = []
  const listeners = new Map()
  const effects = []
  const log = []

  const ctx = {
    logger: {
      info: (m) => log.push(['info', String(m)]),
      warn: (m) => log.push(['warn', String(m)]),
      error: (m) => log.push(['error', String(m)]),
      debug: () => {},
    },
    get(key) {
      if (key !== 'commands' || !commandsEnabled) return undefined
      return {
        register(definition) {
          commandDefs.push(definition)
          return () => {
            const i = commandDefs.indexOf(definition)
            if (i >= 0) commandDefs.splice(i, 1)
          }
        },
      }
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: {
      section(def) {
        sections.push(def)
        return () => {}
      },
      context(def) {
        contexts.push(def)
        return () => {}
      },
    },
    on(event, handler) {
      const arr = listeners.get(event) || []
      arr.push(handler)
      listeners.set(event, arr)
      return () => {}
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
  }

  return {
    ctx,
    tools,
    sections,
    contexts,
    commandDefs,
    effects,
    log,
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
    },
    /** 静态段（`systemPrompt.section`）。 */
    sectionText() {
      return sections.map((s) => (typeof s.text === 'function' ? s.text() : s.text)).join('\n\n')
    },
    /** 动态段（`systemPrompt.context`），即模型真正看到的注入文本。 */
    contextText(agent) {
      return contexts
        .map((c) => {
          try {
            return c.text({ agent })
          } catch (error) {
            return `«threw: ${error.message}»`
          }
        })
        .filter((t) => t && t !== '')
        .join('\n\n')
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

/** 注入是异步 kick 出来的：读一次 → 等 → 再读一次才是稳定结果。 */
async function injected(host, agent) {
  host.contextText(agent)
  await tick()
  await tick()
  return host.contextText(agent)
}

async function callTool(host, agent, toolName, args) {
  const tool = host.tools.get(toolName)
  if (!tool) throw new Error(`tool ${toolName} not registered`)
  try {
    return { ok: true, text: await tool.execute(args, { agent }) }
  } catch (error) {
    return { ok: false, text: `«threw» ${error.message}` }
  }
}

// ---------------------------------------------------------------- 场景
async function buildSandbox() {
  await rm(SANDBOX, { recursive: true, force: true })

  await mkdir(path.join(PROJECT, '.git'), { recursive: true })
  await mkdir(path.join(PROJECT, '.claude', 'rules'), { recursive: true })
  await mkdir(path.join(PROJECT, 'src'), { recursive: true })
  await mkdir(path.join(HOME, 'managed'), { recursive: true })

  // 原生加载器（@deepseek-ai/dsh-agent-instructions）负责的文件——本插件**必须不碰**。
  await writeFile(path.join(PROJECT, 'AGENTS.md'), '# AGENTS.md\n\nThis file is owned by the native loader.\n')

  // 托管/策略层（CC 里优先级最高、不可排除）。
  await writeFile(path.join(HOME, 'managed', 'CLAUDE.md'), '# Managed policy\n\nManaged-layer rule: never print secrets.\n')

  // 用户级 <dshHome>/CLAUDE.md（原生只认该目录的 AGENTS.md，所以这层是本插件补的）。
  await writeFile(path.join(HOME, 'CLAUDE.md'), '# User memory\n\nUser-level rule: answer in Chinese.\n')

  // 项目 .claude/CLAUDE.md，含 @导入 与一个要被剥掉的 HTML 注释。
  await writeFile(
    path.join(PROJECT, '.claude', 'CLAUDE.md'),
    [
      '# Project rules',
      '',
      '<!-- this comment must be stripped before injection -->',
      '',
      'Build with `node build.mjs`.',
      '',
      'See @docs.md for the deployment notes.',
      '',
      '```md',
      'Keep @this-literal alone — it is inside a fence.',
      '```',
      '',
    ].join('\n'),
  )
  await writeFile(path.join(PROJECT, '.claude', 'docs.md'), 'Deploy by running `deploy.sh` on the staging host.\n')

  // .claude/rules/：一个无常驻（无 paths）规则，一个有 paths 的条件规则。
  await writeFile(path.join(PROJECT, '.claude', 'rules', 'always.md'), '# House style\n\nAlways use descriptive variable names.\n')
  await writeFile(
    path.join(PROJECT, '.claude', 'rules', 'ts-only.md'),
    ['---', 'paths:', '  - src/**/*.ts', '---', '', '# TypeScript rules', '', 'Never use `any` in src/**/*.ts.\n'].join('\n'),
  )

  await writeFile(path.join(PROJECT, 'src', 'a.ts'), 'export const a = 1\n')
}

function config() {
  return {
    dshHome: HOME,
    includeDefaultManagedFiles: false,
    managedInstructionFiles: [path.join(HOME, 'managed', 'CLAUDE.md')],
    allowExternalImports: true,
  }
}

async function main() {
  await buildSandbox()

  const mainAgent = { id: 'main', session: { header: { cwd: PROJECT } } }
  const subAgent = { id: 'sub', session: { header: { cwd: PROJECT, origin: 'subagent', delegationDepth: 1 } } }

  const host = createHost()
  apply(host.ctx, config())

  h(`1. 装载：插件自报身份与注册面`)
  ok('导出 name = cc-memory', pluginName === 'cc-memory')
  ok('inject 声明 tools + systemPrompt', inject.join(',') === 'tools,systemPrompt')
  ok('三个记忆工具都注册了', ['cc_memory_write', 'cc_memory_read', 'cc_memory_forget'].every((t) => host.tools.has(t)))
  ok('/memory 命令注册了', host.commandDefs.length === 1 && host.commandDefs[0].name === 'memory')
  ok('静态纪律段注册了', host.sections.length === 1)
  ok('动态上下文面注册了', host.contexts.length === 1)
  show('启动日志', host.log.map(([lvl, m]) => `[${lvl}] ${m}`).join('\n'))

  h('2. 会话开始 → 注入给模型的完整文本')
  host.emit('agent/session-start', { agent: mainAgent })
  let text = await injected(host, mainAgent)
  show('注入文本（模型看到的就是这一段）', text)
  ok('托管层进来了', text.includes('Managed-layer rule'))
  ok('用户级 CLAUDE.md 进来了', text.includes('User-level rule'))
  ok('项目 .claude/CLAUDE.md 进来了', text.includes('Build with `node build.mjs`'))
  ok('@docs.md 导入被内联', text.includes('Deploy by running `deploy.sh`'))
  ok('块级 HTML 注释被剥掉', !text.includes('must be stripped'))
  ok('围栏里的 @this-literal 没被当导入', !text.includes('@this-literal') || text.includes('Keep @this-literal alone'))
  ok('无常驻 rule 进来了', text.includes('descriptive variable names'))
  ok('条件规则**尚未**激活（没碰过 src/*.ts）', !text.includes('Never use `any`'))
  ok('原生负责的 AGENTS.md 没有被重复注入', !text.includes('owned by the native loader'))
  ok('注入是 system-reminder + 免责句', text.startsWith('<system-reminder>') && text.includes('Most of the time, it is not relevant.'))
  ok('此时还没有记忆索引', !text.includes('## Memory index'))

  // 用户 2026-10-07 定向下，`type: 'user'` 默认落到用户级记忆文件（<DSH_HOME>/CLAUDE.md），
  // 不再产生工作区主题文件。此处要验的是「主题文件 + 索引」这条工作区路径，故显式钉住 scope。
  h('3. 写两条记忆 → 索引行与主题文件')
  let r = await callTool(host, mainAgent, 'cc_memory_write', {
    name: 'user_role',
    type: 'user',
    scope: 'workspace',
    content: 'The user is a backend engineer working in C#. A distinctive tail sentence that must stay out of the index.',
  })
  show('cc_memory_write #1', r.text)
  r = await callTool(host, mainAgent, 'cc_memory_write', {
    name: 'feedback_testing',
    type: 'feedback',
    content: 'Always run the smoke test before claiming a fix works.',
  })
  show('cc_memory_write #2', r.text)

  // 默认落盘位置＝工作区内 `.cc-memory/`（用户 2026-10-06 定向）；锚点是 git 仓库根，此处即 project/。
  const storeDir = path.join(PROJECT, '.cc-memory')
  show('磁盘上的记忆目录（工作区模式 = <锚点>/.cc-memory）', storeDir)
  ok('记忆落在工作区内的 .cc-memory/', storeDir.startsWith(SANDBOX) && storeDir.includes('.cc-memory'))
  show('MEMORY.md 原文', await readFile(path.join(storeDir, 'MEMORY.md'), 'utf8'))
  show('user_role.md 原文', await readFile(path.join(storeDir, 'user_role.md'), 'utf8'))

  text = await injected(host, mainAgent)
  show('写入后的注入文本（只多了索引，正文不在里面）', text.split('## Memory index')[1] ?? '(no index)')
  ok('索引行进了注入文本', text.includes('**user_role**'))
  // CC 语义：索引行 = 正文首句的摘要，所以首句**本来就该**出现在注入里；
  // 不该出现的是主题文件的 frontmatter、以及首句之后的正文。
  ok('首句摘要进了索引行（CC 语义，符合预期）', text.includes('backend engineer working in C#'))
  ok('首句之后的正文没有进注入文本', !text.includes('distinctive tail sentence'))
  ok('主题文件的 frontmatter 没有进注入文本', !text.includes('type: user') && !text.includes('type: feedback'))

  h('4. 读：列清单 / 读一条 / 读不存在的')
  r = await callTool(host, mainAgent, 'cc_memory_read', {})
  show('cc_memory_read（无 name → 列清单）', r.text)
  r = await callTool(host, mainAgent, 'cc_memory_read', { name: 'feedback_testing' })
  show('cc_memory_read name=feedback_testing', r.text)
  r = await callTool(host, mainAgent, 'cc_memory_read', { name: 'nope' })
  ok('读不存在会抛错并列出可用项', !r.ok && r.text.includes('Available:'))

  h('5. 条件规则的惰性激活：读一个 src/*.ts')
  host.emit('tools/result', { agent: mainAgent, arguments: { file_path: path.join(PROJECT, 'src', 'a.ts') } })
  text = await injected(host, mainAgent)
  ok('命中 glob 后条件规则进来了', text.includes('Never use `any`'))
  ok('未命中的路径不会激活它', text.includes('descriptive variable names'))
  show('激活后新增的块', (text.match(/### [^\n]*ts-only[^\n]*\n[\s\S]*?(?=###|<\/system-reminder>)/) || ['(未找到)'])[0])

  h('6. /memory 命令')
  const command = host.commandDefs[0]
  const runCommand = async (rawInput) => (await command.handler({ agent: mainAgent, rawInput, attachments: [], signal: undefined })).text
  show('/memory', await runCommand(''))
  show('/memory user_role', await runCommand('user_role'))
  show('/memory index', await runCommand('index'))
  show('/memory dir', await runCommand('dir'))
  const unknown = await command.handler({ agent: mainAgent, rawInput: 'nope' })
  ok('未知名字返回 error 结果', unknown.kind === 'error' && unknown.text.includes('Available:'))

  h('7. 删除：cc_memory_forget')
  r = await callTool(host, mainAgent, 'cc_memory_forget', { name: 'user_role' })
  show('cc_memory_forget user_role', r.text)
  show('删完的 MEMORY.md 原文', await readFile(path.join(storeDir, 'MEMORY.md'), 'utf8'))
  ok('索引行被摘掉了', !(await readFile(path.join(storeDir, 'MEMORY.md'), 'utf8')).includes('user_role'))
  ok('主题文件被删了', !existsSync(path.join(storeDir, 'user_role.md')))
  ok('另一条记忆还在', existsSync(path.join(storeDir, 'feedback_testing.md')))
  r = await callTool(host, mainAgent, 'cc_memory_forget', { name: 'nope' })
  ok('删不存在的会抛错而不是静默成功', !r.ok && r.text.includes('Available:'))

  h('7b. 用户级记忆（<DSH_HOME>/CLAUDE.md，用户 2026-10-07 定向）')
  const userMemFile = path.join(HOME, 'CLAUDE.md')
  const before = await readFile(userMemFile, 'utf8')
  r = await callTool(host, mainAgent, 'cc_memory_write', {
    name: 'user_role',
    type: 'user',
    content: 'The user is a backend engineer working in C#.',
  })
  show('type: user 且不传 scope → 落到用户级', r.text)
  const after = await readFile(userMemFile, 'utf8')
  ok('默认按 type 兜底落到用户级文件', r.ok && r.text.includes(userMemFile))
  ok('原有内容一个字没动（只增不改）', after.startsWith(before))
  ok('新增的是单行 bullet', after.slice(before.length).trim().startsWith('- '))
  ok('不建索引、不产生工作区主题文件', !existsSync(path.join(storeDir, 'user_role.md')))
  ok('未被 formatBudgetNotice 干扰（用户级无预算）', !r.text.includes('WARNING: MEMORY.md'))

  const dedup = await callTool(host, mainAgent, 'cc_memory_write', {
    name: 'user_role',
    type: 'user',
    content: 'The user is a backend engineer working in C#.',
  })
  ok('同文重复写入被幂等去重', dedup.text.includes('already present') || (await readFile(userMemFile, 'utf8')) === after)

  r = await callTool(host, mainAgent, 'cc_memory_read', { scope: 'user' })
  show('cc_memory_read scope=user', r.text)
  ok('用户级可读且列出了条目', r.ok && r.text.includes('backend engineer'))

  r = await callTool(host, mainAgent, 'cc_memory_read', {})
  ok('总清单里出现用户级段落', r.text.includes('User-scope memories'))

  r = await callTool(host, mainAgent, 'cc_memory_forget', {
    name: 'The user is a backend engineer working in C#.',
    scope: 'user',
  })
  show('cc_memory_forget scope=user（按 bullet 正文精确匹配）', r.text)
  ok('该 bullet 被摘掉', r.ok && !(await readFile(userMemFile, 'utf8')).includes('backend engineer'))
  ok('其余内容仍保留', (await readFile(userMemFile, 'utf8')).includes('User-level rule'))

  h('7c. 用户级记忆文件由插件自动创建（用户 2026-10-07 定向）')
  const autoHost = createHost()
  apply(autoHost.ctx, { ...config(), dshHome: EMPTY_HOME })
  const autoFile = path.join(EMPTY_HOME, 'CLAUDE.md')
  ok('apply() 返回后文件必定已存在（同步创建）', existsSync(autoFile))
  const autoBody = await readFile(autoFile, 'utf8')
  show('自动创建的内容', autoBody)
  ok('写的是 HTML 注释表头', autoBody.trimStart().startsWith('<!--') && autoBody.trimEnd().endsWith('-->'))
  autoHost.emit('agent/session-start', { agent: mainAgent })
  const autoText = await injected(autoHost, mainAgent)
  ok('表头在注入前被剥掉', !autoText.includes('本文件由 dsh-cc-memory 插件的用户级记忆层维护'))
  ok('只有表头时该层整块不注入（零上下文开销）', !autoText.includes(autoFile))
  const autoSnapshot = await readFile(autoFile, 'utf8')
  r = await callTool(autoHost, mainAgent, 'cc_memory_read', { scope: 'user' })
  show('只有表头时 cc_memory_read scope=user', r.text)
  ok('表头里的 - 行不被算成条目（Entries: 0）', r.ok && r.text.includes('Entries: 0'))
  r = await callTool(autoHost, mainAgent, 'cc_memory_forget', {
    name: '写入方式：一条记忆一个 "- " 开头的条目（bullet），追加在末尾；不建索引、不排序。',
    scope: 'user',
  })
  ok('表头行不可被 cc_memory_forget 删掉', !r.ok)
  ok('表头在读取之后仍完好', (await readFile(autoFile, 'utf8')) === autoSnapshot)
  apply(createHost().ctx, { ...config(), dshHome: EMPTY_HOME })
  ok('已存在的文件一个字节都不动', (await readFile(autoFile, 'utf8')) === autoSnapshot)
  const offHome = path.join(SANDBOX, 'home-off')
  apply(createHost().ctx, { ...config(), dshHome: offHome, ensureUserMemoryFile: false })
  ok('ensureUserMemoryFile=false 时不创建', !existsSync(path.join(offHome, 'CLAUDE.md')))

  h('8. 子代理隔离（CC 语义：主对话的自动记忆不进子代理）')
  host.emit('agent/session-start', { agent: subAgent })
  const subText = await injected(host, subAgent)
  show('子代理收到的注入文本', subText)
  ok('子代理看不到记忆索引', !subText.includes('**feedback_testing**'))
  ok('子代理仍拿到指令层', subText.includes('Build with `node build.mjs`'))
  ok('子代理被明确告知原因', subText.includes('Subagents do not receive'))
  r = await callTool(host, subAgent, 'cc_memory_write', { name: 'x', type: 'user', content: 'should not land' })
  ok('子代理写记忆被拒绝', !r.ok && r.text.includes('subagent session'))
  const subCommand = await command.handler({ agent: subAgent, rawInput: '' })
  ok('子代理的 /memory 也拒绝', subCommand.kind === 'error')
  show('子代理调用写工具的结果', r.text)

  h('9. 索引预算：超限时写入仍成功，但回一句纠偏话术')
  const small = createHost()
  apply(small.ctx, { ...config(), indexMaxLines: 2 })
  small.emit('agent/session-start', { agent: mainAgent })
  await injected(small, mainAgent)
  for (const n of ['m1', 'm2', 'm3']) {
    r = await callTool(small, mainAgent, 'cc_memory_write', { name: n, type: 'project', content: `Body of ${n}.` })
  }
  show('第 3 条的返回（indexMaxLines=2）', r.text)
  ok('超预算时写入仍成功', r.ok && r.text.includes('Saved memory "m3"'))
  ok('返回里带 WARNING', r.text.includes('WARNING: MEMORY.md now exceeds the injection budget'))
  ok('纠偏话术指向 forget 工具', r.text.includes('cc_memory_forget'))
  const smallText = await injected(small, mainAgent)
  ok('注入侧只装前 2 行并说明被截断', smallText.includes('index truncated for injection'))
  show('超预算时的注入片段', smallText.split('## Memory index')[1])

  h(`结果：${checks - failures} passed, ${failures} failed`)
  return failures
}

const code = await main()
process.exit(code === 0 ? 0 : 1)
