# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. The product starts at [`README.md`](README.md); installing and deploying start at [`docs/install.md`](docs/install.md).

## Branches and worktrees

Many agent sessions share this checkout. These rules keep their work from piling up or getting lost:

- One branch per PR, in its own worktree under `<repo>/.worktrees/<name>`, made off `origin/main`. Never under `/private/tmp` (macOS empties it nightly) and never inside `plans/`.
- Commit the work to its branch and push before the session ends. Uncommitted files in the shared main checkout are not a safe place to keep work.
- The main checkout stays on `main`.
- After a PR merges, remove its worktree and local branch, and its remote branch if GitHub has not already deleted the branch on merge.
- No `backup/*`, `scratch/*`, `deploy/*` or `integrate/*` branches on the remote. Never merge a snapshot, backup or integration branch into main wholesale; each change reaches main through its own reviewed PR. Keep superseded work as an `archive/*` tag, not a branch.
- Before ending a long session, run the hygiene report from a `lolly` checkout next to this one: `node scripts/branch-hygiene.ts ../lolly-work`, or `pnpm run branch:hygiene . ../lolly-work` for both repositories. It reports each branch as IN_MAIN, OPEN_PR or UNIQUE and lists worktrees with their state; `--prune` removes only what main already holds and nobody is using, and logs every sha to `plans/worktree-notes/` first.
