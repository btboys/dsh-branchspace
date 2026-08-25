/**
 * Minimal structural typings for the dsh host services this plugin consumes.
 *
 * The published dsh packages on npm lag behind the installed runtime
 * (0.1.0-rc.7), so instead of compiling against stale registry types this
 * plugin declares the exact service surfaces it uses (mirrored from the
 * installed `lib/types/*.d.ts` files) and binds them at runtime through the
 * cordis `Context`. Services are looked up by name; the cordis fiber only
 * activates after every name in `inject` is provided.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Branded id factories are plain casts at runtime. */
export type SessionId = string & { readonly __brand: 'SessionId' }
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export const SessionId = (id: string): SessionId => id as SessionId
export const WorkspaceId = (id: string): WorkspaceId => id as WorkspaceId

export interface Workspace {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  attachSession(sessionId: SessionId): Promise<void>
  detachSession(sessionId: SessionId): Promise<void>
  setTitle(title: string): Promise<void>
}

/** ctx.workspaceRegistry — @deepseek-ai/dsh-workspace */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<Workspace>
  resolveByPath(path: string): Promise<Workspace | undefined>
  get(id: WorkspaceId): Workspace | undefined
  list(): Workspace[]
  delete(id: WorkspaceId): Promise<boolean>
}

export interface SessionHeaderLike {
  readonly cwd?: string
}

export interface SessionLike {
  readonly id: SessionId
  readonly header: SessionHeaderLike
}

/** ctx.sessions — @deepseek-ai/dsh-session */
export interface SessionStoreLike {
  get(id: SessionId): SessionLike | undefined
  list(): SessionLike[]
}

export interface AgentLike {
  readonly id: SessionId
  readonly session: SessionLike
}

export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** ctx.agents — @deepseek-ai/dsh-agent */
export interface AgentRegistryLike {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string }
    agentOptions?: { provider: string; model: string }
  }): Promise<AgentHandleLike>
  get(id: SessionId): AgentLike | undefined
}

/** ctx.agentDefaultModel — @deepseek-ai/dsh-agent-default-model */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

export interface CommandInvocationLike {
  readonly agent: AgentLike
  readonly rawInput: string
  readonly signal: AbortSignal
}

export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** ctx.commands — @deepseek-ai/dsh-commands */
export interface CommandRuntimeLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): () => void
}

/** ctx.tools — @deepseek-ai/dsh-tools */
export interface ToolRuntimeLike {
  register(definition: unknown): () => void
}

export type RpcResultLike<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** ctx.connection — @deepseek-ai/dsh-client-connection (host half) */
export interface HostConnectionLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResultLike<unknown>>,
      options: { authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void>
  }
}

/** The exact host-service view this plugin's context provides. */
export interface BranchspaceContext extends Context {
  workspaceRegistry: WorkspaceRegistryLike
  sessions: SessionStoreLike
  agents: AgentRegistryLike
  agentDefaultModel: AgentDefaultModelLike
  commands: CommandRuntimeLike
}
