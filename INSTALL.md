# Installing the Lolly control plane

**The install guide is [`docs/install.md`](docs/install.md).** It is the single canonical
copy, and it is the one a running deploy serves at `/admin#/docs`, so whoever operates an
instance reads the same page you do. This file is a pointer so the two cannot drift.

You need **Node 24+** and nothing else to look at it. The server is zero-build: it runs
TypeScript directly, no compile step, no external assets.

```bash
git clone https://github.com/lolly-tools/lolly-work.git
cd lolly-work
npm install
npm run demo            # http://localhost:8787, passwordless sign-in links print at boot
```

That is a fully seeded governed deployment in memory. For a real one - configuration,
first sign-in, the first owner, Postgres, secrets, and every deployable shape - go to
**[`docs/install.md`](docs/install.md)**.

Just looking? The hosted sandbox at <https://lolly.work> needs no install at all.
