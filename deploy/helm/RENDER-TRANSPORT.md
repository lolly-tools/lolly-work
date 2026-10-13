# Render worker transport

Enable the worker only after provisioning its TLS certificate and an approved
trust bundle. Set `renderWorker.tls.existingSecret` to a Secret with `tls.crt`
and `tls.key`, and `renderWorker.tls.caSecret` to a Secret with `ca.crt`. The
chart mounts the key only in the worker. The control plane receives the public
trust bundle through `NODE_EXTRA_CA_CERTS` at process startup.

The certificate must cover the Service DNS name. For release `lolly` in
namespace `creative`, configure `config.render.worker.url` as
`https://lolly-lolly-work-render-worker.creative.svc:8791`. The default healthcheck
server name follows that same convention. Set `renderWorker.tls.serverName`
when using an approved alias. Both the control plane and the image healthcheck
verify the certificate chain and hostname. Request authentication still uses
the separate shared HMAC credential.

An existing cert-manager installation or the deployment's certificate service
can provision these Secrets. This chart does not create an issuer or generate
keys. Restrict Secret access to the deployment operators. Restart worker and
control-plane pods after certificate or trust-bundle rotation; the files and
trust are loaded at process startup. Kubernetes HTTPS probes check worker
availability but do not validate the server certificate, so they do not replace
the verified image healthcheck or control-plane connection.

Standalone production startup requires `LW_RENDER_TLS_CERT_FILE` and
`LW_RENDER_TLS_KEY_FILE`. Configure `LW_RENDER_TLS_SERVER_NAME` and, for a private
CA, `LW_RENDER_TLS_CA_FILE` for the image healthcheck. The listener requires TLS
1.2 or newer. An explicitly selected `LW_RENDER_DEPLOYMENT_MODE=evaluation`
permits HTTP only on the loopback interface. Cluster deployments always select
production mode.

Keep the Chromium sandbox enabled, with non-root execution, all capabilities
dropped, no privilege escalation, and the configured seccomp profile. Qualify
browser startup, rendering and recovery on the target kernel and container
runtime before rollout. A failed sandbox launch stops the worker.
