import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Branchspace, BranchView, FinishResult, StartResult } from './branchspace.js'
import type { ToolRuntimeLike } from './dsh-types.js'

const text = (s: string) => [{ type: 'text', text: s }]

const START_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      workspaceId: { type: 'string' },
      worktreePath: { type: 'string' },
      branch: { type: 'string' },
    },
    required: ['sessionId', 'workspaceId', 'worktreePath', 'branch'],
  },
  render: (_args: unknown, v: StartResult) =>
    text(`⎇ ${v.branch} ready\nworktree: ${v.worktreePath}\nworkspace: ${v.workspaceId}\nsession: ${v.sessionId}`),
}

const LIST_OUTPUT = {
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        branch: { type: 'string' },
        worktreePath: { type: 'string' },
        workspaceId: { type: 'string' },
        sessionCount: { type: 'number' },
        dirty: { type: 'boolean' },
        createdAt: { type: 'string' },
      },
      required: ['branch', 'worktreePath', 'sessionCount', 'dirty', 'createdAt'],
    },
  },
  render: (_args: unknown, rows: BranchView[]) =>
    text(
      rows.length === 0
        ? 'No branchspace branches for this repository.'
        : rows
            .map((r) => `${r.dirty ? '●' : '○'} ⎇ ${r.branch} — ${r.sessionCount} session(s) — ${r.worktreePath}`)
            .join('\n'),
    ),
}

const FINISH_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      worktreePath: { type: 'string' },
      removedWorkspaceId: { type: 'string' },
      orphanedSessionIds: { type: 'array', items: { type: 'string' } },
      deletedBranch: { type: 'boolean' },
    },
    required: ['branch', 'worktreePath', 'orphanedSessionIds', 'deletedBranch'],
  },
  render: (_args: unknown, v: FinishResult) =>
    text(
      [
        `⎇ ${v.branch} finished; worktree removed: ${v.worktreePath}`,
        v.deletedBranch ? 'branch deleted' : 'branch kept',
        ...(v.orphanedSessionIds.length > 0 ? [`orphaned sessions: ${v.orphanedSessionIds.join(', ')}`] : []),
      ].join('\n'),
    ),
}

/** Register the three agent-callable branchspace tools. */
export function registerTools(tools: ToolRuntimeLike, branchspace: Branchspace): () => void {
  const disposers = [
    tools.register(
      defineTool({
        name: 'branchspace_start',
        description:
          'Start an isolated coding session for a git branch: creates (or reuses) a git worktree under ' +
          '<repo>/.branchspace/<branch>, registers a dsh workspace for it, and opens a new session whose cwd is ' +
          'the worktree — file writes stay inside the worktree and never touch the main checkout. ' +
          'Idempotent per (repo, branch).',
        parameters: {
          repoPath: { type: 'string', required: true, description: 'Path to the main git repository (any spelling; canonicalized internally).' },
          branch: { type: 'string', required: true, description: 'Branch name (created from baseBranch when missing; reused when it exists).' },
          baseBranch: { type: 'string', description: 'Base branch for a new branch. Defaults to the repo default branch.' },
        },
        output: START_OUTPUT,
        execute: (args: { repoPath: string; branch: string; baseBranch?: string }) => branchspace.start(args),
      }),
    ),
    tools.register(
      defineTool({
        name: 'branchspace_list',
        description:
          'List all branchspace branches of a repository: branch name, canonical worktree path, workspace id, ' +
          'mounted session count, and whether the worktree has uncommitted changes.',
        parameters: {
          repoPath: { type: 'string', required: true, description: 'Path to the main git repository.' },
        },
        output: LIST_OUTPUT,
        execute: (args: { repoPath: string }) => branchspace.list(args),
      }),
    ),
    tools.register(
      defineTool({
        name: 'branchspace_finish',
        description:
          'Finish a branchspace branch: removes its git worktree and workspace record (session logs are kept). ' +
          'Refused while the worktree is dirty or live sessions are attached unless force is set; ' +
          'a forced finish reports orphanedSessionIds whose cwd is gone. Session logs are never deleted.',
        parameters: {
          repoPath: { type: 'string', required: true, description: 'Path to the main git repository.' },
          branch: { type: 'string', required: true, description: 'Branch to finish.' },
          force: { type: 'boolean', description: 'Skip the dirty-worktree and live-session checks.' },
          deleteBranch: { type: 'boolean', description: 'Also delete the git branch after removing the worktree.' },
        },
        output: FINISH_OUTPUT,
        execute: (args: { repoPath: string; branch: string; force?: boolean; deleteBranch?: boolean }) =>
          branchspace.finish(args),
      }),
    ),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
