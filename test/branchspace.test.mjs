import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, realpath, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { makeTempRepo, writeRepoFile } from './helpers.mjs'
import { BranchRegistry } from '../lib/registry.js'
import { Branchspace } from '../lib/branchspace.js'
import { worktreePathFor } from '../lib/git.js'

function fakeSessionFactory() {
  const workspaces = new Map()
  const sessions = new Map()
  let n = 0
  return {
    workspaces,
    sessions,
    async ensureWorkspace({ path, title }) {
      for (const [id, ws] of workspaces) if (ws.path === path) return id
      const id = `ws-${++n}`
      workspaces.set(id, { path, title, sessionIds: [] })
      return id
    },
    async createSession({ workspaceId, cwd }) {
      const ws = workspaces.get(workspaceId)
      if (!ws) throw new Error('no workspace ' + workspaceId)
      if (ws.path !== cwd) throw new Error(`cwd mismatch: ${cwd} != ${ws.path}`)
      const id = `session-${++n}`
      sessions.set(id, { workspaceId, cwd })
      ws.sessionIds.push(id)
      return id
    },
    async removeWorkspace(workspaceId) {
      workspaces.delete(workspaceId)
    },
  }
}

async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-svc-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = await makeTempRepo(t)
  const registry = new BranchRegistry(join(dir, 'branchspace.json'))
  await registry.load()
  const sessions = fakeSessionFactory()
  const bs = new Branchspace({ registry, sessions, repoName: (p) => p.split('/').pop() })
  return { bs, repo, registry, sessions }
}

test('start creates worktree + workspace + session and returns the record', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const result = await bs.start({ repoPath: repo, branch: 'feature-a' })
  assert.equal(result.branch, 'feature-a')
  assert.equal(result.worktreePath, worktreePathFor(repo, 'feature-a'))
  assert.ok((await stat(result.worktreePath)).isDirectory())
  const ws = [...sessions.workspaces.values()][0]
  assert.equal(ws.path, result.worktreePath)
  assert.match(ws.title, /⎇ feature-a$/)
  assert.match(ws.title, /^branchspace-test-/)
  assert.equal([...sessions.sessions.values()][0].cwd, result.worktreePath)
})

test('start is idempotent: second start reuses worktree and workspace', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const first = await bs.start({ repoPath: repo, branch: 'feature-a' })
  const second = await bs.start({ repoPath: repo, branch: 'feature-a' })
  assert.equal(second.workspaceId, first.workspaceId)
  assert.equal(second.worktreePath, first.worktreePath)
  assert.notEqual(second.sessionId, first.sessionId, 'a new session is still created')
  assert.equal(sessions.workspaces.size, 1)
})

test('start rejects an invalid branch name before touching git', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  await assert.rejects(() => bs.start({ repoPath: repo, branch: '--evil' }), /invalid branch/i)
})

test('start rejects a non-repo path', async (t) => {
  const { bs } = await setup(t)
  await assert.rejects(() => bs.start({ repoPath: '/tmp', branch: 'x' }), /not a git repository/i)
})

test('list reports branch, worktree, workspace, session count and dirty flag', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  let [row] = await bs.list({ repoPath: repo })
  assert.equal(row.branch, 'feature-a')
  assert.equal(row.worktreePath, started.worktreePath)
  assert.equal(row.workspaceId, started.workspaceId)
  assert.equal(row.sessionCount, 1)
  assert.equal(row.dirty, false)
  await writeRepoFile(started.worktreePath, 'dirty.txt', 'x')
  ;[row] = await bs.list({ repoPath: repo })
  assert.equal(row.dirty, true)
})

test('list is empty for a repo without branchspace branches', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  assert.deepEqual(await bs.list({ repoPath: repo }), [])
})

test('finish refuses a dirty worktree without force', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  await writeRepoFile(started.worktreePath, 'dirty.txt', 'x')
  await assert.rejects(() => bs.finish({ repoPath: repo, branch: 'feature-a' }), /dirty/i)
})

test('finish removes worktree + registry record + workspace, keeps branch by default', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  await bs.finish({ repoPath: repo, branch: 'feature-a' })
  await assert.rejects(() => stat(started.worktreePath))
  assert.deepEqual(await bs.list({ repoPath: repo }), [])
  assert.equal(sessions.workspaces.size, 0)
  // branch itself survives
  const { branchExists } = await import('../lib/git.js')
  assert.ok(await branchExists(repo, 'feature-a'))
})

test('finish with deleteBranch removes the branch too', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  await bs.start({ repoPath: repo, branch: 'feature-a' })
  await bs.finish({ repoPath: repo, branch: 'feature-a', deleteBranch: true })
  const { branchExists } = await import('../lib/git.js')
  assert.equal(await branchExists(repo, 'feature-a'), false)
})

test('two branches on the same repo are fully independent', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const a = await bs.start({ repoPath: repo, branch: 'feature-a' })
  const b = await bs.start({ repoPath: repo, branch: 'feature-b' })
  assert.notEqual(a.worktreePath, b.worktreePath)
  assert.notEqual(a.workspaceId, b.workspaceId)
  await writeRepoFile(a.worktreePath, 'only-a.txt', 'a')
  assert.equal((await bs.list({ repoPath: repo })).length, 2)
  const rows = Object.fromEntries((await bs.list({ repoPath: repo })).map((r) => [r.branch, r]))
  assert.equal(rows['feature-a'].dirty, true)
  assert.equal(rows['feature-b'].dirty, false)
  await bs.finish({ repoPath: repo, branch: 'feature-a', force: true })
  assert.deepEqual((await bs.list({ repoPath: repo })).map((r) => r.branch), ['feature-b'])
})

test('registry survives a simulated restart and reconciles with disk', async (t) => {
  const { bs, repo, registry, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })

  // simulate restart: new registry + branchspace over the same file
  const registry2 = new BranchRegistry(registry.filePath)
  await registry2.load()
  const sessions2 = fakeSessionFactory()
  const bs2 = new Branchspace({ registry: registry2, sessions: sessions2, repoName: (p) => p.split('/').pop() })
  const [row] = await bs2.list({ repoPath: repo })
  assert.equal(row.branch, 'feature-a')
  assert.equal(row.worktreePath, started.worktreePath)

  // remove the worktree out-of-band (simulating disk drift) and re-check
  const { removeWorktree } = await import('../lib/git.js')
  await removeWorktree(repo, started.worktreePath, true)
  assert.deepEqual(await bs2.list({ repoPath: repo }), [])
})
