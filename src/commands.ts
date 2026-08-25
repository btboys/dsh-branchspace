import { Branchspace } from './branchspace.js'
import { BranchspaceError } from './git.js'
import type { CommandInvocationLike, CommandResultLike, CommandRuntimeLike } from './dsh-types.js'

const USAGE = [
  'Usage:',
  '  /branchspace start <branch> [baseBranch] [repoPath]  — create a worktree + workspace + session for a branch',
  '  /branchspace list [repoPath]                          — list branchspace branches of a repo',
  '  /branchspace finish <branch> [--force] [--delete-branch] [repoPath] — remove worktree (+ optionally the branch)',
  '',
  'repoPath defaults to the current session cwd.',
].join('\n')

interface ParsedArgs {
  positional: string[]
  force: boolean
  deleteBranch: boolean
}

function parseFlags(raw: string): ParsedArgs {
  const positional: string[] = []
  let force = false
  let deleteBranch = false
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token === '--force' || token === '-f') force = true
    else if (token === '--delete-branch' || token === '--delete') deleteBranch = true
    else positional.push(token)
  }
  return { positional, force, deleteBranch }
}

function errorResult(err: unknown): CommandResultLike {
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'error', text: message }
}

/** Register the `/branchspace` human command on the shared command runtime. */
export function registerCommands(commands: CommandRuntimeLike, branchspace: Branchspace): () => void {
  return commands.register({
    name: 'branchspace',
    description: 'Git branch workspaces: start/list/finish isolated branch sessions (git worktree per branch)',
    input: { hint: 'start <branch> [base] [repo] | list [repo] | finish <branch> [--force] [--delete-branch] [repo]' },
    async handler(invocation: CommandInvocationLike): Promise<CommandResultLike> {
      const cwd = invocation.agent.session.header.cwd
      const { positional, force, deleteBranch } = parseFlags(invocation.rawInput)
      const sub = positional[0]

      try {
        switch (sub) {
          case 'start': {
            const branch = positional[1]
            if (!branch) return { kind: 'error', text: USAGE }
            const repoPath = positional[3] ?? cwd
            if (!repoPath) return { kind: 'error', text: 'no repoPath given and the current session has no cwd\n' + USAGE }
            const result = await branchspace.start({ repoPath, branch, baseBranch: positional[2] })
            return {
              kind: 'success',
              text: [
                `⎇ ${result.branch} ready`,
                `  worktree:  ${result.worktreePath}`,
                `  workspace: ${result.workspaceId}`,
                `  session:   ${result.sessionId} (open it from the sidebar group)`,
              ].join('\n'),
            }
          }
          case 'list': {
            const repoPath = positional[1] ?? cwd
            if (!repoPath) return { kind: 'error', text: 'no repoPath given and the current session has no cwd\n' + USAGE }
            const rows = await branchspace.list({ repoPath })
            if (rows.length === 0) return { kind: 'success', text: 'No branchspace branches for this repository.' }
            return {
              kind: 'success',
              text: rows
                .map(
                  (r) =>
                    `${r.dirty ? '●' : '○'} ⎇ ${r.branch}  — ${r.sessionCount} session(s)` +
                    `\n    ${r.worktreePath}`,
                )
                .join('\n'),
            }
          }
          case 'finish': {
            const branch = positional[1]
            if (!branch) return { kind: 'error', text: USAGE }
            const repoPath = positional[2] ?? cwd
            if (!repoPath) return { kind: 'error', text: 'no repoPath given and the current session has no cwd\n' + USAGE }
            const result = await branchspace.finish({ repoPath, branch, force, deleteBranch })
            return {
              kind: 'success',
              text: [
                `⎇ ${result.branch} finished`,
                `  worktree removed: ${result.worktreePath}`,
                result.deletedBranch ? '  branch deleted' : '  branch kept',
                ...(result.orphanedSessionIds.length > 0
                  ? [`  orphaned sessions (cwd gone): ${result.orphanedSessionIds.join(', ')}`]
                  : []),
              ].join('\n'),
            }
          }
          default:
            return { kind: 'error', text: USAGE }
        }
      } catch (err) {
        if (err instanceof BranchspaceError) return errorResult(err)
        throw err
      }
    },
  })
}
