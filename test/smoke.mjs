/**
 * 离线自检：不需要宿主即可验证 util / store / instructions 三层。
 * 运行：node plugin/test/smoke.mjs
 */
import path from 'node:path'
import os from 'node:os'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import {
  byteLength,
  globToRegExp,
  headBudget,
  isSubagentSession,
  matchesAnyGlob,
  parseFrontmatter,
  scanImportPaths,
  serializeFrontmatter,
  stripHtmlComments,
  visibleContentLines,
} from '../lib/util.js'
import { MemoryStore, firstSentence } from '../lib/store.js'
import { USER_MEMORY_HEADER, parseBullets, flattenBullet } from '../lib/userMemory.js'
import { collectInstructionBlocks, ruleMatchesTouched } from '../lib/instructions.js'
import { formatBudgetNotice } from '../lib/tools.js'
import { defineMemoryCommand, memoryOverview } from '../lib/commands.js'
import { resolveConfig } from '../lib/config.js'
import { WORKSPACE_MEMORY_DIR, memoryDirFor, workspaceMemoryDir } from '../lib/paths.js'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`)
  }
}

function checkTrue(label, value) {
  check(label, Boolean(value), true)
}

console.log('# util')

const fmText = '---\ntype: user\nmodified: 2026-10-04T00:00:00.000Z\n---\nbody here\n'
const fm = parseFrontmatter(fmText)
check('frontmatter attrs', fm.attrs, { type: 'user', modified: '2026-10-04T00:00:00.000Z' })
check('frontmatter body', fm.body, 'body here\n')
checkTrue('frontmatter detected', fm.hasFrontmatter)
check('frontmatter round-trip', serializeFrontmatter({ type: 'user' }), '---\ntype: user\n---\n')
check('no frontmatter', parseFrontmatter('# plain').hasFrontmatter, false)
check('frontmatter list form', parseFrontmatter('---\npaths: [a.ts, b.ts]\n---\nx').attrs.paths, ['a.ts', 'b.ts'])

check('headBudget 200 lines', headBudget('a\nb\nc', 2, 1000).text, 'a\nb')
checkTrue('headBudget truncated flag', headBudget('a\nb\nc', 2, 1000).truncated)
check('headBudget bytes', headBudget('abcdef', 10, 3).text, 'abc')
checkTrue('headBudget byte truncation flagged', headBudget('abcdef', 10, 3).truncated)
checkTrue('headBudget utf8 safe', byteLength(headBudget('你好世界', 10, 7).text) <= 7)

check(
  'stripHtmlComments removes block, keeps code fence',
  stripHtmlComments('keep <!-- hidden -->this\n```\n<!-- fenced -->\n```\n').trim(),
  'keep this\n```\n<!-- fenced -->\n```',
)
check('stripHtmlComments multi-line', stripHtmlComments('a<!--\nmid\n-->b').trim(), 'a\nb')

check('scanImportPaths basic', scanImportPaths('see @docs/a.md now'), ['docs/a.md'])
check('scanImportPaths skips inline code', scanImportPaths('`@README` and @real.md'), ['real.md'])
check('scanImportPaths skips fences', scanImportPaths('```\n@nope.md\n```\n@yes.md'), ['yes.md'])
check('scanImportPaths skips quoted', scanImportPaths('@"./quoted path.md" and @ok.md'), ['ok.md'])

checkTrue('glob no-slash matches basename', globToRegExp('*.ts').test('src/deep/a.ts'))
checkTrue('glob ** matches', globToRegExp('src/**/*.ts').test('src/a/b/c.ts'))
checkTrue('glob ** zero segments', globToRegExp('src/**/*.ts').test('src/c.ts'))
check('glob literal anchored', globToRegExp('src/*.ts').test('other/src/a.ts'), false)
checkTrue('brace + any-glob', matchesAnyGlob(['*.{ts,tsx}'], ['a/b/c.tsx']))
check('any-glob miss', matchesAnyGlob(['*.py'], ['a/b/c.ts']), false)

console.log('# store')

const root = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-smoke-'))
try {
  const store = new MemoryStore(path.join(root, 'memory'), { indexMaxLines: 200, indexMaxBytes: 25600 })
  const created = await store.writeMemory({
    name: 'user_role',
    type: 'user',
    content: 'The user is a backend engineer working on Windows.',
    now: new Date('2026-10-04T01:02:03.000Z'),
  })
  check('topic file name', created.file, 'user_role.md')
  check('created mode', created.mode, 'create')
  checkTrue('index not over budget', !created.index.overBudget)

  const topic = await readFile(created.path, 'utf8')
  checkTrue(
    'topic frontmatter has type + modified',
    topic.startsWith('---\ntype: user\nmodified: 2026-10-04T01:02:03.000Z\n---\n'),
  )
  checkTrue('topic body present', topic.includes('backend engineer'))

  const index = await store.readIndex()
  check('index heading', index.split('\n')[0], '# Memory index')
  checkTrue('index line shape', /- \*\*user_role\*\* \(user\) — .* `user_role\.md`/.test(index))

  const appended = await store.writeMemory({
    name: 'user_role',
    type: 'user',
    content: 'Prefers PowerShell over cmd.',
    now: new Date('2026-10-04T02:00:00.000Z'),
  })
  check('append mode', appended.mode, 'append')
  const body2 = await readFile(appended.path, 'utf8')
  checkTrue('append keeps earlier content', body2.includes('backend engineer') && body2.includes('PowerShell'))
  checkTrue('modified refreshed', body2.includes('2026-10-04T02:00:00.000Z'))
  const index2 = await store.readIndex()
  check('index still one line for the memory', index2.split('\n').filter((l) => l.includes('user_role.md')).length, 1)
  checkTrue('append 不改写既有索引摘要（仍是段落主旨，不是追加片段的首句）', index2.includes('The user is a backend engineer working on Windows'))
  checkTrue('append 不会把追加片段的首句写进索引', !index2.includes('Prefers PowerShell over cmd.'))
  check('readIndexSummary 能读回摘要', await store.readIndexSummary('user_role.md'), 'The user is a backend engineer working on Windows')
  check('readIndexSummary 对不存在的文件返回空串', await store.readIndexSummary('nope.md'), '')
  const explicit = await store.writeMemory({
    name: 'user_role',
    type: 'user',
    content: 'Also uses WSL daily.',
    summary: 'Backend engineer on Windows; prefers PowerShell and WSL.',
  })
  checkTrue(
    '显式 summary 仍可覆盖既有索引行',
    (await store.readIndex()).includes('Backend engineer on Windows; prefers PowerShell and WSL.'),
  )
  check('显式 summary 也让 append 成立', explicit.mode, 'append')

  const second = await store.writeMemory({ name: 'feedback_testing', type: 'feedback', content: 'Always run the smoke test.' })
  check('second topic file', second.file, 'feedback_testing.md')
  check('topic listing', await store.listTopicFiles(), ['feedback_testing.md', 'user_role.md'])
  check('injection entries counted', (await store.readIndexForInjection()).entries, 2)

  // 回归：更新「不是第一条」的记忆时，绝不能把它前面的条目一起吃掉。
  await store.writeMemory({ name: 'feedback_testing', type: 'feedback', content: 'Also lint before committing.' })
  const afterSecondUpdate = await store.readIndex()
  check('updating the 2nd memory keeps the 1st', afterSecondUpdate.includes('user_role.md'), true)
  check('updating the 2nd memory keeps itself', afterSecondUpdate.includes('feedback_testing.md'), true)
  check('index still has exactly 2 entries', (await store.readIndexForInjection()).entries, 2)
  checkTrue('append landed in the right topic file', (await store.readTopic('feedback_testing.md')).includes('Also lint'))

  const created2 = await store.writeMemory({ name: 'plain', type: 'reference', content: 'https://example.com', mode: 'create' })
  checkTrue('frontmatter always carries type', (await readFile(created2.path, 'utf8')).startsWith('---\ntype: reference\n'))

  let conflict = 'no-error'
  try {
    await store.writeMemory({ name: 'plain', type: 'reference', content: 'again', mode: 'create' })
  } catch (error) {
    conflict = error.message.includes('already exists')
  }
  checkTrue('mode=create refuses existing file', conflict)

  // 删除：必须同时删掉主题文件与索引行，不能留下指向空文件的孤儿行。
  const forgotten = await store.forgetMemory({ name: 'plain', type: 'reference' })
  checkTrue('forget removes the topic file', forgotten.removed)
  check('forget picks the right file', forgotten.file, 'reference_plain.md')
  check('index drops the deleted line', (await store.readIndex()).includes('reference_plain.md'), false)
  check('index keeps other lines', (await store.readIndex()).includes('user_role.md'), true)
  check('topic listing after forget', await store.listTopicFiles(), ['feedback_testing.md', 'user_role.md'])

  const missing = await store.forgetMemory({ name: 'never_existed' })
  check('forget reports a miss instead of throwing', missing.removed, false)
  check('forget miss lists what exists', missing.available, ['feedback_testing.md', 'user_role.md'])

  // 删空最后一条时，索引里的标题壳也要一起清掉。
  const solo = new MemoryStore(path.join(root, 'solo'), { indexMaxLines: 200, indexMaxBytes: 25600 })
  await solo.writeMemory({ name: 'only', type: 'project', content: 'solitary' })
  check('solo index has heading', (await solo.readIndex()).startsWith('# Memory index'), true)
  await solo.forgetMemory({ name: 'only' })
  check('empty index after deleting the last memory', await solo.readIndex(), '')

  // 不带 type 的写入按 name 定位：删掉一个名字后，读取不应再命中别的 type。
  await store.writeMemory({ name: 'shared_name', type: 'user', content: 'u' })
  const byName = await store.forgetMemory({ name: 'shared_name' })
  check('forget resolves type when omitted', byName.file, 'user_shared_name.md')
  check('index empty of that name', (await store.readIndex()).includes('shared_name'), false)

  // 索引摘要默认取正文首句：句末标点必须后接空白或行尾，否则版本号/域名/缩写里的点会被误判成句号。
  check('first sentence stops at a real full stop', firstSentence('The user is a backend engineer. Likes C#.'), 'The user is a backend engineer')
  check('version number is not split', firstSentence('@local/dsh-cc-memory v0.1.0 is the plugin. Second.'), '@local/dsh-cc-memory v0.1.0 is the plugin')
  check('dotted identifier is not split', firstSentence('Never import @deepseek-ai/dsh-tools at runtime'), 'Never import @deepseek-ai/dsh-tools at runtime')
  check('abbreviation is not split', firstSentence('Use e.g. pnpm and Node.js 22 for this project'), 'Use e.g. pnpm and Node.js 22 for this project')
  check('cjk full stop still splits', firstSentence('用户要求效果一致。其余自行决定。'), '用户要求效果一致')
  check('empty content falls back', firstSentence('   '), 'memory')
  check('long single sentence is capped', firstSentence('x'.repeat(300)).length, 120)

  const big = new MemoryStore(path.join(root, 'budget'), { indexMaxLines: 3, indexMaxBytes: 25600 })
  await big.writeMemory({ name: 'a', type: 'project', content: 'x' })
  const over = await big.writeMemory({ name: 'b', type: 'project', content: 'y' })
  checkTrue('write succeeds past budget', over.index.overBudget)
  checkTrue('budget notice reports injected lines', over.index.injectedLines <= 3)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('# instructions')

const proj = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-proj-'))
const home = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-home-'))
try {
  await mkdir(path.join(proj, '.git'), { recursive: true })
  await mkdir(path.join(proj, '.claude', 'rules'), { recursive: true })
  await mkdir(path.join(proj, 'src'), { recursive: true })
  await writeFile(path.join(proj, '.claude', 'docs.md'), 'IMPORTED-BODY\n', 'utf8')
  await writeFile(path.join(home, 'CLAUDE.md'), 'user-level rules\n', 'utf8')
  await writeFile(
    path.join(proj, '.claude', 'CLAUDE.md'),
    'project claude md\n\n@docs.md\n\n```\n@not-imported.md\n```\n<!-- hidden note -->\n',
    'utf8',
  )
  await writeFile(path.join(proj, '.claude', 'rules', 'always.md'), 'RULE-ALWAYS\n', 'utf8')
  await writeFile(
    path.join(proj, '.claude', 'rules', 'gated.md'),
    '---\npaths: ["src/**/*.ts"]\n---\nRULE-GATED\n',
    'utf8',
  )

  const config = resolveConfig({ dshHome: home, includeDefaultManagedFiles: false })

  const cold = await collectInstructionBlocks({ cwd: proj, dshHome: home, config, touched: [] })
  const labels = cold.blocks.map((b) => b.label)
  check('cold block order', labels, [
    'user: CLAUDE.md',
    '.claude/rules/always.md',
    'project: .claude/CLAUDE.md',
  ])
  check('gated rule withheld when nothing touched', true, !labels.some((l) => l.includes('gated')))
  check('pending conditional rules discovered', cold.conditionalPending.length, 1)

  const userBlock = cold.blocks.find((b) => b.label === 'user: CLAUDE.md')
  check('user block body', userBlock.text, 'user-level rules')

  const projectBlock = cold.blocks.find((b) => b.label === 'project: .claude/CLAUDE.md')
  checkTrue('@path import inlined in position', projectBlock.text.includes('IMPORTED-BODY'))
  check('fenced @path left literal', projectBlock.text.includes('@not-imported.md'), true)
  checkTrue('html comment stripped', !projectBlock.text.includes('hidden note'))
  checkTrue('import appears before the fence', projectBlock.text.indexOf('IMPORTED-BODY') < projectBlock.text.indexOf('@not-imported.md'))

  const warm = await collectInstructionBlocks({
    cwd: proj,
    dshHome: home,
    config,
    touched: [path.join(proj, 'src', 'a.ts')],
  })
  const warmLabels = warm.blocks.map((b) => b.label)
  checkTrue('gated rule appears once a matching file is touched', warmLabels.some((l) => l.includes('gated.md')))

  check(
    'ruleMatchesTouched hit',
    ruleMatchesTouched({ patterns: ['src/**/*.ts'] }, [path.join(proj, 'src', 'a.ts')], proj),
    true,
  )
  check(
    'ruleMatchesTouched miss',
    ruleMatchesTouched({ patterns: ['src/**/*.ts'] }, [path.join(proj, 'src', 'a.py')], proj),
    false,
  )

  // 嵌套 cwd：cwd 比 git root 深一层时应各自加载自己的 .claude/CLAUDE.md。
  const nested = path.join(proj, 'src')
  await writeFile(path.join(nested, '.claude-placeholder'), '', 'utf8')
  const nestedResult = await collectInstructionBlocks({ cwd: nested, dshHome: home, config, touched: [] })
  checkTrue('root file still loaded from nested cwd', nestedResult.blocks.some((b) => b.label === 'project: .claude/CLAUDE.md'))
} finally {
  await rm(proj, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}

console.log('# session kind (subagent isolation)')

check(
  'subagent by origin',
  isSubagentSession({ session: { header: { origin: 'subagent', delegationDepth: 1 } } }),
  true,
)
check('subagent by delegationDepth', isSubagentSession({ session: { header: { delegationDepth: 1 } } }), true)
check('header also read from agent.header', isSubagentSession({ header: { origin: 'subagent' } }), true)
check(
  'continued session is NOT a subagent',
  isSubagentSession({ session: { header: { parentSession: 'abc', delegationDepth: 0 } } }),
  false,
)
check('top-level session is not a subagent', isSubagentSession({ session: { header: { cwd: 'C:/x' } } }), false)
check('missing header fails open', isSubagentSession({}), false)
check('null fails open', isSubagentSession(null), false)

console.log('# memory command')

const cmdRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-cmd-'))
try {
  const cmdStore = new MemoryStore(path.join(cmdRoot, 'memory'), { indexMaxLines: 200, indexMaxBytes: 25600 })
  await cmdStore.writeMemory({ name: 'user_role', type: 'user', content: 'The user is a backend engineer.' })

  const cfg = resolveConfig({})
  const cmd = defineMemoryCommand({ cfg, sessionFor: () => ({ store: cmdStore, isolated: false }) })
  check('command name', cmd.name, 'memory')
  check('command declares the arg hint', cmd.input.hint, '[name]')

  const overview = await cmd.handler({ rawInput: '' })
  check('overview is a success result', overview.kind, 'success')
  checkTrue('overview lists the topic file', overview.text.includes('user_role.md'))
  checkTrue('overview shows the index line', overview.text.includes('**user_role** (user)'))
  checkTrue('overview states the injection budget', overview.text.includes('200 lines'))

  const one = await cmd.handler({ rawInput: 'user_role' })
  checkTrue('bare name returns the memory body', one.text.includes('backend engineer'))
  const viaLine = await cmd.handler({ rawInput: '/memory user_role' })
  checkTrue('full-line form is tolerated', viaLine.text.includes('backend engineer'))

  check('dir subcommand', (await cmd.handler({ rawInput: 'dir' })).text, cmdStore.dir)
  checkTrue('index subcommand returns the raw index', (await cmd.handler({ rawInput: 'index' })).text.includes('# Memory index'))
  check('unknown name is an error result', (await cmd.handler({ rawInput: 'nope' })).kind, 'error')

  const isolatedCmd = defineMemoryCommand({ cfg, sessionFor: () => ({ store: cmdStore, isolated: true }) })
  check('isolated session is refused', (await isolatedCmd.handler({ rawInput: '' })).kind, 'error')

  const offCmd = defineMemoryCommand({ cfg: resolveConfig({ commandsEnabled: false }), sessionFor: () => ({}) })
  check('commandsEnabled=false yields no definition', offCmd, null)

  const overviewText = await memoryOverview(cmdStore, cfg)
  checkTrue('empty-store overview is explicit', (await memoryOverview(new MemoryStore(path.join(cmdRoot, 'empty'), cfg), cfg)).includes('No memories stored yet'))
  checkTrue('populated overview counts memories', overviewText.includes('Memories (1):'))
} finally {
  await rm(cmdRoot, { recursive: true, force: true })
}

console.log('# budget notice')

const noticeCfg = resolveConfig({})
check(
  'notice under budget',
  formatBudgetNotice({ overBudget: false, totalLines: 2, totalBytes: 40, entries: 1 }, 'warn', noticeCfg),
  'Index now 2 lines / 40 bytes (1 entries).',
)
const overNotice = formatBudgetNotice(
  {
    overBudget: true,
    totalLines: 300,
    totalBytes: 30000,
    injectedLines: 200,
    injectedBytes: 25600,
    entries: 300,
    limit: { maxLines: 200, maxBytes: 25600 },
  },
  'warn',
  noticeCfg,
)
checkTrue('over-budget notice says the write still succeeded', overNotice.includes('The write succeeded'))
checkTrue('over-budget notice names the forget tool', overNotice.includes('cc_memory_forget'))
check(
  'strict mode appends its warning',
  /strict budget mode/.test(
    formatBudgetNotice({ overBudget: true, totalLines: 3, totalBytes: 1, injectedLines: 2, injectedBytes: 1, entries: 3, limit: { maxLines: 2, maxBytes: 1 } }, 'strict', noticeCfg),
  ),
  true,
)
check('no index → empty notice', formatBudgetNotice(undefined, 'warn', noticeCfg), '')

console.log('# config')

const defaults = resolveConfig({})
check(
  'new defaults',
  [defaults.subagentIsolation, defaults.forgetToolName, defaults.memoryCommandName, defaults.commandsEnabled],
  [true, 'cc_memory_forget', 'memory', true],
)
check('command name strips a leading slash', resolveConfig({ memoryCommandName: '/mem' }).memoryCommandName, 'mem')
check('subagentIsolation can be turned off', resolveConfig({ subagentIsolation: false }).subagentIsolation, false)
check('bad budgetMode falls back', resolveConfig({ budgetMode: 'nonsense' }).budgetMode, 'warn')
check('folderIndex is not a thing', resolveConfig({ memoryRoot: 'D:/x' }).memoryRoot, 'D:/x')
check('user memory file defaults to CLAUDE.md', resolveConfig({}).userMemoryFile, 'CLAUDE.md')
check('user memory file is auto-created by default', resolveConfig({}).ensureUserMemoryFile, true)
check('bad userMemoryFile falls back', resolveConfig({ userMemoryFile: '   ' }).userMemoryFile, 'CLAUDE.md')
check('auto-create can be turned off', resolveConfig({ ensureUserMemoryFile: false }).ensureUserMemoryFile, false)

console.log('# user-level memory bullets (注释/围栏里的 - 行不是条目)')

check('自动创建的表头不产出任何条目', parseBullets(USER_MEMORY_HEADER).length, 0)
check(
  '表头 + 真实条目只解析出真实条目，且行号指向原文',
  parseBullets(`${USER_MEMORY_HEADER}\n- 真实记忆\n`),
  [{ line: USER_MEMORY_HEADER.split(/\r?\n/).length, text: '真实记忆' }],
)
check(
  '围栏代码块里的 - 行不算条目',
  parseBullets(['- real', '```md', '- fake', '```', '- real2'].join('\n')).map((b) => b.text),
  ['real', 'real2'],
)
check('行号仍指向原文（remove 靠它 splice）', parseBullets(['<!--', '- fake', '-->', '- real'].join('\n')), [{ line: 3, text: 'real' }])
check('visibleContentLines 行数与原文本严格一致', visibleContentLines(USER_MEMORY_HEADER).length, USER_MEMORY_HEADER.split(/\r?\n/).length)
check('flattenBullet 把多行压成单行', flattenBullet('a\n\n  b  '), 'a b')

console.log('# memory location')

const locRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-paths-'))
try {
  // 默认：工作区模式。锚点优先 git 仓库根，同仓库的子目录共享一份记忆。
  check('default memory location mode', resolveConfig({}).memoryRootMode, 'workspace')
  check('dsh-home mode accepted', resolveConfig({ memoryRootMode: 'dsh-home' }).memoryRootMode, 'dsh-home')
  check('bad mode falls back to workspace', resolveConfig({ memoryRootMode: 'nonsense' }).memoryRootMode, 'workspace')

  const repo = path.join(locRoot, 'repo')
  const nested = path.join(repo, 'packages', 'app')
  await mkdir(path.join(repo, '.git'), { recursive: true })
  await mkdir(nested, { recursive: true })
  check('workspace dir = <git root>/.cc-memory', workspaceMemoryDir(nested), path.join(repo, '.cc-memory'))
  check('workspace dir from the git root itself', workspaceMemoryDir(repo), path.join(repo, '.cc-memory'))

  const loose = path.join(locRoot, 'no-git')
  await mkdir(loose, { recursive: true })
  check('no git repo → anchored at cwd', workspaceMemoryDir(loose), path.join(loose, '.cc-memory'))
  check('workspace memory dir name', WORKSPACE_MEMORY_DIR, '.cc-memory')

  // dsh-home 模式仍保留（CC 的布局），显式 memoryRoot 优先级最高。
  check('dsh-home layout unchanged', memoryDirFor('R:/cc-memory', 'proj-abc123'), path.join('R:/cc-memory', 'projects', 'proj-abc123', 'memory'))
} finally {
  await rm(locRoot, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
