import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { makeTempRepo } from './helpers.mjs'
import * as plugin from '../lib/index.js'

/**
 * Integration smoke test: mount the real cordis plugin on a real cordis
 * Context with mock dsh services over a real temp git repo, then drive the
 * /branchspace command end to end.
 */
async function setup(t) {
  const repo = await makeTempRepo(t)
  const regDir = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-cordis-')))
  t.after(() => rm(regDir, { recursive: true, force: true }))

  const workspaces = new Map()
  const liveSessions = new Map()
  const commandDefs = []
  let uuid = 0

  const workspaceRegistry = {
    async create(path, title) {
      const id = `ws-${++uuid}`
      workspaces.set(id, { id, path, title, sessionIds: [], attachSession: async (sid) => {
        const s = liveSessions.get(sid)
        if (!s || s.header.cwd !== path) throw new Error(`cwd mismatch attaching ${sid}`)
        workspaces.get(id).sessionIds.unshift(sid)
      } })
      return workspaces.get(id)
    },
    async resolveByPath(path) {
      return [...workspaces.values()].find((w) => w.path === path)
    },
    get: (id) => workspaces.get(id),
    list: () => [...workspaces.values()],
    async delete(id) {
      return workspaces.delete(id)
    },
  }
  const sessions = {
    get: (id) => liveSessions.get(id),
    list: () => [...liveSessions.values()],
  }
  const agents = {
    async create({ sessionId, meta }) {
      const session = { id: sessionId, header: { cwd: meta?.cwd } }
      liveSessions.set(sessionId, session)
      return { agent: { id: sessionId, session }, dispose: async () => liveSessions.delete(sessionId) }
    },
    get: (id) => (liveSessions.has(id) ? { id, session: liveSessions.get(id) } : undefined),
  }
  const agentDefaultModel = { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
  const commands = {
    register(def) {
      commandDefs.push(def)
      return () => commandDefs.splice(commandDefs.indexOf(def), 1)
    },
  }

  const app = new Context()
  app.provide('workspaceRegistry', workspaceRegistry)
  app.provide('sessions', sessions)
  app.provide('agents', agents)
  app.provide('agentDefaultModel', agentDefaultModel)
  app.provide('commands', commands)
  await app.plugin(plugin, { registryPath: join(regDir, 'branchspace.json') })
  await new Promise((resolve) => setTimeout(resolve, 50)) // let the fiber activate

  return { repo, commandDefs, workspaces, liveSessions, invocation: (rawInput, cwd = repo) => {
    const sessionId = 'session-caller'
    liveSessions.set(sessionId, { id: sessionId, header: { cwd } })
    return { agent: { id: sessionId, session: liveSessions.get(sessionId) }, rawInput, signal: new AbortController().signal }
  } }
}

test('plugin activates under cordis and registers the /branchspace command', async (t) => {
  const { commandDefs } = await setup(t)
  assert.equal(commandDefs.length, 1)
  assert.equal(commandDefs[0].name, 'branchspace')
})

test('start → list → finish through the command handler over a real repo', async (t) => {
  const { repo, commandDefs, workspaces, invocation } = await setup(t)
  const handler = commandDefs[0].handler

  const started = await handler(invocation('start feature-a'))
  assert.equal(started.kind, 'success', started.text)
  assert.match(started.text, /⎇ feature-a ready/)
  const sessionId = started.text.match(/session:\s+(session-\S+)/)[1]

  const listed = await handler(invocation('list'))
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /⎇ feature-a/)
  assert.match(listed.text, /1 session/)

  // finish refused while the created session is live
  const refused = await handler(invocation('finish feature-a'))
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /live session/)

  // session closed → finish succeeds, workspace record removed, branch kept;
  // here we force-finish, which must report the live session as orphaned
  const forced = await handler(invocation('finish feature-a --force'))
  assert.equal(forced.kind, 'success')
  assert.match(forced.text, /orphaned sessions/)
  assert.match(forced.text, /branch kept/)
  assert.equal(workspaces.size, 0)
  assert.match(forced.text, new RegExp(sessionId))

  const after = await handler(invocation('list'))
  assert.match(after.text, /No branchspace branches/)
  const { branchExists } = await import('../lib/git.js')
  assert.ok(await branchExists(repo, 'feature-a'), 'branch survives finish')
})

test('isolation: writes in the worktree never touch the main checkout', async (t) => {
  const { repo, commandDefs, invocation } = await setup(t)
  const handler = commandDefs[0].handler
  await handler(invocation('start feature-a'))
  const { resolveMainRepoRoot, listWorktrees } = await import('../lib/git.js')
  const root = await resolveMainRepoRoot(repo)
  const wt = (await listWorktrees(root)).find((w) => w.branch === 'feature-a')
  await writeFile(join(wt.path, 'worktree-only.txt'), 'isolated')
  // main checkout untouched
  await assert.rejects(() => stat(join(repo, 'worktree-only.txt')))
  const { isWorktreeDirty } = await import('../lib/git.js')
  assert.equal(await isWorktreeDirty(repo), false, 'main checkout stays clean')
  assert.equal(await isWorktreeDirty(wt.path), true)
})

test('bad usage and invalid input produce error results, not throws', async (t) => {
  const { commandDefs, invocation } = await setup(t)
  const handler = commandDefs[0].handler
  const noSub = await handler(invocation(''))
  assert.equal(noSub.kind, 'error')
  assert.match(noSub.text, /Usage:/)
  const badBranch = await handler(invocation('start --evil'))
  assert.equal(badBranch.kind, 'error')
  assert.match(badBranch.text, /invalid branch/i)
  const missingRepo = await handler(invocation('list', '/definitely/not/a/repo'))
  assert.equal(missingRepo.kind, 'error')
  assert.match(missingRepo.text, /not a git repository/i)
})
