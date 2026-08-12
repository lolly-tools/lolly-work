{{/*
Expand the name of the chart.
*/}}
{{- define "lolly-work.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name (release-scoped, DNS-safe, <=63 chars).
*/}}
{{- define "lolly-work.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "lolly-work.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "lolly-work.labels" -}}
helm.sh/chart: {{ include "lolly-work.chart" . }}
{{ include "lolly-work.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (stable — never include version/checksum here).
*/}}
{{- define "lolly-work.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lolly-work.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name to use.
*/}}
{{- define "lolly-work.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "lolly-work.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Container image reference (repository:tag, tag defaults to appVersion).
*/}}
{{- define "lolly-work.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}

{{/*
Name of the chart-managed Secret (only rendered when existingSecret is empty).
*/}}
{{- define "lolly-work.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "lolly-work.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Whether the chart manages its own Secret (Mode A) vs. an existing one (Mode B).
*/}}
{{- define "lolly-work.manageSecret" -}}
{{- if .Values.existingSecret }}false{{ else }}true{{ end }}
{{- end }}

{{/*
Secret name + key that hold DATABASE_URL. A dedicated database.existingSecret
wins; otherwise DATABASE_URL lives in the shared secret (chart-managed or the
top-level existingSecret) under key DATABASE_URL.
*/}}
{{- define "lolly-work.databaseSecretName" -}}
{{- if .Values.database.existingSecret }}
{{- .Values.database.existingSecret }}
{{- else }}
{{- include "lolly-work.secretName" . }}
{{- end }}
{{- end }}

{{- define "lolly-work.databaseSecretKey" -}}
{{- if .Values.database.existingSecret }}
{{- .Values.database.existingSecretKey }}
{{- else }}
{{- "DATABASE_URL" }}
{{- end }}
{{- end }}

{{/*
SHARED secret-backed environment — the single source of truth for DATABASE_URL
and the LW_* secrets. Included verbatim by BOTH the Deployment and the migrate
Job so their credential wiring can never drift. Optional LW_* vars use
optional:true so they are silently skipped when the key is absent from the
secret (Mode A didn't set them, or Mode B's secret omits them).
*/}}
{{- define "lolly-work.secretEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.databaseSecretName" . }}
      key: {{ include "lolly-work.databaseSecretKey" . }}
      optional: true
- name: LW_SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_SESSION_SECRET
- name: LW_LINK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_LINK_SECRET
- name: LW_IDP_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_IDP_CLIENT_SECRET
      optional: true
- name: LW_CREDENTIAL_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_CREDENTIAL_SECRET
      optional: true
- name: LW_METRICS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_METRICS_TOKEN
      optional: true
- name: LW_RENDER_WORKER_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_RENDER_WORKER_SECRET
      optional: true
- name: LW_C2PA_SIGNING_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "lolly-work.secretName" . }}
      key: LW_C2PA_SIGNING_KEY
      optional: true
{{- end }}

{{/*
Guardrail: in Mode A (no existingSecret, no database.existingSecret) the two
required signing secrets must be provided, or the deploy is silently insecure.
*/}}
{{- define "lolly-work.validate" -}}
{{- if not .Values.existingSecret }}
{{- if not .Values.secrets.sessionSecret }}
{{- fail "secrets.sessionSecret is required (or set existingSecret). Generate once: openssl rand -hex 32 — every replica must share it. See values.yaml." }}
{{- end }}
{{- if not .Values.secrets.linkSecret }}
{{- fail "secrets.linkSecret is required (or set existingSecret). Generate once: openssl rand -hex 32. See values.yaml." }}
{{- end }}
{{- end }}
{{- end }}
