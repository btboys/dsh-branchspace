import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

export class BranchspaceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'BranchspaceError'
  }
}

export const GIT_TIMEOUT_MS = 30_000

/** Run git with execFile (no shell), returning trimmed stdout. */
export async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : ''
        reject(new BranchspaceError(`git ${args.join(' ')} failed${detail}`, 'GIT_FAILED'))
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Resolve `repoPath` to the canonical main-repository root.
 * Rejects non-repos and linked worktrees (a linked worktree has a `.git` *file*
 * instead of a `.git` directory, so it can never be a branchspace host).
 */
export async function resolveMainRepoRoot(repoPath: string): Promise<string> {
  let top: string
  try {
    top = await runGit(['rev-parse', '--show-toplevel'], repoPath)
  } catch {
    throw new BranchspaceError(`not a git repository: ${repoPath}`, 'NOT_A_REPO')
  }
  const root = await realpath(top)
  const dotGit = await stat(join(root, '.git')).catch(() => null)
  if (!dotGit?.isDirectory()) {
    throw new BranchspaceError(
      `${repoPath} is a linked worktree, not a main repository; pass the main repository path instead`,
      'IS_WORKTREE',
    )
  }
  return root
}

const INVALID_REF_CHARS = /[\x00-\x20\x7f ~^:?*[\\]/

/**
 * Validate a branch name against git ref rules (mirrors `git check-ref-format --branch`).
 * Returns `null` when valid, otherwise a human-readable rejection reason.
 */
export function validateBranchName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'branch name must not be empty'
  if (name.length > 200) return 'branch name is too long (max 200 characters)'
  if (name.startsWith('-')) return 'branch name must not start with a dash'
  if (name.includes('..')) return 'branch name must not contain ".."'
  if (INVALID_REF_CHARS.test(name)) return 'branch name contains illegal characters (space/control/~^:?*[\\)'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'branch name must not start/end with or repeat "/"'
  if (name.endsWith('.')) return 'branch name must not end with a dot'
  if (name === '@' || name.includes('@{')) return 'branch name must not be "@" or contain "@{"'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'branch name components must not start with a dot'
    if (part.endsWith('.lock')) return 'branch name components must not end with ".lock"'
  }
  return null
}

/**
 * Map a branch name to a filesystem-safe directory name under `.branchspace/`.
 * The encoding is injective: distinct branches never share a directory.
 */
export function worktreeDirName(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/g, (ch) =>
    [...Buffer.from(ch, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''),
  )
}

export const BRANCHSPACE_DIR = '.branchspace'

/** The path where the worktree for `branch` lives inside `repoRoot`. */
export function worktreePathFor(repoRoot: string, branch: string): string {
  return join(repoRoot, BRANCHSPACE_DIR, worktreeDirName(branch))
}

export interface WorktreeInfo {
  path: string
  branch: string | null
}

/** Current branch of the repo (falling back to `main` on a detached head). */
export async function defaultBranch(repoRoot: string): Promise<string> {
  const current = await runGit(['branch', '--show-current'], repoRoot)
  return current || 'main'
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
    return true
  } catch {
    return false
  }
}

/**
 * Create (or reuse) the worktree for `branch` under `<repoRoot>/.branchspace/`.
 * Uses `-b <branch> <baseBranch>` for new branches; existing branches are reused
 * without `-b`. Idempotent: if the worktree is already registered, returns its path.
 *
 * The returned path is canonical (`fs.realpath`): every downstream consumer —
 * session cwd, workspace registration, registry persistence — must never see
 * the joined literal, because symlinked prefixes (/tmp, $HOME) would otherwise
 * break dsh's `realpath`-based cwd validation.
 *
 * Rollback safety: a `git worktree list` snapshot is taken before `add`; on
 * failure the target worktree is removed only when it was absent from that
 * snapshot (i.e. provably created by this call). Anything pre-existing is
 * never touched.
 */
export async function addWorktree(repoRoot: string, branch: string, baseBranch?: string): Promise<string> {
  const invalid = validateBranchName(branch)
  if (invalid) throw new BranchspaceError(`invalid branch name ${JSON.stringify(branch)}: ${invalid}`, 'INVALID_BRANCH')
  const snapshot = await listWorktrees(repoRoot)
  const snapshotPaths = new Set(snapshot.map((w) => w.path))
  const literal = worktreePathFor(repoRoot, branch)
  const found = snapshot.find((w) => w.path === literal)
  if (found) return realpath(found.path)
  const args = ['worktree', 'add', literal]
  if (await branchExists(repoRoot, branch)) {
    args.push(branch)
  } else {
    args.push('-b', branch, baseBranch ?? (await defaultBranch(repoRoot)))
  }
  try {
    await runGit(args, repoRoot)
  } catch (err) {
    // rollback only what THIS call created
    const now = await listWorktrees(repoRoot).catch(() => [] as WorktreeInfo[])
    const created = now.find((w) => w.path === literal)
    if (created && !snapshotPaths.has(created.path)) {
      await runGit(['worktree', 'remove', '--force', literal], repoRoot).catch(() => {})
    }
    throw err
  }
  return realpath(literal)
}

/** Parse `git worktree list --porcelain` into structured records. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const out = await runGit(['worktree', 'list', '--porcelain'], repoRoot)
  const result: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null }
      result.push(current)
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  return result
}

/** True when the worktree has uncommitted changes (tracked or untracked). */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const out = await runGit(['status', '--porcelain'], worktreePath)
  return out.length > 0
}

/** Append `.branchspace/` to `.git/info/exclude` (idempotent). */
export async function ensureBranchspaceExcluded(repoRoot: string): Promise<void> {
  const { mkdir, readFile, appendFile } = await import('node:fs/promises')
  const infoDir = join(repoRoot, '.git', 'info')
  await mkdir(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')
  const content = await readFile(excludePath, 'utf8').catch(() => '')
  if (content.split('\n').some((l) => l.trim() === `${BRANCHSPACE_DIR}/`)) return
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  await appendFile(excludePath, `${prefix}${BRANCHSPACE_DIR}/\n`)
}

/** Remove a worktree. Dirty worktrees require `force`. */
export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  await runGit(args, repoRoot)
}

/** Delete a local branch (its worktree must already be removed). */
export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  await runGit(['branch', '-D', branch], repoRoot)
}
