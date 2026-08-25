import { randomUUID } from 'node:crypto'
import type { SessionFactory } from './branchspace.js'
import {
  SessionId,
  WorkspaceId,
  type BranchspaceContext,
  type Workspace,
  type WorkspaceRegistryLike,
} from './dsh-types.js'

/**
 * Binds the Branchspace core to dsh's workspace/session/agent services.
 *
 * Mirrors the first-party flow in dsh-host-apiproxy: create the agent session
 * with `meta.cwd` equal to the workspace's canonical path first, then attach
 * it (attachSession validates realpath(header.cwd) === workspace.path).
 */
export class DshSessionFactory implements SessionFactory {
  constructor(private readonly ctx: BranchspaceContext) {}

  private get registry(): WorkspaceRegistryLike {
    return this.ctx.workspaceRegistry
  }

  async ensureWorkspace({ path, title }: { path: string; title: string }): Promise<string> {
    const existing = await this.registry.resolveByPath(path)
    if (existing) return existing.id
    const created = await this.registry.create(path, title)
    return created.id
  }

  async createSession({ workspaceId, cwd }: { workspaceId: string; cwd: string; title?: string }): Promise<string> {
    const workspace = this.registry.get(WorkspaceId(workspaceId))
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    const sessionId = SessionId(`session-${randomUUID()}`)
    await this.ctx.agents.create({
      sessionId,
      meta: { cwd }, // cwd === workspace.path (canonical) — attach validation requires equality
      agentOptions: { provider, model },
    })
    await workspace.attachSession(sessionId)
    return sessionId
  }

  async liveSessionIds(workspaceId: string): Promise<string[]> {
    const workspace: Workspace | undefined = this.registry.get(WorkspaceId(workspaceId))
    if (!workspace) return []
    return workspace.sessionIds.filter((id) => this.ctx.sessions.get(id) !== undefined)
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.registry.delete(WorkspaceId(workspaceId))
  }
}
