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
    async liveSessionIds(workspaceId) {
      return [...(workspaces.get(workspaceId)?.sessionIds ?? [])]
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
  assert.equal(row.liveCount, 1)
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
  sessions.workspaces.get(started.workspaceId).sessionIds.length = 0 // sessions closed
  await writeRepoFile(started.worktreePath, 'dirty.txt', 'x')
  await assert.rejects(() => bs.finish({ repoPath: repo, branch: 'feature-a' }), /dirty/i)
})

test('finish removes worktree + registry record + workspace, keeps branch by default', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  sessions.workspaces.get(started.workspaceId).sessionIds.length = 0 // sessions closed
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
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  sessions.workspaces.get(started.workspaceId).sessionIds.length = 0 // sessions closed
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

test('five concurrent starts of the same branch share one worktree and one workspace', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const results = await Promise.all(
    Array.from({ length: 5 }, () => bs.start({ repoPath: repo, branch: 'feature-a' })),
  )
  const workspaceIds = new Set(results.map((r) => r.workspaceId))
  const worktreePaths = new Set(results.map((r) => r.worktreePath))
  assert.equal(workspaceIds.size, 1)
  assert.equal(worktreePaths.size, 1)
  assert.equal(sessions.workspaces.size, 1)
  const { listWorktrees, branchExists, resolveMainRepoRoot } = await import('../lib/git.js')
  assert.equal((await listWorktrees(repo)).filter((w) => w.branch === 'feature-a').length, 1)
  assert.ok(await branchExists(repo, 'feature-a'))
  // every caller still got its own session
  assert.equal(new Set(results.map((r) => r.sessionId)).size, 5)
  const root = await resolveMainRepoRoot(repo)
  const [rec] = await bs.list({ repoPath: root })
  assert.equal(rec.sessionCount, 5)
})

test('concurrent starts of different branches do not interfere', async (t) => {
  const { bs, repo } = await setup(t)
  const [a, b] = await Promise.all([
    bs.start({ repoPath: repo, branch: 'feature-a' }),
    bs.start({ repoPath: repo, branch: 'feature-b' }),
  ])
  assert.notEqual(a.workspaceId, b.workspaceId)
  assert.notEqual(a.worktreePath, b.worktreePath)
  assert.equal((await bs.list({ repoPath: repo })).length, 2)
})

test('finish refuses while live sessions are attached to the workspace', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  await bs.start({ repoPath: repo, branch: 'feature-a' }) // second session on the same branch
  const err = await bs.finish({ repoPath: repo, branch: 'feature-a' }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err, 'finish must be rejected')
  assert.match(err.message, /2 live session/i)
  assert.match(err.message, /force/i)
  assert.match(err.message, new RegExp(started.sessionId))
  // worktree and workspace untouched
  assert.ok((await stat(started.worktreePath)).isDirectory())
  assert.equal(sessions.workspaces.size, 1)
})

test('forced finish detaches live sessions and reports them as orphaned', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const first = await bs.start({ repoPath: repo, branch: 'feature-a' })
  const second = await bs.start({ repoPath: repo, branch: 'feature-a' })
  const result = await bs.finish({ repoPath: repo, branch: 'feature-a', force: true })
  assert.deepEqual(new Set(result.orphanedSessionIds), new Set([first.sessionId, second.sessionId]))
  assert.equal(sessions.workspaces.size, 0)
  await assert.rejects(() => stat(first.worktreePath))
})

test('finish without force succeeds once no live sessions remain', async (t) => {
  const { bs, repo, sessions } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  // simulate all sessions closed: detach them from the fake workspace
  sessions.workspaces.get(started.workspaceId).sessionIds.length = 0
  const result = await bs.finish({ repoPath: repo, branch: 'feature-a' })
  assert.deepEqual(result.orphanedSessionIds, [])
})

test('start and finish of the same branch never run concurrently', async (t) => {
  const { bs, repo } = await setup(t)
  await bs.start({ repoPath: repo, branch: 'feature-a' })
  const [finishResult, startResult] = await Promise.all([
    bs.finish({ repoPath: repo, branch: 'feature-a', force: true }),
    bs.start({ repoPath: repo, branch: 'feature-a' }),
  ])
  // serialized: whichever ran first, the final state is consistent —
  // finish-then-start (worktree exists again) or start-then-finish (gone)
  const exists = await stat(startResult.worktreePath).then(() => true, () => false)
  const rows = await bs.list({ repoPath: repo })
  if (exists) {
    assert.equal(rows.length, 1)
  } else {
    assert.equal(finishResult.branch, 'feature-a')
    assert.equal(rows.length, 0)
  }
})

test('symlinked repo path: start returns and persists canonical paths only', async (t) => {
  const { symlink, realpath: rp } = await import('node:fs/promises')
  const { bs, repo, sessions } = await setup(t)
  const linkBase = await rp(await mkdtemp(join(tmpdir(), 'branchspace-symlink-')))
  t.after(() => rm(linkBase, { recursive: true, force: true }))
  const link = join(linkBase, 'repo-link')
  await symlink(repo, link)

  const result = await bs.start({ repoPath: link, branch: 'feature-a' })
  assert.equal(result.worktreePath, await rp(result.worktreePath), 'returned path is canonical')
  assert.ok(!result.worktreePath.startsWith(link), 'no symlink prefix anywhere')
  const { resolveMainRepoRoot } = await import('../lib/git.js')
  const root = await resolveMainRepoRoot(link)
  const [rec] = await bs['deps'].registry.list(root)
  assert.equal(rec.worktreePath, result.worktreePath, 'registry persists canonical path')
  // session cwd matches the workspace path exactly (attach validation would pass)
  const sess = [...sessions.sessions.values()].find((s) => s.workspaceId === result.workspaceId)
  assert.equal(sess.cwd, sessions.workspaces.get(result.workspaceId).path)
})

test('overview groups branches per repository for the UI panel', async (t) => {
  const { bs, repo } = await setup(t)
  const repo2 = await makeTempRepo(t)
  await bs.start({ repoPath: repo, branch: 'feature-a' })
  await bs.start({ repoPath: repo, branch: 'feature-b' })
  await bs.start({ repoPath: repo2, branch: 'solo' })
  const overview = await bs.overview()
  assert.equal(overview.length, 2)
  const byRepo = Object.fromEntries(overview.map((g) => [g.repoPath, g]))
  const { resolveMainRepoRoot } = await import('../lib/git.js')
  const root1 = await resolveMainRepoRoot(repo)
  const root2 = await resolveMainRepoRoot(repo2)
  assert.deepEqual(byRepo[root1].branches.map((b) => b.branch).sort(), ['feature-a', 'feature-b'])
  assert.deepEqual(byRepo[root2].branches.map((b) => b.branch), ['solo'])
  assert.ok(byRepo[root1].repoName.length > 0)
})

test('overview drops repos whose worktrees vanished while offline', async (t) => {
  const { bs, repo } = await setup(t)
  const started = await bs.start({ repoPath: repo, branch: 'feature-a' })
  const { removeWorktree } = await import('../lib/git.js')
  const { resolveMainRepoRoot } = await import('../lib/git.js')
  await removeWorktree(await resolveMainRepoRoot(repo), started.worktreePath, true)
  assert.deepEqual(await bs.overview(), [])
})
