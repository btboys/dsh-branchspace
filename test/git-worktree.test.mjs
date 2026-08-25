import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { makeTempRepo, git, writeRepoFile } from './helpers.mjs'
import {
  resolveMainRepoRoot,
  defaultBranch,
  branchExists,
  addWorktree,
  listWorktrees,
  isWorktreeDirty,
  ensureBranchspaceExcluded,
  removeWorktree,
  deleteBranch,
  worktreeDirName,
} from '../lib/git.js'

test('defaultBranch returns the current branch when no origin exists', async (t) => {
  const repo = await makeTempRepo(t)
  assert.equal(await defaultBranch(repo), 'main')
})

test('addWorktree creates .branchspace/<dir> worktree on a new branch from the base', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  assert.equal(wtPath, join(repo, '.branchspace', worktreeDirName('feature-a')))
  assert.ok((await stat(wtPath)).isDirectory())
  assert.ok(await branchExists(repo, 'feature-a'))
  assert.equal(await git(['branch', '--show-current'], wtPath), 'feature-a')
  // file content comes from base branch
  assert.equal(await readFile(join(wtPath, 'README.md'), 'utf8'), '# test\n')
})

test('addWorktree respects an explicit baseBranch', async (t) => {
  const repo = await makeTempRepo(t)
  await git(['checkout', '-b', 'base-x'], repo)
  await writeRepoFile(repo, 'base.txt', 'from base-x')
  await git(['add', '.'], repo)
  await git(['commit', '-m', 'base commit'], repo)
  await git(['checkout', 'main'], repo)
  const wtPath = await addWorktree(repo, 'feature-b', 'base-x')
  assert.equal(await readFile(join(wtPath, 'base.txt'), 'utf8'), 'from base-x')
})

test('addWorktree reuses an existing branch without -b', async (t) => {
  const repo = await makeTempRepo(t)
  await git(['branch', 'existing'], repo)
  const wtPath = await addWorktree(repo, 'existing')
  assert.equal(await git(['branch', '--show-current'], wtPath), 'existing')
})

test('addWorktree rolls back nothing and stays idempotent when called twice', async (t) => {
  const repo = await makeTempRepo(t)
  const first = await addWorktree(repo, 'feature-a')
  const second = await addWorktree(repo, 'feature-a')
  assert.equal(first, second)
  const worktrees = await listWorktrees(repo)
  assert.equal(worktrees.filter((w) => w.branch === 'feature-a').length, 1)
})

test('listWorktrees includes the main repo and branchspace worktrees', async (t) => {
  const repo = await makeTempRepo(t)
  await addWorktree(repo, 'feature-a')
  const list = await listWorktrees(repo)
  assert.ok(list.some((w) => w.path === repo && w.branch === 'main'))
  assert.ok(list.some((w) => w.path === join(repo, '.branchspace', worktreeDirName('feature-a')) && w.branch === 'feature-a'))
})

test('isWorktreeDirty reflects uncommitted changes', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  assert.equal(await isWorktreeDirty(wtPath), false)
  await writeRepoFile(wtPath, 'dirty.txt', 'dirty')
  assert.equal(await isWorktreeDirty(wtPath), true)
  await git(['add', '.'], wtPath)
  await git(['commit', '-m', 'commit dirty'], wtPath)
  assert.equal(await isWorktreeDirty(wtPath), false)
})

test('ensureBranchspaceExcluded appends .branchspace/ to .git/info/exclude idempotently', async (t) => {
  const repo = await makeTempRepo(t)
  await ensureBranchspaceExcluded(repo)
  await ensureBranchspaceExcluded(repo)
  const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split('\n').filter((l) => l.trim() === '.branchspace/').length, 1)
  // .branchspace is now ignored by git status
  await addWorktree(repo, 'feature-a')
  assert.equal(await isWorktreeDirty(repo), false)
})

test('removeWorktree refuses a dirty worktree unless forced, keeps the branch', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  await writeRepoFile(wtPath, 'dirty.txt', 'dirty')
  await assert.rejects(() => removeWorktree(repo, wtPath, false))
  await removeWorktree(repo, wtPath, true)
  await assert.rejects(() => stat(wtPath))
  assert.ok(await branchExists(repo, 'feature-a'), 'branch survives worktree removal')
})

test('deleteBranch removes a branch after its worktree is gone', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  await removeWorktree(repo, wtPath, false)
  await deleteBranch(repo, 'feature-a')
  assert.equal(await branchExists(repo, 'feature-a'), false)
})

test('resolveMainRepoRoot is not fooled by the branchspace worktree it created', async (t) => {
  const repo = await makeTempRepo(t)
  const wtPath = await addWorktree(repo, 'feature-a')
  await assert.rejects(() => resolveMainRepoRoot(wtPath), /worktree/i)
})

test('addWorktree reuse check is canonical: a worktree registered via a symlink spelling is reused', async (t) => {
  const repo = await makeTempRepo(t)
  const { symlink, mkdtemp, realpath } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const linkBase = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-canon-')))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(linkBase, { recursive: true, force: true })))
  const link = join(linkBase, 'repo-link')
  await symlink(repo, link)
  // register the worktree through the NON-canonical symlinked spelling
  const literalViaLink = join(link, '.branchspace', worktreeDirName('feature-a'))
  await git(['worktree', 'add', literalViaLink, '-b', 'feature-a'], repo)
  // addWorktree through the canonical root must reuse, not fail with "already exists"
  const wtPath = await addWorktree(repo, 'feature-a')
  assert.equal(wtPath, join(repo, '.branchspace', worktreeDirName('feature-a')))
  const list = await listWorktrees(repo)
  assert.equal(list.filter((w) => w.branch === 'feature-a').length, 1)
})
