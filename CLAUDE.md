# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. The product starts at [`README.md`](README.md); installing and deploying start at [`docs/install.md`](docs/install.md).

## Branches and worktrees

Many Claude Code runs share this checkout. These rules keep their work from piling up or getting lost:

- One branch per PR, in its own worktree under `.worktrees/<name>` at the top of the main checkout: `git worktree add --no-track -b <branch> .worktrees/<name> origin/main`, then `git push -u origin <branch>` the first time you push. Never under `/tmp`, `/private/tmp` or `$TMPDIR` (macOS empties them), never inside `plans/` and never inside another worktree.
- Commit the work to its branch and push it before you finish, unless the user said otherwise. Uncommitted files in the shared main checkout are not a safe place to keep work.
- The main checkout stays on `main`. If you find it on another branch or holding uncommitted files, report that; never switch, stash, reset or restore it, because the files may be someone's live work.
- After a PR merges, remove its worktree and local branch, and its remote branch if GitHub has not already deleted the branch on merge.
- No `backup/*`, `scratch/*`, `deploy/*` or `integrate/*` branches on the remote. Never merge a snapshot, backup or integration branch into main wholesale; each change reaches main through its own reviewed PR. Keep superseded work as an `archive/*` tag, not a branch.
- Before ending a long run, run the hygiene report from a `lolly` checkout: `node scripts/branch-hygiene.ts <path-to-lolly-work>`, or `pnpm run branch:hygiene . <path-to-lolly-work>` for both repositories. It reports each branch as IN_MAIN, OPEN_PR or UNIQUE and lists worktrees with their state. `--prune` deletes branches whose changes main already holds and that no open PR or worktree uses, and worktrees that are clean, merged or pushed, and idle (no process inside, index untouched for 30 minutes); it logs every sha to `plans/worktree-notes/` first.
