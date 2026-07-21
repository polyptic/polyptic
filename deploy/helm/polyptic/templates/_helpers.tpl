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
app.kubernetes.io/part-of: polyptic
{{- end }}
{{/*
NOTE (POL-166): app.kubernetes.io/component is deliberately NOT part of these common labels.
Each template sets its own `app.kubernetes.io/component:` line next to the include — a component
here plus a per-resource override produced DUPLICATE keys in the rendered YAML, which plain helm
tolerates (last key wins) but kustomize/flux's strict parser rejects.
*/}}

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
The bundled Postgres (POL-123/D108) — a first-party StatefulSet + Service in THIS chart, not a
subchart. Name + host: "<fullname>-db", which for the conventional `helm install polyptic …` comes
out as "polyptic-db" — deliberately the same name the hand-rolled companion manifest used, so an
operator's existing DATABASE_URL and PVC still point at the right thing.
*/}}
{{- define "polyptic.postgresql.fullname" -}}
{{- printf "%s-db" (include "polyptic.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "polyptic.postgresql.host" -}}
{{- include "polyptic.postgresql.fullname" . -}}
{{- end }}

{{/*
Is the bundled database actually being deployed? Only when it is enabled AND the server is
actually going to use a database (STORE=postgres) — standing a Postgres up next to a
STORE=memory server would be a pod nobody talks to.
*/}}
{{- define "polyptic.postgresql.deployed" -}}
{{- if and .Values.postgresql.enabled (eq .Values.config.store "postgres") -}}true{{- end -}}
{{- end }}

{{/*
Where the bundled Postgres password lives: an operator-supplied Secret, else the chart's own.
*/}}
{{- define "polyptic.postgresql.secretName" -}}
{{- if .Values.postgresql.auth.existingSecret -}}
{{- .Values.postgresql.auth.existingSecret -}}
{{- else -}}
{{- include "polyptic.secretName" . -}}
{{- end -}}
{{- end }}
{{- define "polyptic.postgresql.passwordKey" -}}
{{- .Values.postgresql.auth.existingSecretPasswordKey | default "POSTGRES_PASSWORD" -}}
{{- end }}

{{/*
Resolve the bundled Postgres password, mirroring polyptic.cookieSecret exactly:
  1. explicit .Values.postgresql.auth.password
  2. the value already stored in the chart-managed Secret (so `helm upgrade` never rotates the
     password out from under a database that still holds the old one)
  3. a freshly generated 32-char random string
There is NO weak literal default: a chart that ships `password: polyptic` ships that password to
every install that forgets to override it.
*/}}
{{- define "polyptic.postgresqlPassword" -}}
{{- if .Values.postgresql.auth.password -}}
{{- .Values.postgresql.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-secret" (include "polyptic.fullname" .)) -}}
{{- if and $existing (hasKey ($existing.data | default dict) "POSTGRES_PASSWORD") -}}
{{- index $existing.data "POSTGRES_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The PVC backing the bundled Postgres data directory when an operator brings their own claim
(persistence.existingClaim) — the adoption path for the hand-rolled `polyptic-db` PVC. When empty
the StatefulSet uses a volumeClaimTemplate instead (claim "data-<sts>-0").
*/}}
{{- define "polyptic.postgresql.pvcName" -}}
{{- .Values.postgresql.persistence.existingClaim -}}
{{- end }}

{{/*
DATABASE_URL for the BUNDLED database, as a Kubernetes env-var template: the password is NOT
interpolated here — it is injected as POSTGRES_PASSWORD from the Secret and expanded by the
kubelet via $(VAR) substitution, so the plaintext password never lands in the connection string
this chart renders (and an operator-supplied existingSecret works without the chart ever reading
it). Generated passwords are alphanumeric, so no URL-escaping is needed.
*/}}
{{- define "polyptic.postgresql.envUrl" -}}
{{- $u := .Values.postgresql.auth.username -}}
{{- $d := .Values.postgresql.auth.database -}}
{{- $h := include "polyptic.postgresql.host" . -}}
{{- $p := int .Values.postgresql.service.port -}}
{{- printf "postgres://%s:$(POSTGRES_PASSWORD)@%s:%d/%s" $u $h $p $d -}}
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
The EXTERNAL DATABASE_URL, if any — the connection string an operator points at their own
Postgres. The bundled database does NOT come through here (see polyptic.postgresql.envUrl: its
password is expanded in the pod, not baked into a string in a Secret).
Empty when the bundled DB is in use, when STORE=memory, or when nothing is configured.
*/}}
{{- define "polyptic.databaseUrl" -}}
{{- if not (include "polyptic.postgresql.deployed" .) -}}
{{- .Values.externalDatabase.url -}}
{{- end -}}
{{- end }}

{{/*
Pre-flight: refuse to render a database configuration that cannot possibly work (POL-123/D108).
Called from postgres.yaml, which renders on every install. The failures are deliberately
plain-English: this is a wall product, and the operator reading a helm error should not have to
open the chart to find out what to set.
*/}}
{{- define "polyptic.validateDatabase" -}}
{{- $store := .Values.config.store -}}
{{- if not (has $store (list "postgres" "memory")) -}}
{{- fail (printf "config.store must be \"postgres\" (durable, the default) or \"memory\" (ephemeral, dev only) — got %q." $store) -}}
{{- end -}}
{{- if and .Values.postgresql.enabled .Values.externalDatabase.url -}}
{{- fail "TWO databases are configured: the bundled Postgres (postgresql.enabled=true, the chart default since POL-123) AND externalDatabase.url. Pick one — set postgresql.enabled=false to keep using your own Postgres, or clear externalDatabase.url to use the bundled one." -}}
{{- end -}}
{{- if eq $store "postgres" -}}
{{- $hasExtraEnvUrl := false -}}
{{- range .Values.extraEnv -}}
{{- if eq (.name | default "") "DATABASE_URL" -}}{{- $hasExtraEnvUrl = true -}}{{- end -}}
{{- end -}}
{{- if not (or .Values.postgresql.enabled .Values.externalDatabase.url .Values.secrets.existingSecret $hasExtraEnvUrl) -}}
{{- fail "config.store=postgres but NO database is configured — the server would start, fail to resolve a host, and crash-loop. Choose one: (a) postgresql.enabled=true to deploy the bundled Postgres (the default), (b) externalDatabase.url=postgres://user:pass@host:5432/polyptic for your own, (c) secrets.existingSecret=<secret with a DATABASE_URL key>, or (d) config.store=memory for an ephemeral dev install." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The name of the PVC backing the netboot depot (live image + signed loaders).
*/}}
{{- define "polyptic.depot.pvcName" -}}
{{- if .Values.netboot.persistence.existingClaim -}}
{{- .Values.netboot.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-depot" (include "polyptic.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
Depot subdirectories the server serves from (IMAGE_DIST_DIR / BOOT_DIST_DIR).
*/}}
{{- define "polyptic.imageDistDir" -}}
{{- printf "%s/image" .Values.netboot.depotDir -}}
{{- end }}
{{- define "polyptic.bootDistDir" -}}
{{- printf "%s/boot" .Values.netboot.depotDir -}}
{{- end }}

{{/*
The base-ISO URL for the weekly full rebuild: explicit value, or the official
Ubuntu live-server URL derived from ubuntuRelease + arch (arm64 lives on
cdimage.ubuntu.com, amd64 on releases.ubuntu.com). Arg: dict {root, arch} —
`arch` is passed PER BUILD so a mixed-fleet cluster picks the right ISO for
each arch (POL-75), not the global imageUpdates.arch.
*/}}
{{- define "polyptic.baseIsoUrl" -}}
{{- $root := .root -}}
{{- $arch := .arch -}}
{{- $rel := $root.Values.imageUpdates.ubuntuRelease -}}
{{- if $root.Values.imageUpdates.baseIsoUrl -}}
{{- $root.Values.imageUpdates.baseIsoUrl -}}
{{- else if eq $arch "arm64" -}}
{{- printf "https://cdimage.ubuntu.com/releases/%s/release/ubuntu-%s-live-server-arm64.iso" $rel $rel -}}
{{- else -}}
{{- printf "https://releases.ubuntu.com/%s/ubuntu-%s-live-server-amd64.iso" $rel $rel -}}
{{- end -}}
{{- end }}

{{/*
The ONE public origin of the deployment (POL-70/D89) — scheme://host[:port], no
trailing slash. Precedence: explicit config.publicBaseUrl → the enabled ingress
(IngressRoute host is https by design — its entrypoint is websecure; the generic
Ingress follows ingress.tls.enabled, which defaults ON) → "" (underivable: no
PUBLIC_BASE_URL is emitted and the server falls back to NODE_ENV semantics).
This single value feeds PUBLIC_BASE_URL and the defaults for CORS_ORIGIN,
PLAYER_BASE_URL and MEDIA_PUBLIC_BASE, so a TLS deployment needs exactly one
host name to end up HTTPS everywhere.
*/}}
{{- define "polyptic.publicBaseUrl" -}}
{{- if .Values.config.publicBaseUrl -}}
{{- trimSuffix "/" .Values.config.publicBaseUrl -}}
{{- else if .Values.ingressRoute.enabled -}}
{{- printf "https://%s" .Values.ingressRoute.host -}}
{{- else if .Values.ingress.enabled -}}
{{- if .Values.ingress.tls.enabled -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- else -}}
{{- printf "http://%s" .Values.ingress.host -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
POL-147 — the SNI host the mTLS passthrough route answers on (expose=ingressRouteTCP).
Precedence: an explicit agentMtls.ingressRouteTCP.host → else derived as `mtls.<ingressRoute.host>`
(same wildcard cert, one label deeper) → else FAIL, because a passthrough route with no host would
match nothing and the box would dial an address that resolves to nowhere. The box dials
wss://<this host> and its ClientHello SNI is exactly this, which is what Traefik's HostSNI matches.
*/}}
{{- define "polyptic.mtlsSniHost" -}}
{{- if .Values.agentMtls.ingressRouteTCP.host -}}
{{- .Values.agentMtls.ingressRouteTCP.host -}}
{{- else if .Values.ingressRoute.host -}}
{{- printf "mtls.%s" .Values.ingressRoute.host -}}
{{- else -}}
{{- fail "agentMtls.expose=ingressRouteTCP needs an SNI host: set agentMtls.ingressRouteTCP.host, or enable ingressRoute (host) so it can derive mtls.<ingressRoute.host>." -}}
{{- end -}}
{{- end }}

{{/*
TLS_SANS for tls.mode=self-signed (POL-70/D89): the derived public host (if any),
the in-cluster Service DNS names, plus tls.sans. Comma-joined for the env var; the
server unions in localhost/loopbacks/os.hostname() itself.
*/}}
{{- define "polyptic.tlsSans" -}}
{{- $sans := list -}}
{{- $pub := include "polyptic.publicBaseUrl" . -}}
{{- if $pub -}}
{{- $host := $pub | trimPrefix "https://" | trimPrefix "http://" -}}
{{- $host = regexReplaceAll ":\\d+$" $host "" -}}
{{- $sans = append $sans $host -}}
{{- end -}}
{{- $svc := include "polyptic.fullname" . -}}
{{- $sans = append $sans $svc -}}
{{- $sans = append $sans (printf "%s.%s" $svc .Release.Namespace) -}}
{{- $sans = append $sans (printf "%s.%s.svc" $svc .Release.Namespace) -}}
{{- range .Values.tls.sans -}}
{{- $sans = append $sans . -}}
{{- end -}}
{{- $sans | uniq | join "," -}}
{{- end }}

{{/*
CORS_ORIGIN: explicit config.corsOrigin, else the public origin, else the
documentation placeholder (matches the pre-POL-70 default).
*/}}
{{- define "polyptic.corsOrigin" -}}
{{- .Values.config.corsOrigin | default (include "polyptic.publicBaseUrl" .) | default "https://polyptic.example.com" -}}
{{- end }}

{{/*
MEDIA_PUBLIC_BASE: explicit media.publicBase, else the public origin, else the
documentation placeholder.
*/}}
{{- define "polyptic.mediaPublicBase" -}}
{{- .Values.media.publicBase | default (include "polyptic.publicBaseUrl" .) | default "https://polyptic.example.com" -}}
{{- end }}

{{/*
The URL the server hands each wall box to open (PLAYER_BASE_URL).

The single image serves the CONSOLE at / and the PLAYER at /player/ (server/src/spa.ts), so the
player base is the public origin + /player. Getting this wrong points every wall screen at the
operator's LOGIN PAGE — which is exactly what happened on the first real deployment. Operators
therefore set `config.playerBaseUrl` to the plain origin (same as corsOrigin) and the chart appends
the path — or, since POL-70/D89, set nothing and it derives from the public origin. Idempotent: an
origin that already ends in /player is left alone.
*/}}
{{- define "polyptic.playerBaseUrl" -}}
{{- $origin := .Values.config.playerBaseUrl | default (include "polyptic.publicBaseUrl" .) | default "https://polyptic.example.com" -}}
{{- $base := trimSuffix "/" $origin -}}
{{- if hasSuffix "/player" $base -}}
{{- $base -}}
{{- else -}}
{{- printf "%s/player" $base -}}
{{- end -}}
{{- end }}
