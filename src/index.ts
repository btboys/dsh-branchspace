/**
 * dsh-branchspace — git branch workspaces for DeepSeek Harness.
 *
 * One branch = one git worktree under <repo>/.branchspace/ + one built-in dsh
 * workspace + any number of sessions. Host entry point; the client half lives
 * in ./client and is declared via package.json `dsh.client`.
 *
 * @module dsh-branchspace
 */
import type { Context } from '@deepseek-ai/cordis'
import { Branchspace } from './branchspace.js'
import { registerCommands } from './commands.js'
import { BranchRegistry, defaultRegistryPath } from './registry.js'
import { DshSessionFactory } from './factory.js'
import { registerRpc } from './rpc.js'
import { registerTools } from './tools.js'
import type {
  AgentDefaultModelLike,
  AgentRegistryLike,
  BranchspaceContext,
  CommandRuntimeLike,
  HostConnectionLike,
  SessionStoreLike,
  ToolRuntimeLike,
  WorkspaceRegistryLike,
} from './dsh-types.js'

export { Branchspace } from './branchspace.js'
export { BranchRegistry, defaultRegistryPath } from './registry.js'
export { BranchspaceError } from './git.js'
export type { BranchView, FinishInput, FinishResult, StartInput, StartResult } from './branchspace.js'
export type { BranchRecord } from './registry.js'

export const name = 'branchspace'

/** Hard service dependencies; the fiber activates only once all exist. */
export const inject = ['workspaceRegistry', 'sessions', 'agents', 'agentDefaultModel', 'commands']

export interface BranchspacePluginConfig {
  /** Registry file location. Defaults to ~/.dsh/branchspace.json. */
  registryPath?: string
}

export function apply(ctx: Context, config?: BranchspacePluginConfig): void {
  const host = ctx as BranchspaceContext

  const registry = new BranchRegistry(config?.registryPath ?? defaultRegistryPath())
  const branchspace = new Branchspace({ registry, sessions: new DshSessionFactory(host) })

  const ready = (async () => {
    await registry.load()
    const dropped = await branchspace.reconcile()
    if (dropped.length > 0) {
      ctx.logger?.warn(
        `branchspace: dropped ${dropped.length} stale record(s) whose worktrees vanished: ${dropped
          .map((r) => r.branch)
          .join(', ')}`,
      )
    }
  })()

  const dispose: (() => void)[] = []
  dispose.push(registerCommands(host.commands, branchspace))

  // optional halves: register as soon as their services become available
  ctx.inject(['tools'], (injected) => {
    dispose.push(registerTools((injected as unknown as { tools: ToolRuntimeLike }).tools, branchspace))
  })
  ctx.inject(['connection'], (injected) => {
    let disposeRpc: (() => Promise<void>) | undefined
    void ready.then(async () => {
      disposeRpc = await registerRpc((injected as unknown as { connection: HostConnectionLike }).connection, branchspace)
    })
    return () => void disposeRpc?.()
  })
}

// type-level assertion that the declared inject names match the typed view
type _AssertServices = [
  WorkspaceRegistryLike,
  SessionStoreLike,
  AgentRegistryLike,
  AgentDefaultModelLike,
  CommandRuntimeLike,
]
export type { _AssertServices }
