import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BranchspaceError, listWorktrees, resolveMainRepoRoot } from './git.js'

/** Canonicalize a path for comparison; missing paths compare as themselves. */
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

export interface BranchRecord {
  branch: string
  worktreePath: string
  workspaceId?: string
  sessionIds: string[]
  createdAt: string
}

interface RegistryFile {
  version: 1
  repos: Record<string, Record<string, BranchRecord>>
}

/** Default registry location: ~/.dsh/branchspace.json */
export function defaultRegistryPath(): string {
  return join(homedir(), '.dsh', 'branchspace.json')
}

/**
 * Plugin-owned branch registry persisted as JSON.
 * Reconciles with `git worktree list` so a dsh restart always matches disk reality.
 */
export class BranchRegistry {
  private data: RegistryFile = { version: 1, repos: {} }
  private writeQueue: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(readonly filePath: string = defaultRegistryPath()) {}

  /** Idempotent: repeat calls are no-ops, so service methods can always await it first. */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as RegistryFile
      if (parsed && typeof parsed === 'object' && parsed.repos && typeof parsed.repos === 'object') {
        this.data = { version: 1, repos: parsed.repos }
      }
    } catch {
      // missing or corrupted file: start empty (corrupted file gets overwritten on next write)
      this.data = { version: 1, repos: {} }
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    // serialize writes; a failed write must not poison the queue forever
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(this.data, null, 2))
      await rename(tmp, this.filePath)
    })
    return this.writeQueue
  }

  async list(repoPath: string): Promise<BranchRecord[]> {
    return Object.values(this.data.repos[repoPath] ?? {})
  }

  /** All repository paths currently tracked by the registry. */
  repos(): string[] {
    return Object.keys(this.data.repos)
  }

  async get(repoPath: string, branch: string): Promise<BranchRecord | undefined> {
    return this.data.repos[repoPath]?.[branch]
  }

  async upsert(repoPath: string, record: BranchRecord): Promise<BranchRecord> {
    const repo = (this.data.repos[repoPath] ??= {})
    const existing = repo[record.branch]
    repo[record.branch] = existing
      ? { ...existing, ...record, sessionIds: record.sessionIds ?? existing.sessionIds }
      : record
    await this.save()
    return repo[record.branch]
  }

  async setWorkspace(repoPath: string, branch: string, workspaceId: string): Promise<void> {
    const rec = this.data.repos[repoPath]?.[branch]
    if (!rec) throw new BranchspaceError(`unknown branch record: ${repoPath} ${branch}`, 'NO_RECORD')
    rec.workspaceId = workspaceId
    await this.save()
  }

  async attachSession(repoPath: string, branch: string, sessionId: string): Promise<void> {
    const rec = this.data.repos[repoPath]?.[branch]
    if (!rec) throw new BranchspaceError(`unknown branch record: ${repoPath} ${branch}`, 'NO_RECORD')
    if (!rec.sessionIds.includes(sessionId)) {
      rec.sessionIds.push(sessionId)
      await this.save()
    }
  }

  async remove(repoPath: string, branch: string): Promise<BranchRecord | undefined> {
    const rec = this.data.repos[repoPath]?.[branch]
    if (!rec) return undefined
    delete this.data.repos[repoPath][branch]
    if (Object.keys(this.data.repos[repoPath]).length === 0) delete this.data.repos[repoPath]
    await this.save()
    return rec
  }

  /**
   * Drop records whose worktree disappeared from `git worktree list`,
   * and records for repositories that no longer exist on disk.
   * Returns the dropped records (for logging / UI notification).
   *
   * Failure policy: a repo whose directory is gone (ENOENT) loses all its
   * records, but a repo that exists yet fails git interrogation (transient
   * I/O, corrupt .git, network mount hiccup) is LEFT UNTOUCHED — reconcile
   * must never destroy bookkeeping on a maybe-temporary error.
   */
  async reconcile(): Promise<BranchRecord[]> {
    const dropped: BranchRecord[] = []
    for (const [repoPath, branches] of Object.entries(this.data.repos)) {
      const dir = await stat(repoPath).catch(() => null)
      if (!dir?.isDirectory()) {
        // repo directory really gone: drop everything
        dropped.push(...Object.values(branches))
        delete this.data.repos[repoPath]
        continue
      }
      let livePaths: Set<string> | null = null
      try {
        const root = await resolveMainRepoRoot(repoPath)
        // both sides canonical before comparing: git may report non-realpath
        // spellings for worktrees registered through symlinked parents
        const worktrees = await listWorktrees(root)
        livePaths = new Set(await Promise.all(worktrees.map((w) => canonical(w.path))))
      } catch {
        continue // transient failure: keep this repo's records as-is
      }
      for (const [branch, rec] of Object.entries(branches)) {
        if (!livePaths.has(await canonical(rec.worktreePath))) {
          dropped.push(rec)
          delete branches[branch]
        }
      }
      if (Object.keys(branches).length === 0) delete this.data.repos[repoPath]
    }
    if (dropped.length > 0) await this.save()
    return dropped
  }
}
