import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { makeTempRepo, git } from './helpers.mjs'
import { addWorktree, removeWorktree, worktreePathFor } from '../lib/git.js'
import { BranchRegistry } from '../lib/registry.js'

async function makeRegistryFile(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-reg-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'branchspace.json')
}

test('registry starts empty for an unknown repo', async (t) => {
  const file = await makeRegistryFile(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  assert.deepEqual(await reg.list('no/such/repo'), [])
})

test('upsert + list roundtrips and persists across reload', async (t) => {
  const file = await makeRegistryFile(t)
  const repo = await makeTempRepo(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert(repo, {
    branch: 'feature-a',
    worktreePath: worktreePathFor(repo, 'feature-a'),
    sessionIds: [],
    createdAt: new Date().toISOString(),
  })
  const reg2 = new BranchRegistry(file)
  await reg2.load()
  const records = await reg2.list(repo)
  assert.equal(records.length, 1)
  assert.equal(records[0].branch, 'feature-a')
})

test('attachSession dedupes session ids and setWorkspace stores the id', async (t) => {
  const file = await makeRegistryFile(t)
  const repo = await makeTempRepo(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert(repo, { branch: 'b1', worktreePath: '/x', sessionIds: [], createdAt: 'now' })
  await reg.attachSession(repo, 'b1', 's1')
  await reg.attachSession(repo, 'b1', 's1')
  await reg.attachSession(repo, 'b1', 's2')
  await reg.setWorkspace(repo, 'b1', 'ws-1')
  const [rec] = await reg.list(repo)
  assert.deepEqual(rec.sessionIds.sort(), ['s1', 's2'])
  assert.equal(rec.workspaceId, 'ws-1')
})

test('remove deletes a single branch record', async (t) => {
  const file = await makeRegistryFile(t)
  const repo = await makeTempRepo(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert(repo, { branch: 'b1', worktreePath: '/x', sessionIds: [], createdAt: 'now' })
  await reg.upsert(repo, { branch: 'b2', worktreePath: '/y', sessionIds: [], createdAt: 'now' })
  const removed = await reg.remove(repo, 'b1')
  assert.equal(removed?.branch, 'b1')
  assert.deepEqual((await reg.list(repo)).map((r) => r.branch), ['b2'])
})

test('reconcile drops records whose worktree is no longer registered in git', async (t) => {
  const file = await makeRegistryFile(t)
  const repo = await makeTempRepo(t)
  await addWorktree(repo, 'alive')
  const gonePath = worktreePathFor(repo, 'gone')
  await addWorktree(repo, 'gone')
  await removeWorktree(repo, gonePath, true)

  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert(repo, { branch: 'alive', worktreePath: worktreePathFor(repo, 'alive'), sessionIds: [], createdAt: 'now' })
  await reg.upsert(repo, { branch: 'gone', worktreePath: gonePath, sessionIds: [], createdAt: 'now' })

  const dropped = await reg.reconcile()
  assert.deepEqual(dropped.map((r) => r.branch), ['gone'])
  assert.deepEqual((await reg.list(repo)).map((r) => r.branch), ['alive'])
})

test('reconcile drops records for repositories that vanished from disk', async (t) => {
  const file = await makeRegistryFile(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert('/definitely/not/here', { branch: 'b1', worktreePath: '/x', sessionIds: [], createdAt: 'now' })
  const dropped = await reg.reconcile()
  assert.equal(dropped.length, 1)
  assert.deepEqual(await reg.list('/definitely/not/here'), [])
})

test('a corrupted registry file is treated as empty instead of crashing', async (t) => {
  const file = await makeRegistryFile(t)
  await writeFile(file, '{not json!!!')
  const reg = new BranchRegistry(file)
  await reg.load()
  const repo = await makeTempRepo(t)
  await reg.upsert(repo, { branch: 'b1', worktreePath: '/x', sessionIds: [], createdAt: 'now' })
  assert.equal((await reg.list(repo)).length, 1)
})

test('reconcile keeps records when the repo exists but git is transiently broken', async (t) => {
  const file = await makeRegistryFile(t)
  const repo = await makeTempRepo(t)
  const reg = new BranchRegistry(file)
  await reg.load()
  await reg.upsert(repo, { branch: 'b1', worktreePath: join(repo, '.branchspace', 'b1'), sessionIds: [], createdAt: 'now' })
  // break git for this repo: corrupt .git/HEAD
  await writeFile(join(repo, '.git', 'HEAD'), 'garbage-not-a-ref\n')
  const dropped = await reg.reconcile()
  assert.deepEqual(dropped, [], 'transient git failure must not drop records')
  assert.equal((await reg.list(repo)).length, 1)
})
