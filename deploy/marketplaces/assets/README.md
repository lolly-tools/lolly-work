# Listing screenshots

These PNG files are the screenshots for marketplace and catalogue listings. Each one
comes from the disposable neutral Compose fixture that the Helm qualification workflow
boots: the published Work server image and the checksum-pinned neutral shell named in
[`release.json`](../release.json), built-in password sign-in, the fixture owner
`owner@example.test` and no other accounts or data. Captures of a production instance,
member data, private brand packs and SUSE content never belong here.

| File | Shows |
|---|---|
| `sign-in.png` | Built-in email and password sign-in, before anyone signs in |
| `tool-gallery.png` | The matched Lolly web app's tool gallery with the neutral catalogue |
| `tool-editor.png` | The neutral Chart tool open for editing |
| `console-overview.png` | The Work console overview for the fixture owner |
| `console-tool-policy.png` | Tool policy in the Work console |

Each file is 1280 x 720, the size Azure Marketplace listings take, and light themed.
[`screenshots.json`](screenshots.json) records the Work source that ran the fixture,
the CI run, the release version, server image digest, shell checksum, browser and the
SHA-256 of every captured file. `tests/marketplace-screenshots.test.ts` checks the
files against that record, and the record against `release.json`: a release change
fails the test until the captures are refreshed.

## Shell views and the catalogue key

The 1.1.1 listing withheld the gallery and editor views. In a browser the neutral
1.1.1 shell refused the installation's catalogue with "Catalog refused: signature does
not verify against the pinned key", because Work signs each caller's tool index with
the installation's own key while the checksum-pinned public shell has the publisher's
key built in.

The 1.1.3 web app also accepts the key that the Work instance serving it publishes at
`/api/v1/catalog/public-key`, on the same origin only, so a signed-in browser lists the
tools. Helm qualification run
[40946250552](https://github.com/lolly-tools/lolly-work/actions/runs/40946250552)
captured all five views for 1.1.3.

A shell view is still never captured while the shell shows a refusal: the capture
records it as withheld, with the shell's own refusal message as the reason, and the run
uploads what the browser showed under `diagnostics/`. A refusal for any other reason
fails the capture run. The gallery capture waits for the first tool card.

## Refresh the captures

1. Dispatch **Helm qualification** on the reviewed source with **screenshots** on:
   `gh workflow run helm-qualification.yml --ref BRANCH -f screenshots=true`.
2. Download the `neutral-listing-screenshots-SHA` artifact from that run.
3. Look at every image and at any view the manifest records as withheld. Reject a
   capture that shows an error card, a loading state, a notice covering the view or
   anything other than fixture data.
4. Replace the PNG files and `screenshots.json` here with the artifact's files,
   unchanged. A failed run also uploads `diagnostics/`, showing each view that
   never became ready; those files explain the failure and never belong here.
5. Run `node --test tests/marketplace-screenshots.test.ts`.

Recapture when a release cohort update changes these views. A listing that names a
version should show captures from that version.
