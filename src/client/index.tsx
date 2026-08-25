/**
 * dsh-branchspace client half: a "⎇ Branches" entry in the sidebar footer
 * (`sidebar.footer.action` list slot) opening a panel that groups every
 * tracked repository's branch workspaces, with start/finish actions wired to
 * the host RPC channel `/rpc/branchspace`.
 */
import { useCallback, useEffect, useState } from 'react'

export const inject = ['slots', 'connection', 'sessions']

const CHANNEL = '/rpc/branchspace'

interface BranchView {
  branch: string
  worktreePath: string
  workspaceId?: string
  sessionCount: number
  liveCount: number
  dirty: boolean
  createdAt: string
}

interface RepoGroup {
  repoPath: string
  repoName: string
  branches: BranchView[]
}

type RpcOutcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Props the entry's inject factory bridges from the client context. */
export interface BranchspacePanelProps {
  wide?: boolean
  callRpc<T>(endpoint: string, payload: unknown): Promise<T>
  openSession(sessionId: string): void
}

interface ClientCtx {
  slots: {
    inject(key: string, callback: () => unknown): unknown
    register(entry: Record<string, unknown>, component: unknown): unknown
  }
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<RpcOutcome<never>>
    }
  }
  sessions?: {
    open?(sessionId: string): unknown
  }
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  },
  panel: {
    position: 'fixed',
    left: 12,
    bottom: 56,
    width: 340,
    maxHeight: '60vh',
    overflowY: 'auto',
    zIndex: 1000,
    borderRadius: 10,
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.35))',
    background: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-background, #1e1e1e))',
    boxShadow: '0 8px 30px rgba(0,0,0,.35)',
    padding: 10,
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  repoHeader: { fontWeight: 600, margin: '8px 0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  branchRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', borderRadius: 6 },
  muted: { opacity: 0.6 },
  dirty: { color: 'var(--dsw-alias-warning, #e5a50a)' },
  clean: { color: 'var(--dsw-alias-success, #3fb950)' },
  smallBtn: {
    marginLeft: 'auto',
    padding: '1px 8px',
    fontSize: 11,
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  disabledBtn: { opacity: 0.4, cursor: 'not-allowed' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 6px',
    fontSize: 12,
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.35))',
    background: 'transparent',
    color: 'inherit',
  },
  error: { color: 'var(--dsw-alias-error, #f85149)', whiteSpace: 'pre-wrap', margin: '6px 0' },
}

export function BranchspacePanel(props: BranchspacePanelProps): React.ReactElement {
  const { callRpc, openSession } = props
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<RepoGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newBranchFor, setNewBranchFor] = useState<string | null>(null)
  const [newBranchName, setNewBranchName] = useState('')

  const refresh = useCallback(async () => {
    try {
      setGroups(await callRpc<RepoGroup[]>('overview', {}))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [callRpc])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [open, refresh])

  const startBranch = async (repoPath: string) => {
    const branch = newBranchName.trim()
    if (!branch) return
    setBusy(true)
    try {
      const result = await callRpc<{ sessionId: string }>('start', { repoPath, branch })
      setNewBranchFor(null)
      setNewBranchName('')
      await refresh()
      openSession(result.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const finishBranch = async (repoPath: string, branch: string) => {
    if (!window.confirm(`Remove the worktree for ⎇ ${branch}? Uncommitted changes, if any, are discarded.`)) {
      return
    }
    setBusy(true)
    try {
      await callRpc('finish', { repoPath, branch })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button style={styles.button} onClick={() => setOpen((v) => !v)} title="Git branch workspaces (dsh-branchspace)">
        ⎇ Branches
      </button>
      {open && (
        <div style={styles.panel}>
          <div style={styles.repoHeader}>
            <span>Branch workspaces</span>
            <button style={{ ...styles.smallBtn, marginLeft: 0 }} onClick={() => void refresh()} title="Refresh">
              ↻
            </button>
          </div>
          {error && <div style={styles.error}>{error}</div>}
          {groups === null && !error && <div style={styles.muted}>Loading…</div>}
          {groups?.length === 0 && (
            <div style={styles.muted}>
              No branch sessions yet. Use <code>/branchspace start &lt;branch&gt;</code> inside a repo session, or the{' '}
              <code>branchspace_start</code> tool.
            </div>
          )}
          {groups?.map((group) => (
            <div key={group.repoPath}>
              <div style={styles.repoHeader}>
                <span title={group.repoPath}>{group.repoName}</span>
                <button
                  style={{ ...styles.smallBtn, marginLeft: 0 }}
                  onClick={() => {
                    setNewBranchFor(newBranchFor === group.repoPath ? null : group.repoPath)
                    setNewBranchName('')
                  }}
                >
                  ＋ New branch session
                </button>
              </div>
              {newBranchFor === group.repoPath && (
                <div style={{ display: 'flex', gap: 6, margin: '4px 0' }}>
                  <input
                    style={styles.input}
                    placeholder="branch name (e.g. feature-x)"
                    value={newBranchName}
                    autoFocus
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void startBranch(group.repoPath)
                      if (e.key === 'Escape') setNewBranchFor(null)
                    }}
                  />
                  <button
                    style={{
                      ...styles.smallBtn,
                      marginLeft: 0,
                      ...(busy || !newBranchName.trim() ? styles.disabledBtn : {}),
                    }}
                    disabled={busy || !newBranchName.trim()}
                    onClick={() => void startBranch(group.repoPath)}
                  >
                    Start
                  </button>
                </div>
              )}
              {group.branches.map((b) => (
                <div key={b.branch} style={styles.branchRow} title={b.worktreePath}>
                  <span style={b.dirty ? styles.dirty : styles.clean}>{b.dirty ? '●' : '○'}</span>
                  <span>⎇ {b.branch}</span>
                  <span style={styles.muted}>
                    {b.sessionCount} session{b.sessionCount === 1 ? '' : 's'}
                    {b.liveCount > 0 ? ` (${b.liveCount} live)` : ''}
                  </span>
                  <button
                    style={{ ...styles.smallBtn, ...(busy || b.liveCount > 0 ? styles.disabledBtn : {}) }}
                    disabled={busy || b.liveCount > 0}
                    title={
                      b.liveCount > 0
                        ? `${b.liveCount} live session(s) attached — close them before finishing this branch`
                        : 'Remove the worktree (keeps the branch and all session logs)'
                    }
                    onClick={() => void finishBranch(group.repoPath, b.branch)}
                  >
                    Finish
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export function apply(ctx: unknown): void {
  const client = ctx as ClientCtx
  client.slots.inject('sidebar.footer.action', () =>
    client.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'branchspace',
        inject: () => ({
          callRpc: async <T,>(endpoint: string, payload: unknown): Promise<T> => {
            const result = (await client.connection.rpc.call(CHANNEL, endpoint, payload)) as RpcOutcome<T>
            if (!result.ok) throw new Error(result.error.message)
            return result.value
          },
          openSession: (sessionId: string) => {
            client.sessions?.open?.(sessionId)
          },
        }),
      },
      BranchspacePanel,
    ),
  )
}
