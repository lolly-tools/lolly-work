# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. The product starts at [`README.md`](README.md); installing and deploying start at [`docs/install.md`](docs/install.md).

## Branches and worktrees

Many Claude Code runs share this checkout. These rules keep their work from piling up or getting lost:

- One branch per PR, in its own worktree under `.worktrees/<name>` at the top of the main checkout: `git worktree add --no-track -b <branch> .worktrees/<name> origin/main`, then `git push -u origin <branch>` the first time you push. Never under `/tmp`, `/private/tmp` or `$TMPDIR` (macOS empties them), never inside `plans/` and never inside another worktree.
- Commit the work to its branch and push it before you finish, unless the user said otherwise. Uncommitted files in the shared main checkout are not a safe place to keep work.
- The main checkout stays on `main`. If you find it on another branch or holding uncommitted files, report that; never switch, stash, reset or restore it, because the files may be someone's live work.
- After a PR merges, review its remaining branches and worktree for cleanup. Merged changes alone do not prove that unique commit history, ignored files or external references can be discarded. Keep worktrees used by deployment helpers, recovery evidence or other configuration locked with `git worktree lock <path>` until those references have moved. Keep local branches for a separate review of their exact SHA and checkout occupancy.
- No `backup/*`, `scratch/*`, `deploy/*` or `integrate/*` branches on the remote. Never merge a snapshot, backup or integration branch into main wholesale; each change reaches main through its own reviewed PR. Keep superseded work as an `archive/*` tag, not a branch.
- Before ending a long run, run the hygiene report from a `lolly` checkout: `node scripts/branch-hygiene.ts <path-to-lolly-work>`, or `pnpm run branch:hygiene . <path-to-lolly-work>` for both repositories. The default is a report; its fetch preserves stale remote-tracking refs. IN_MAIN includes equivalent squash or rebase merges whose unique commit history must still be retained. Use `--prune` only for authorized cleanup with the maintained guarded tool: it requires exact ancestry in pinned live main, fresh refs, PR and protection checks for remote branches, and fresh process, registration, lock, index and file checks for worktrees. All uncommitted and ignored files, including build directories, `node_modules` and notes, retain their worktree. The tool never forces removal, transfers notes, deletes local branches or globally prunes missing worktree registrations; each attempted action logs its SHA under `plans/worktree-notes/` first. Coordinate with other users because PR/protection and process checks are separate from the final deletion. If the tool is absent or older than these guards, report the gap and retain the files and refs.

## Existing production instances

For work on `lolly.ing` or `lolly.tools` from the shared Build workspace, follow its `AGENTS.md` and read `lolly-private/production/README.md` before choosing a target. Both domains use the UpCloud K3s production host; retained host and kubecontext names containing `candidate` are historical and do not make the host disposable. Run `python3 lolly-private/production/check-target.py` from Build immediately before every production mutation and stop if the check fails. Also inspect the exact resources and proposed changes; coordinate ownership and serialize changes to shared resources.

Do not replay historical Compose, Vercel or Neon migration commands for those two domains, restart stopped application services on the retained old host, change their stopped-service restart policies, restore its database access or point production DNS back to old targets. Preserve dirty source trees, durable data, secrets and recovery custody. Never mount an active production asset PVC in a staging Pod; stream a read-only snapshot through its owning Pod into a new target PVC. A document-scoped MCP invitation grants document access only, not infrastructure authority.

The generic installation guides remain supported for other instances. Their operators should use their own current target handoff, identity checks, backups and release workflow; this machine-specific handoff is not a prerequisite for a fresh installation.
