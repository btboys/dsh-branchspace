import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { makeTempRepo, git } from './helpers.mjs'
import { resolveMainRepoRoot, BranchspaceError } from '../lib/git.js'

test('resolveMainRepoRoot returns the repo root for the repo path itself', async (t) => {
  const repo = await makeTempRepo(t)
  const root = await resolveMainRepoRoot(repo)
  assert.equal(root, repo)
})

test('resolveMainRepoRoot resolves a nested subdirectory to the repo root', async (t) => {
  const repo = await makeTempRepo(t)
  await mkdir(join(repo, 'src/deep'), { recursive: true })
  const root = await resolveMainRepoRoot(join(repo, 'src/deep'))
  assert.equal(root, repo)
})

test('resolveMainRepoRoot rejects a path that is not a git repository', async (t) => {
  const repo = await makeTempRepo(t)
  const outside = join(repo, '..', 'not-a-repo-' + Date.now())
  await mkdir(outside, { recursive: true })
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(outside, { recursive: true, force: true })))
  await assert.rejects(() => resolveMainRepoRoot(outside), BranchspaceError)
})

test('resolveMainRepoRoot rejects a linked worktree path', async (t) => {
  const repo = await makeTempRepo(t)
  const wt = join(repo, '..', 'linked-wt-' + Date.now())
  await git(['worktree', 'add', wt, '-b', 'linked'], repo)
  t.after(() => git(['worktree', 'remove', '--force', wt], repo).catch(() => {}))
  await assert.rejects(() => resolveMainRepoRoot(wt), /worktree/i)
})
