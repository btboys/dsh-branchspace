import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { realpath, symlink, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { makeTempRepo, git, writeRepoFile } from './helpers.mjs'
import { addWorktree, listWorktrees, worktreeDirName } from '../lib/git.js'

test('addWorktree failure rolls back nothing pre-existing and leaves no worktree behind', async (t) => {
  const repo = await makeTempRepo(t)
  const before = await listWorktrees(repo)
  const other = await addWorktree(repo, 'pre-existing') // a worktree created BEFORE the failing call
  await assert.rejects(() => addWorktree(repo, 'new-branch', 'no-such-base'))
  const after = await listWorktrees(repo)
  assert.deepEqual(after.map((w) => w.path).sort(), [...before.map((w) => w.path), other].sort())
})

test('addWorktree returns the canonical (realpath) worktree path', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  assert.equal(wtPath, await realpath(join(repo, '.branchspace', worktreeDirName('feature-a'))))
})

test('a repo reached through a symlinked directory yields canonical worktree paths', async (t) => {
  const repo = await makeTempRepo(t)
  // link parent: <link>/repo -> real repo
  const linkBase = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-link-')))
  t.after(() => rm(linkBase, { recursive: true, force: true }))
  const link = join(linkBase, 'repo-link')
  await symlink(repo, link)
  const viaLink = join(link, '.') // deliberately non-canonical spelling
  const { resolveMainRepoRoot } = await import('../lib/git.js')
  const root = await resolveMainRepoRoot(viaLink)
  assert.equal(root, repo, 'repoPath is canonicalized before any comparison')
  const wtPath = await addWorktree(root, 'feature-a')
  assert.equal(wtPath, join(repo, '.branchspace', worktreeDirName('feature-a')))
  assert.equal(wtPath, await realpath(wtPath))
})
