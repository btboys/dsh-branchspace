import type { Branchspace } from './branchspace.js'
import { BranchspaceError } from './git.js'
import type { HostConnectionLike, RpcResultLike } from './dsh-types.js'

export const RPC_CHANNEL = '/rpc/branchspace'

function ok<T>(value: T): RpcResultLike<T> {
  return { ok: true, value }
}

function fail(err: unknown): RpcResultLike<never> {
  const message = err instanceof Error ? err.message : String(err)
  // the wire schema is a closed union: bad-request requires `issues`, internal takes {}
  if (err instanceof BranchspaceError) {
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BranchspaceError(`missing or invalid string argument: ${key}`, 'BAD_INPUT')
  }
  return value
}

function optStr(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

/**
 * Host half of the client panel: one loopback RPC channel with unary
 * endpoints. The browser half calls these through ctx.connection.rpc.call.
 */
export async function registerRpc(connection: HostConnectionLike, branchspace: Branchspace): Promise<() => Promise<void>> {
  return connection.rpc.handle(
    RPC_CHANNEL,
    async (endpoint, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>
      try {
        switch (endpoint) {
          case 'start':
            return ok(
              await branchspace.start({
                repoPath: str(p, 'repoPath'),
                branch: str(p, 'branch'),
                baseBranch: optStr(p, 'baseBranch'),
              }),
            )
          case 'list':
            return ok(await branchspace.list({ repoPath: str(p, 'repoPath') }))
          case 'finish':
            return ok(
              await branchspace.finish({
                repoPath: str(p, 'repoPath'),
                branch: str(p, 'branch'),
                force: bool(p, 'force'),
                deleteBranch: bool(p, 'deleteBranch'),
              }),
            )
          case 'overview':
            return ok(await branchspace.overview())
          case 'defaultBase':
            return ok(await branchspace.defaultBase(str(p, 'repoPath')))
          default:
            return fail(new BranchspaceError(`unknown endpoint: ${endpoint}`, 'BAD_INPUT'))
        }
      } catch (err) {
        return fail(err)
      }
    },
    { authority: 'loopback' },
  )
}
