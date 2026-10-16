# 81 - Cloudinary and Orange Logic shared sources

Date: 2026-10-15. Cross-repository plan: Lolly `plans/313-modern-dam-and-shared-provider-implementation.md`, based on report 312. Status: public API provider slice implemented and fixture-verified; tenant qualification remains pending.

## Scope and ownership

Work owns both read-only catalog drivers, registry kinds, existing advanced setup cards, sealed credentials, scope enforcement, file resolution, redacted diagnostics, tests and operator guides. Lolly owns the member Assets experience and later paging, curation, history and AI slices. No provider-specific engine dependency is required.

## Implementation sequence

1. Define validated options and explicit credential shapes. Pin every authenticated request to the configured provider API; sanitize transport errors and reject redirects.
2. Implement Cloudinary cursor listing and ordinary search, immutable asset IDs, original downloads and safe existing-file previews. Keep configured scope on list, search, detail and byte resolution. Refuse stale selected versions.
3. Implement Orange Logic client-credential/bearer auth, Search v4 paging, configurable tenant fields and permitted renditions. Force JSON and disable on-demand format generation. Re-read the selected record before resolution and reject substitute/watermarked formats rather than silently returning different bytes.
4. Register both sources across the existing config, CLI and advanced console surface. Document original support, approval/rights limits, service identity, storage origins, API limits, charges and exit requirements.
5. Test fixtures and federation, then run typecheck, provider/config/CLI regressions, source checks and console generation checks. Record exact outcomes below.

## Orange Logic original-file constraint

Only public documentation is available. [Search fields](https://developer.orangelogic.com/reference/fields-parameter) excludes protected originals and directs customers to a support-gated Extract Original Document API. [Presigned storage links](https://developer.orangelogic.com/reference/get-presigned-link) resolve requested formats but do not establish that a rendition is an original. Implement public rendition access honestly; protected-original implementation and migration acceptance await the actual API contract. No source connection authorises generating a missing rendition.

## Verification and release boundary

Cover authentication, scopes, complete/capped paging, renamed sources, changed versions, failed or malformed responses, URL/ID validation, redirects, unavailable originals and secret-free catalog records. Existing Work exposure and availability gates apply. Defaults never invent approval. No write-back, AI execution, delegated end-user OAuth, contextual rights evaluation or outbound Cloudinary destination is implied by these read-only sources.

Fixture coverage demonstrates implementation behaviour, not live supplier qualification. Follow each provider guide's tenant pass before enabling a production source. No credentials or tenant assets are required in repository tests.

## Execution record

Work baseline `e15b27d`; Lolly baseline `fe50e118e`. Work branch: `feat/cloudinary-orange-logic-providers-20261015`; Lolly branch: `feat/dam-provider-roadmap-20261015`.

Implemented both registry drivers, explicit original/rendition metadata, fresh source-policy checks before upstream file reads, advanced console cards, guides and redacted diagnostics. Orange Logic uses public Search paths for permitted renditions, with generation disabled. Protected originals remain unsupported; cutover returns `422 ORIGINALS_UNAVAILABLE` before mutation. Cloudinary requests original bytes by immutable asset ID with a short-lived signature and no transform.

Verification on 2026-10-15:

- Broad provider/config/CLI/federation/materialisation/docs regression run: 164 passed, one skipped because built documentation pages are absent.
- Final affected driver/materialisation/config/docs run: 46 passed, the same one built-page skip. Includes the HTTP cutover refusal and source metadata/input edge cases.
- Work typecheck passed after installing the render worker's pinned type dependency. Generated console check passed.
- Pinned Gitleaks 8.29.1 staged scan passed; Opengrep 1.26.0 passed with complete coverage of 323 source files. Comment/doc vernacular and diff checks passed.
- Lolly: eight file-selection/cache/UI tests passed, including single-rendition disclosure. Full typecheck passed for installed projects; optional Tauri package checks skipped because their dependencies are absent. Lint ratchet and UI-copy checks passed.

No real vendor tenant was used. API entitlements, actual source bytes, private/raw downloads, field mappings, source-change freshness and workload costs still require the documented tenant pass. Request spacing is per driver instance, not a global account rate limiter. The broader cross-repository DAM/AI roadmap remains staged in Lolly plan 313.
