{{/*
Expand the name of the chart.
*/}}
{{- define "polyptic.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec).
*/}}
{{- define "polyptic.fullname" -}}
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

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "polyptic.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "polyptic.labels" -}}
helm.sh/chart: {{ include "polyptic.chart" . }}
{{ include "polyptic.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: server
app.kubernetes.io/part-of: polyptic
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "polyptic.selectorLabels" -}}
app.kubernetes.io/name: {{ include "polyptic.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the service account to use.
*/}}
{{- define "polyptic.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "polyptic.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The image reference (repository:tag), tag defaulting to the chart appVersion.
*/}}
{{- define "polyptic.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}

{{/*
The name of the Secret holding COOKIE_SECRET / bootstrap / admin / DATABASE_URL.
Uses an existing secret if provided, otherwise the chart-managed one.
*/}}
{{- define "polyptic.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "polyptic.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
The name of the ConfigMap holding non-secret env.
*/}}
{{- define "polyptic.configMapName" -}}
{{- printf "%s-config" (include "polyptic.fullname" .) -}}
{{- end }}

{{/*
The hostname of the in-cluster Postgres subchart primary service.
Bitnami names it "<release>-postgresql".
*/}}
{{- define "polyptic.postgresql.host" -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- end }}

{{/*
The name of the PVC backing MEDIA_DIR (Phase 7 uploads). Uses an externally
supplied existingClaim when set, otherwise the chart-managed "<fullname>-media".
*/}}
{{- define "polyptic.media.pvcName" -}}
{{- if .Values.media.persistence.existingClaim -}}
{{- .Values.media.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-media" (include "polyptic.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
Resolve the COOKIE_SECRET value used at install time. Precedence:
  1. explicit .Values.secrets.cookieSecret
  2. the value already stored in the chart-managed Secret (preserve on upgrade)
  3. a freshly generated 64-char random string
Only consulted when NOT using an externally-supplied existingSecret.
*/}}
{{- define "polyptic.cookieSecret" -}}
{{- if .Values.secrets.cookieSecret -}}
{{- .Values.secrets.cookieSecret -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-secret" (include "polyptic.fullname" .)) -}}
{{- if and $existing (hasKey ($existing.data | default dict) "COOKIE_SECRET") -}}
{{- index $existing.data "COOKIE_SECRET" | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Resolve the DATABASE_URL.
  * postgresql.enabled → build from subchart credentials + in-cluster host.
  * else               → externalDatabase.url (may be "").
Returns empty string when STORE=memory or nothing is configured.
*/}}
{{- define "polyptic.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $u := .Values.postgresql.auth.username -}}
{{- $p := .Values.postgresql.auth.password -}}
{{- $d := .Values.postgresql.auth.database -}}
{{- $h := include "polyptic.postgresql.host" . -}}
{{- printf "postgres://%s:%s@%s:5432/%s" $u $p $h $d -}}
{{- else -}}
{{- .Values.externalDatabase.url -}}
{{- end -}}
{{- end }}
