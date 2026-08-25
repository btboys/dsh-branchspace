import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BranchspaceError, listWorktrees, resolveMainRepoRoot } from './git.js'

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

  constructor(readonly filePath: string = defaultRegistryPath()) {}

  async load(): Promise<void> {
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
  }

  private async save(): Promise<void> {
    // serialize writes to avoid interleaved partial JSON
    this.writeQueue = this.writeQueue.then(async () => {
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
   */
  async reconcile(): Promise<BranchRecord[]> {
    const dropped: BranchRecord[] = []
    for (const [repoPath, branches] of Object.entries(this.data.repos)) {
      let livePaths: Set<string> | null = null
      try {
        const root = await resolveMainRepoRoot(repoPath)
        livePaths = new Set((await listWorktrees(root)).map((w) => w.path))
      } catch {
        livePaths = null // repo gone or unreadable
      }
      for (const [branch, rec] of Object.entries(branches)) {
        if (livePaths === null || !livePaths.has(rec.worktreePath)) {
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
