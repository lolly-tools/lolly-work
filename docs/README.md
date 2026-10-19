# Lolly Work packaged documentation

The complete documentation lives at <https://lolly.tools/info>. These generated guides are bundled for the console at `/admin#/docs` and offline installations. Existing console slugs and relative guide links remain available.

Edit the [canonical source](https://github.com/lolly-tools/lolly/tree/main/docs/work), then follow the [bundle update instructions](https://github.com/lolly-tools/lolly/blob/main/docs/work/README.md). Do not edit this generated copy. The repository's `docs-pin.json` records the selected canonical commit and all file hashes; run `pnpm run verify:docs-pin` to verify the bundle. Keep the selected documentation appropriate for the Work release.

## Start

- [Work status and roadmap](status.md)

## Automate

- [Invite an agent to a document](document-agents.md)
- [Lolly Work API](api.md)
- [lw CLI: administer an instance](cli.md)

## Manage

- [Identity and sessions](identity.md)
- [Account data controls](account-lifecycle.md)
- [Design-system administration](design-system-administration.md)
- [Roles and grants](permissions.md)
- [Policy and governance](governance.md)
- [Catalog and content](catalog.md)
- [Asset previews](file-preview.md)
- [Off-boarding a DAM](offboarding.md)
- [Approvals](approvals.md)
- [Rendering and sharing](sharing.md)
- [Recover and inspect render jobs](renders.md)
- [Organisation delivery destinations](delivery.md)
- [Manage organisation AI policy](ai-policy.md)
- [Provider guides](providers/README.md)
- [WebDAV / Nextcloud](providers/webdav.md)
- [S3 / S3-compatible](providers/s3.md)
- [Git raw manifest](providers/git.md)
- [Brandfolder](providers/brandfolder.md)
- [Optimizely CMP](providers/optimizely-cmp.md)
- [Image Relay](providers/imagerelay.md)
- [Canto](providers/canto.md)
- [Acquia DAM / Widen](providers/acquia-dam.md)
- [IntelligenceBank](providers/intelligencebank.md)
- [Cloudinary](providers/cloudinary.md)
- [Orange Logic](providers/orange-logic.md)
- [Penpot](providers/penpot.md)
- [Dropbox](providers/dropbox.md)
- [Google Drive](providers/gdrive.md)
- [Microsoft 365 / SharePoint](providers/o365.md)
- [Preview a project transfer](project-portability.md)

## Deploy

- [Run your own server](self-host.md)
- [Release 1.1.1](release-1-1-1.md)
- [Release 1.1.0 (historical record)](release-1-1-0.md)
- [Lolly Work architecture](overview.md)
- [Install Lolly Work](install.md)
- [Official installation routes](official-installations.md)
- [Set up enterprise identity](enterprise-identity.md)
- [Configure your first Work instance](customer-setup.md)
- [Lolly Work deployment options](deployment.md)
- [UpCloud, Evroc and fewer hosting services](cloud-deployment.md)
- [Deploy with your platform team](platform-deployment.md)
- [WebAssembly and Kubewarden choices](wasm-deployment.md)
- [Work instance configuration](configuration.md)
- [Configure Work export signing](c2pa.md)
- [Cloudinary tenant verification](providers/cloudinary-live-verify.md)
- [Orange Logic tenant verification](providers/orange-logic-live-verify.md)
- [WebDAV live-verify runbook](providers/webdav-live-verify.md)
- [Canto live-verify runbook](providers/canto-live-verify.md)
- [Image Relay live-verify runbook](providers/imagerelay-live-verify.md)
- [IntelligenceBank live-verify runbook](providers/intelligencebank-live-verify.md)
- [Acquia DAM live-verify runbook](providers/acquia-dam-live-verify.md)
- [Operations runbook](operations.md)
- [Fast frontend updates](frontend-updates.md)
- [Public model verification reuse](public-model-proof-reuse.md)
- [Build a verified instance pack](instance-pack-production.md)
- [Production evidence](production-readiness.md)
- [Application release classification](application-release-classification.md)
- [Shell deployment workflow](shell-deployment-workflow.md)
- [Telemetry and dashboards](telemetry.md)
- [Audit log](audit.md)

## Trust

- [Where work happens and what crosses the network](security-platform.md)
- [Work storage and data lifecycle](data-lifecycle.md)

Work prose and screenshot credentials retain MPL-2.0 and any third-party notices. See [LICENSE](LICENSE).
