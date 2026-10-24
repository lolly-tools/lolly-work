# Contributing to lolly-work

lolly-work is the Lolly control plane. [`README.md`](README.md) covers running it
locally, and [`CLAUDE.md`](CLAUDE.md) covers branches and worktrees for agents and
people alike: one branch per pull request, each in its own worktree under
`.worktrees/<name>`.

## Push checks

Enable the local push checks once per clone:

```sh
git config core.hooksPath scripts/git-hooks
```

The setting is shared by every worktree of the clone, and the path resolves inside
each one, so a worktree on an older branch without the hook simply runs none.

The hook needs the Node version in `.nvmrc` or later (`nvm use`). It invokes Node
directly; `LOLLY_NODE` can name that executable when a Git client has a different
PATH. The hook does not invoke a package manager or install dependencies.

The hook refuses new commits that add or change a file under `plans/`. That
folder is gitignored and private to the maintainer's machine, this repository is
public, and `git add -f` is the only way a file there gets committed. Commits a
remote-tracking ref already reaches are not checked again, side branches are
followed through their merges, and deleting or untracking a `plans/` file passes.
Check a branch before pushing with:

```sh
node scripts/check-pushed-plans.ts HEAD
```

If it reports a file, take it out of the listed commits with
`git rm --cached <path>`, then amend or rebase. The file stays on disk.
`tests/no-tracked-plans.test.ts` fails CI while any `plans/` file is tracked, so
a push that skipped the hook still cannot merge.

## Provider live-verify runbooks

A provider driver whose field names come from the vendor's public documentation
has a live-verify runbook beside it, in
[`server/src/catalog/providers/live-verify/`](server/src/catalog/providers/live-verify/).
Follow the runbook for that kind when you change the driver or confirm it against
a real tenant. The driver's header comment and its live-verify errors name the
file, and `tests/provider-config-contract.test.ts` checks that every driver with a
shape report has one. Operators run the same pass from
[Check a source on your own tenant](docs/providers/tenant-check.md). Edit the
runbooks here; the guides under `docs/` are generated from the Lolly repository
(see [`docs/README.md`](docs/README.md)).

## Database migrations

Migrations are the `migrations/*.sql` files, applied in file-name order, each in
its own transaction (`server/src/store/migrate.ts`). There are no down
migrations. Every file is classified by an allowlist
(`server/src/store/migration-classifier.ts`):

- **additive**: every statement is a `CREATE TABLE` of a new name, an
  `ADD COLUMN` that is nullable or has a constant default, a non-unique
  `CREATE INDEX` on a table created in the same file, or a `COMMENT`. A foreign
  key from a new table to an existing table must say `ON DELETE CASCADE` (or
  `ON DELETE SET NULL` on a nullable column).
- **maintenance**: everything else, including constraints, unique indexes,
  triggers, functions, `CREATE OR REPLACE`, `GRANT` and `REVOKE`, data changes
  and anything the parser does not recognise.

The previous release keeps working on a schema that only additive files
changed, so a deployment can apply them without a person and still roll the
application back. A maintenance file needs a review of its own, a fresh backup
and a restore rehearsal before it reaches a live database. Prefer additive
files: for example, add a nullable column in one release and its constraint in
a later one.

`node scripts/classify-migrations.ts` prints each file's class and why. When you
add a migration, add its name and class to `tests/migration-classes.json`; the
test fails until you do, so a change of class is always visible in review.

`LW_MIGRATE_EXPECT` binds a migration run to a reviewed pending set. Set it to
`none`, a comma-separated list of file names, or the `sha256:` manifest that
`node scripts/migrate.ts --check --json` and `classify-migrations.ts --json --only`
print, and the runner refuses before any DDL unless the pending set matches.
Unset, the runner behaves as before.

Deploys must use the `sha256:` manifest form. A list of names only checks which
files are pending, so it does not bind the run to the reviewed file contents.
An empty value refuses every boot, so never set `LW_MIGRATE_EXPECT` to `""` on
a long-lived Pod; unset it, or use `none`.

## Before you open a pull request

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run check:docs-vernacular
pnpm run check:code-comments
```

Run `pnpm console:check` as well when the admin console changes, and commit the
rebuilt `console/index.html` from `pnpm console:build`. Set `LW_TEST_DATABASE_URL`
to a disposable Postgres database to include the Postgres store conformance tests.

## Pull request checks

Every pull request runs one workflow, PR qualification
(`.github/workflows/pr-qualification.yml`), and its `required` job is the check
that must pass. It always runs CI and Source checks. Deployment qualification,
Helm qualification and CI's render-worker image leg run when the pull request
changes their inputs, as listed in `scripts/ci-change-scope.ts`. The copy of that
list on the base branch decides, so a change to it takes effect after it merges.
A change under `.github/` or to the root dependency manifests runs everything.

Pushes to `main`, `v*` tags, a nightly schedule and manual runs start each
workflow directly and always run it in full.
