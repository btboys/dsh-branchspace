# dsh-branchspace

Git branch workspaces for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):
**one branch = one git worktree + one built-in dsh workspace + any number of isolated sessions.**

Every branch session runs with its cwd inside `<repo>/.branchspace/<branch>`, so dsh's
workspace-write file sandbox scopes all file writes to that worktree — the main checkout is
never touched.

```
Workspace (repo)                ← your git repository
└── ⎇ feature-a                 ← git worktree at <repo>/.branchspace/feature-a
│   └── session(s)              ← dsh sessions with cwd = the worktree
└── ⎇ feature-b
    └── session(s)
```

## Install

```bash
dsh plugin --profile web add dsh-branchspace
# or from a checkout:
dsh plugin --profile web add file:/path/to/dsh-branchspace
```

Restart the profile (`dsh web`) afterwards — plugins mount at boot.

## Usage

### Slash command (in any session inside a git repo)

```
/branchspace start <branch> [baseBranch] [repoPath]
/branchspace list [repoPath]
/branchspace finish <branch> [--force] [--delete-branch] [repoPath]
```

`repoPath` defaults to the current session's cwd. `baseBranch` defaults to the repo's
current default branch.

### Agent tools

The model can call three tools directly:

| Tool | Arguments | Effect |
|---|---|---|
| `branchspace_start` | `repoPath`, `branch`, `baseBranch?` | worktree + workspace + session; returns `{ sessionId, workspaceId, worktreePath, branch }` |
| `branchspace_list` | `repoPath` | rows of `{ branch, worktreePath, workspaceId, sessionCount, liveCount, dirty, createdAt }` |
| `branchspace_finish` | `repoPath`, `branch`, `force?`, `deleteBranch?` | removes worktree + workspace record; reports `orphanedSessionIds` when forced over live sessions |

### Web UI

A **⎇ Branches** button appears in the sidebar footer (`sidebar.footer.action` slot). The panel
groups every tracked repository's branches with session counts and dirty markers (● dirty /
○ clean), and offers **＋ New branch session** and **Finish** actions. Finish is disabled while
live sessions are attached to the branch's workspace.

<!-- UI screenshot placeholder -->
![branchspace panel](docs/screenshot.png)

## Guarantees and safety

- **Canonical paths everywhere**: `repoPath` and worktree paths are `fs.realpath`-canonicalized
  before any comparison, session cwd, workspace registration, registry persistence, or return
  value — symlinked prefixes (macOS `/tmp`, linked `$HOME`) cannot break dsh's
  `attachSession` cwd equality check.
- **Idempotent start**: repeating `start` for the same (repo, branch) reuses the existing
  worktree/workspace and returns the existing record (plus a fresh session).
- **In-process mutex**: `start`/`finish` are serialized per `(canonicalRepoPath, branch)`;
  concurrent same-branch starts collapse onto one worktree/workspace.
- **Safe rollback**: if `git worktree add` fails, only a worktree provably created by that call
  (absent from the pre-add `git worktree list` snapshot) is removed.
- **Live-session protection**: `finish` is refused while live sessions are attached
  (the error lists them); `--force` proceeds and reports them as `orphanedSessionIds`.
- **Dirty protection**: `finish` refuses a dirty worktree unless `--force`.
- **Crash recovery**: the registry (`~/.dsh/branchspace.json`) reconciles with
  `git worktree list` at startup and before every list/overview call; vanished worktrees drop out.
- **Branch validation**: names are checked against git ref rules (`..`, leading `-`, spaces,
  `~^:?*[\`, `.lock` suffixes, … are rejected before git is touched).
- All git invocations use `execFile` (no shell), with a 30s timeout.
- Worktrees live under `<repo>/.branchspace/`, which is appended to `.git/info/exclude`
  (so the main checkout never shows them as untracked).

## Limitations

- **Not a native three-tier model**: dsh workspaces are (uuid, immutable canonical path,
  ordered sessions). This plugin maps "branch" onto one worktree + one workspace record titled
  `repo ⎇ branch`; the Workspace → branch → session hierarchy is a presentation layer, not a
  new dsh entity. One branch has exactly one worktree/workspace.
- **The mutex is in-process**: two *separate dsh processes* racing on the same repo+branch are
  not serialized (git itself still prevents duplicate worktrees, but idempotency guarantees
  degrade to best-effort).
- **Live sessions are per-process**: after a dsh restart, previously created sessions are no
  longer live, so `finish` no longer blocks on them (registry records and session logs persist).
- The client panel is a sidebar-footer popover; the built-in workspace list shows branch
  workspaces as ordinary groups (titled `repo ⎇ branch`) — there is no finer-grained slot
  inside the session list to inject into.
- The RPC channel is loopback-only (`authority: 'loopback'`); the panel works in the local GUI.

## Development

```bash
npm install
npm test          # build + unit tests (temporary git repo fixtures, symlink and concurrency cases)
npm run build     # host (tsc) + client (esbuild → lib/client.js factory bundle)
npm run typecheck
```

Layout:

```
src/git.ts         git worktree operations (execFile, canonical paths, snapshot rollback)
src/registry.ts    ~/.dsh/branchspace.json persistence + git worktree reconciliation
src/branchspace.ts core service: start / list / finish / overview + keyed mutex
src/factory.ts     dsh binding: workspaceRegistry + agents + session store
src/commands.ts    /branchspace slash command
src/tools.ts       branchspace_start / _list / _finish agent tools
src/rpc.ts         /rpc/branchspace loopback channel for the client panel
src/client/        sidebar footer entry + branch panel (React)
```

## License

MIT
