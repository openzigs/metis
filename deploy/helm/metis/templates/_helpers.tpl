{{/*
=============================================================================
METIS chart helpers — names, labels, image refs, secret refs.
=============================================================================
*/}}

{{/* Expand the name of the chart. */}}
{{- define "metis.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec).
*/}}
{{- define "metis.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "metis.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Component-scoped name: <fullname>-<component> */}}
{{- define "metis.componentName" -}}
{{- printf "%s-%s" (include "metis.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard Bitnami-style labels. Pass dict with .root and .component */}}
{{- define "metis.labels" -}}
helm.sh/chart: {{ include "metis.chart" .root }}
app.kubernetes.io/name: {{ include "metis.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: metis
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "metis.selectorLabels" -}}
app.kubernetes.io/name: {{ include "metis.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Resolve image reference: <registry>/<repo>/<componentImageRepo>:<tag> */}}
{{- define "metis.image" -}}
{{- $reg := .root.Values.image.registry -}}
{{- $base := .root.Values.image.repository -}}
{{- $repo := .component.image.repository -}}
{{- $tag := default (default .root.Chart.AppVersion .root.Values.image.tag) .component.image.tag -}}
{{- printf "%s/%s/%s:%s" $reg $base $repo $tag -}}
{{- end -}}

{{/* ServiceAccount name. */}}
{{- define "metis.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-server" (include "metis.fullname" .)) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding sensitive env. */}}
{{- define "metis.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "metis.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Scaling-readiness guard (epic #518 / issue #540).

Multi-replica (server.replicaCount > 1) is now SUPPORTED, but only when every
formerly per-pod stateful dependency is pointed at a shared backend. This helper
replaces the old single-writer `replicaCount > 1` hard-block: it no longer
forbids N>1, it instead validates that the shared backends are configured.

For N>1 it requires:
  - a Postgres DATABASE_URL  (scaling.database.url postgres://… OR the DATABASE_URL
    secret key present via secrets/externalSecrets), AND
  - scaling.vectorStore=pgvector            (LanceDB is not N>1 safe), AND
  - uploads.backend=s3                        (RWO PVC is single-node).
It strongly recommends (and the rendered NOTES warns on):
  - scaling.rateLimitBackend=postgres, scaling.ssoStateBackend=postgres,
    scaling.leaderElection=postgres.

`scaling.enforce` (default true) makes the hard requirements fail-closed at
`helm template/install`. Set scaling.enforce=false to bypass (e.g. you supply
DATABASE_URL out-of-band and accept ownership). See docs/EKS_DEPLOYMENT.md §9.
*/}}
{{- define "metis.assertScalingBackends" -}}
{{- if gt (int .Values.server.replicaCount) 1 -}}
{{- $enforce := .Values.scaling.enforce -}}
{{- if $enforce -}}
{{- $hasPgUrl := false -}}
{{- if .Values.scaling.database.url -}}
{{- if or (hasPrefix "postgres://" .Values.scaling.database.url) (hasPrefix "postgresql://" .Values.scaling.database.url) -}}
{{- $hasPgUrl = true -}}
{{- end -}}
{{- end -}}
{{- /* DATABASE_URL may instead be supplied via the Secret (keyMap/externalSecrets). */ -}}
{{- $secretDbUrl := or .Values.externalSecrets.enabled .Values.secrets.existingSecret (hasKey .Values.secrets.keyMap "DATABASE_URL") -}}
{{- if not (or $hasPgUrl $secretDbUrl) -}}
{{- fail "metis: server.replicaCount > 1 requires a Postgres DATABASE_URL (#539). Set scaling.database.url=postgres://… or supply DATABASE_URL via secrets/externalSecrets, then set scaling.vectorStore=pgvector and uploads.backend=s3. See docs/EKS_DEPLOYMENT.md §9. Set scaling.enforce=false to override." -}}
{{- end -}}
{{- if ne .Values.scaling.vectorStore "pgvector" -}}
{{- fail "metis: server.replicaCount > 1 requires scaling.vectorStore=pgvector (#543) — embedded LanceDB is not multi-replica safe. See docs/EKS_DEPLOYMENT.md §9d. Set scaling.enforce=false to override." -}}
{{- end -}}
{{- if ne .Values.uploads.backend "s3" -}}
{{- fail "metis: server.replicaCount > 1 requires uploads.backend=s3 (#546) — an RWO PVC is single-node so replicas can't share uploads. See docs/EKS_DEPLOYMENT.md §9f. Set scaling.enforce=false to override." -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Server-only scaling env. Emits an env entry for each non-empty scaling/uploads
value, mapping the chart key to its verified server env var name. Empty values
are skipped so the server keeps its own fail-safe default.
NOTE: DATABASE_URL itself is NOT emitted here — it is delivered via the Secret
(metis.secretEnv, keyMap.DATABASE_URL) to avoid duplicate env keys and to keep
the connection string out of plain pod spec. scaling.database.url is only used
for the render-time scaling guard / NOTES, not injected as plain env.
*/}}
{{- define "metis.scalingEnv" -}}
{{- with .Values.scaling.rateLimitBackend }}
- name: DISCUSSION_RATE_LIMIT_BACKEND
  value: {{ . | quote }}
{{- end }}
{{- with .Values.scaling.ssoStateBackend }}
- name: SSO_STATE_BACKEND
  value: {{ . | quote }}
{{- end }}
{{- with .Values.scaling.vectorStore }}
- name: VECTOR_STORE
  value: {{ . | quote }}
{{- end }}
{{- with .Values.scaling.leaderElection }}
- name: SCHEDULER_LEADER_ELECTION
  value: {{ . | quote }}
{{- end }}
{{- with .Values.uploads.backend }}
- name: UPLOAD_STORAGE_BACKEND
  value: {{ . | quote }}
{{- end }}
{{- if eq .Values.uploads.backend "s3" }}
{{- with .Values.uploads.s3.bucket }}
- name: UPLOAD_S3_BUCKET
  value: {{ . | quote }}
{{- end }}
{{- with .Values.uploads.s3.region }}
- name: UPLOAD_S3_REGION
  value: {{ . | quote }}
{{- end }}
{{- with .Values.uploads.s3.prefix }}
- name: UPLOAD_S3_PREFIX
  value: {{ . | quote }}
{{- end }}
{{- with .Values.uploads.s3.endpoint }}
- name: UPLOAD_S3_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- if .Values.disasterRecovery }}
{{- with .Values.disasterRecovery.maxReplicationLagSeconds }}
- name: DR_MAX_REPLICATION_LAG_SECONDS
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Common pod-level securityContext. */}}
{{- define "metis.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1001
runAsGroup: 1001
fsGroup: 1001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Common container-level securityContext. */}}
{{- define "metis.containerSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1001
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/*
Render an env: list from a map of plain values. Used for non-sensitive env.
Pass dict: { root: $, env: <map> }

EMPTY VALUES ARE SKIPPED (#786). This is what lets values.yaml SURFACE a knob —
`EMBED_MODEL`, `EMBED_DTYPE`, `EMBED_POOLING_MAP`, `HF_HUB_OFFLINE` — as a
documented, empty-by-default key without that key overriding the image's own
default with an empty string. It matters most for the embeddings sidecar, where
`Dockerfile.embeddings` bakes weights keyed on the build-time EMBED_MODEL/
EMBED_DTYPE and exports them as ENV: emitting `EMBED_MODEL: ""` into the pod spec
would blank the very value that says which baked weights to load. Leave the key
empty and the image default (i.e. the model that was actually baked) wins.

LIMITATION — THIS IS GLOBAL. `metis.renderEnv` is shared by EVERY component, so
the skip applies to all of them: NO component can deliberately emit an empty-string
env var any more. If you ever need `SOME_VAR: ""` to explicitly BLANK an image's
ENV default (the mirror image of the case above), this helper will silently drop
the key and the image default will win instead — and the value will be sitting
right there in values.yaml, which makes it a genuinely confusing thing to debug.
Nothing in-tree relies on emitting an empty env today (verified against all three
rendered profiles). If something ever must, do NOT relax the skip — add a sentinel
(e.g. `"__EMPTY__"` → `""`) so the two intentions stay distinguishable.
*/}}
{{- define "metis.renderEnv" -}}
{{- $root := .root -}}
{{- range $k, $v := .env }}
{{- $rendered := tpl (toString $v) $root }}
{{- if ne $rendered "" }}
- name: {{ $k }}
  value: {{ $rendered | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Sensitive env block — every key from secrets.keyMap becomes a secretKeyRef
into metis-secrets. The same template is shared by all deployments.
*/}}
{{- define "metis.secretEnv" -}}
{{- $secretName := include "metis.secretName" . -}}
{{- range $envName, $secretKey := .Values.secrets.keyMap }}
- name: {{ $envName }}
  valueFrom:
    secretKeyRef:
      name: {{ $secretName }}
      key: {{ $secretKey }}
      optional: true
{{- end }}
{{- end -}}
