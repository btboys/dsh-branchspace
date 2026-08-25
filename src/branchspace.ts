import { basename } from 'node:path'
import {
  BranchspaceError,
  addWorktree,
  branchExists,
  defaultBranch,
  deleteBranch,
  ensureBranchspaceExcluded,
  isWorktreeDirty,
  listWorktrees,
  removeWorktree,
  resolveMainRepoRoot,
  validateBranchName,
  worktreePathFor,
} from './git.js'
import type { BranchRecord, BranchRegistry } from './registry.js'

/** Port into dsh: the plugin binds this to workspaceRegistry + session services. */
export interface SessionFactory {
  /** Register (or reuse by path) a dsh workspace; returns its uuid. */
  ensureWorkspace(input: { path: string; title: string }): Promise<string>
  /** Create a dsh session attached to the workspace; cwd must equal the workspace path. */
  createSession(input: { workspaceId: string; cwd: string; title?: string }): Promise<string>
  /** Live (in-memory, running) sessions currently mounted on the workspace. */
  liveSessionIds(workspaceId: string): Promise<string[]>
  /** Remove the workspace record (session logs are never deleted). */
  removeWorkspace?(workspaceId: string): Promise<void>
}

export interface BranchspaceDeps {
  registry: BranchRegistry
  sessions: SessionFactory
  /** Derive a display name for a repo path (defaults to basename). */
  repoName?: (repoRoot: string) => string
}

export interface StartInput {
  repoPath: string
  branch: string
  baseBranch?: string
}

export interface StartResult {
  sessionId: string
  workspaceId: string
  worktreePath: string
  branch: string
}

export interface ListInput {
  repoPath: string
}

export interface BranchView {
  branch: string
  worktreePath: string
  workspaceId?: string
  sessionCount: number
  sessionIds: string[]
  /** Live (in-memory) sessions mounted on this branch's workspace. */
  liveCount: number
  dirty: boolean
  createdAt: string
}

export interface FinishInput {
  repoPath: string
  branch: string
  force?: boolean
  deleteBranch?: boolean
}

export interface FinishResult {
  branch: string
  worktreePath: string
  removedWorkspaceId?: string
  /** Live sessions whose cwd vanished because finish was forced. Empty otherwise. */
  orphanedSessionIds: string[]
  deletedBranch: boolean
}

/** In-process keyed mutex: serializes start/finish per (canonicalRepoPath, branch). */
class KeyedMutex {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const next = tail.then(() => gate)
    this.tails.set(key, next)
    await tail
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}

export class Branchspace {
  private readonly mutex = new KeyedMutex()

  constructor(private readonly deps: BranchspaceDeps) {}

  private repoName(root: string): string {
    return this.deps.repoName?.(root) ?? basename(root)
  }

  private lockKey(root: string, branch: string): string {
    return JSON.stringify([root, branch])
  }

  /** Reconcile the registry with disk before answering (restart / crash recovery). */
  async reconcile(): Promise<BranchRecord[]> {
    return this.deps.registry.reconcile()
  }

  async start(input: StartInput): Promise<StartResult> {
    await this.deps.registry.load()
    const invalid = validateBranchName(input.branch)
    if (invalid) {
      throw new BranchspaceError(`invalid branch name ${JSON.stringify(input.branch)}: ${invalid}`, 'INVALID_BRANCH')
    }
    const root = await resolveMainRepoRoot(input.repoPath)
    return this.mutex.run(this.lockKey(root, input.branch), async () => {
      if (input.baseBranch) {
        const invalidBase = validateBranchName(input.baseBranch)
        if (invalidBase) {
          throw new BranchspaceError(`invalid base branch ${JSON.stringify(input.baseBranch)}: ${invalidBase}`, 'INVALID_BRANCH')
        }
        if (!(await branchExists(root, input.baseBranch))) {
          throw new BranchspaceError(`base branch does not exist: ${input.baseBranch}`, 'NO_BASE')
        }
      }
      await ensureBranchspaceExcluded(root)
      const worktreePath = await addWorktree(root, input.branch, input.baseBranch)

      const title = `${this.repoName(root)} ⎇ ${input.branch}`
      // idempotent reuse: canonical-path-keyed registry record wins
      const existing = await this.deps.registry.get(root, input.branch)
      const workspaceId =
        existing?.workspaceId ??
        (await this.deps.sessions.ensureWorkspace({ path: worktreePath, title }))
      const sessionId = await this.deps.sessions.createSession({ workspaceId, cwd: worktreePath, title })

      await this.deps.registry.upsert(root, {
        branch: input.branch,
        worktreePath,
        workspaceId,
        sessionIds: existing?.sessionIds ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      })
      await this.deps.registry.attachSession(root, input.branch, sessionId)
      return { sessionId, workspaceId, worktreePath, branch: input.branch }
    })
  }

  async list(input: ListInput): Promise<BranchView[]> {
    await this.deps.registry.load()
    const root = await resolveMainRepoRoot(input.repoPath)
    await this.deps.registry.reconcile()
    const records = await this.deps.registry.list(root)
    return Promise.all(
      records.map(async (rec) => ({
        branch: rec.branch,
        worktreePath: rec.worktreePath,
        workspaceId: rec.workspaceId,
        sessionCount: rec.sessionIds.length,
        sessionIds: [...rec.sessionIds],
        liveCount: rec.workspaceId ? (await this.deps.sessions.liveSessionIds(rec.workspaceId)).length : 0,
        dirty: await isWorktreeDirty(rec.worktreePath).catch(() => false),
        createdAt: rec.createdAt,
      })),
    )
  }

  async finish(input: FinishInput): Promise<FinishResult> {
    await this.deps.registry.load()
    const root = await resolveMainRepoRoot(input.repoPath)
    return this.mutex.run(this.lockKey(root, input.branch), async () => {
      const rec = await this.deps.registry.get(root, input.branch)
      const worktreePath = rec?.worktreePath ?? worktreePathFor(root, input.branch)

      // active-session protection: never strand a live session's cwd by default
      const live = rec?.workspaceId ? await this.deps.sessions.liveSessionIds(rec.workspaceId) : []
      if (live.length > 0 && !input.force) {
        throw new BranchspaceError(
          `branch "${input.branch}" still has ${live.length} live session(s) attached (${live.join(', ')}); ` +
            `close them first or pass force`,
          'LIVE_SESSIONS',
        )
      }
      // the worktree may have been removed out-of-band; only then skip git removal
      const stillRegistered = (await listWorktrees(root)).some(
        (w) => w.path === worktreePath || w.branch === input.branch,
      )
      if (stillRegistered && !input.force && (await isWorktreeDirty(worktreePath))) {
        throw new BranchspaceError(
          `worktree for branch "${input.branch}" is dirty; commit/stash changes or pass force`,
          'DIRTY_WORKTREE',
        )
      }
      if (stillRegistered) {
        await removeWorktree(root, worktreePath, Boolean(input.force))
      }
      let deletedBranch = false
      if (input.deleteBranch) {
        await deleteBranch(root, input.branch)
        deletedBranch = true
      }
      const removed = await this.deps.registry.remove(root, input.branch)
      if (removed?.workspaceId && this.deps.sessions.removeWorkspace) {
        await this.deps.sessions.removeWorkspace(removed.workspaceId).catch(() => {})
      }
      return {
        branch: input.branch,
        worktreePath,
        removedWorkspaceId: removed?.workspaceId,
        orphanedSessionIds: input.force ? live : [],
        deletedBranch,
      }
    })
  }

  /** Default base branch of a repo (used by UI hints). */
  async defaultBase(repoPath: string): Promise<string> {
    return defaultBranch(await resolveMainRepoRoot(repoPath))
  }

  /** Every tracked repository with its branch views — the UI panel's data shape. */
  async overview(): Promise<{ repoPath: string; repoName: string; branches: BranchView[] }[]> {
    await this.deps.registry.load()
    await this.deps.registry.reconcile()
    const out: { repoPath: string; repoName: string; branches: BranchView[] }[] = []
    for (const repoPath of this.deps.registry.repos()) {
      try {
        out.push({ repoPath, repoName: this.repoName(repoPath), branches: await this.list({ repoPath }) })
      } catch {
        // repo unreadable right now; reconcile already dropped its records
      }
    }
    return out
  }
}
