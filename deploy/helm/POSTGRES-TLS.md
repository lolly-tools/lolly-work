# PostgreSQL certificate verification

Use the same trusted CA for the application and the single migration Job. Keep
the connection URL in the existing instance Secret, with `sslmode=verify-full`
and `sslrootcert=/etc/lolly/postgres/ca.crt`. Its hostname must appear in the
database server certificate. Do not disable certificate verification.

Create a namespace ConfigMap named `lolly-postgres-ca` containing the public
`ca.crt`, then merge this overlay with the instance values:

```yaml
extraVolumes:
  - name: postgres-ca
    configMap:
      name: lolly-postgres-ca
extraVolumeMounts:
  - name: postgres-ca
    mountPath: /etc/lolly/postgres
    readOnly: true
migrate:
  extraVolumes:
    - name: postgres-ca
      configMap:
        name: lolly-postgres-ca
  extraVolumeMounts:
    - name: postgres-ca
      mountPath: /etc/lolly/postgres
      readOnly: true
```

The Job-only mount settings preserve the default migration command and scratch
volume. They do not inherit private shell or pack mounts. The render worker
receives neither the database URL nor the CA volume. Test the rendered objects
and actual database TLS connection before promoting the instance.

The pre-install migration Job uses an already-existing service account. By
default it uses the namespace's `default` account while Helm later creates the
application account. With `serviceAccount.create=false` it reuses the supplied
account. Set `migrate.serviceAccountName` for a separate existing account with
the required workload-identity annotations or bindings. Create that account
before installation. No extra hook-owned account is created or left behind;
the Job keeps token mounting disabled under the chart's default settings.
