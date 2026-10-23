# Lolly Work packaged documentation

The complete documentation lives at <https://lolly.tools/info>. These generated guides are bundled for the console at `/admin#/docs` and offline installations. Existing console slugs and relative guide links remain available.

Edit the [canonical source](https://github.com/lolly-tools/lolly/tree/main/docs/work), then follow the [bundle update instructions](https://github.com/lolly-tools/lolly/blob/main/docs/work/README.md). Do not edit this generated copy. The repository's `docs-pin.json` records the selected canonical commit and all file hashes; run `pnpm run verify:docs-pin` to verify the bundle. Keep the selected documentation appropriate for the Work release.

## Start

- [What Lolly Work does today](status.md)

## Automate

- [Invite an agent](document-agents.md)
- [Automate with the Work API](automation-api.md)
- [Lolly Work API reference](api.md)
- [lw CLI: administer Lolly Work](cli.md)
- [Upload large files](resumable-uploads.md)

## Manage

- [Sign-in and sessions](identity.md)
- [Account data controls](account-lifecycle.md)
- [Invite people and handle requests](invitations.md)
- [Design-system administration](design-system-administration.md)
- [Roles and grants](permissions.md)
- [Policy and governance](governance.md)
- [Catalog and content](catalog.md)
- [Asset previews](file-preview.md)
- [Leave a DAM](offboarding.md)
- [Approvals](approvals.md)
- [Share renders and links](sharing.md)
- [Team projects](team-projects.md)
- [Render jobs and batches](renders.md)
- [Organisation delivery destinations](delivery.md)
- [Manage organisation AI policy](ai-policy.md)
- [Connect an asset source](providers/README.md)
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
- [Check a source on your own tenant](providers/tenant-check.md)
- [Preview a project transfer](project-portability.md)

## Deploy

- [Run Lolly Work](self-host.md)
- [Release 1.1.2](release-1-1-2.md)
- [Past releases](past-releases.md)
- [Lolly Work architecture](overview.md)
- [Install Lolly Work](install.md)
- [Install the ready-made package](ready-made-package.md)
- [Install on Kubernetes](platform-deployment.md)
- [Official installation routes](official-installations.md)
- [Set up enterprise identity](enterprise-identity.md)
- [Sign-in provider recipes](identity-providers.md)
- [Configure your first Work instance](customer-setup.md)
- [How a Work deployment fits together](deployment.md)
- [Run Work on UpCloud or Evroc](cloud-deployment.md)
- [WebAssembly and Kubewarden choices](wasm-deployment.md)
- [Work instance configuration](configuration.md)
- [Configure Work export signing](c2pa.md)
- [Keep Lolly Work running](operations.md)
- [Build a verified instance pack](instance-pack-production.md)
- [Check a deployment before production](production-readiness.md)
- [Shell deployment workflow](shell-deployment-workflow.md)
- [Telemetry and dashboards](telemetry.md)
- [Audit log](audit.md)

## Trust

- [Lolly Work security overview](security-platform.md)
- [Work storage and data lifecycle](data-lifecycle.md)

Work prose and screenshot credentials retain MPL-2.0 and any third-party notices. See [LICENSE](LICENSE).
