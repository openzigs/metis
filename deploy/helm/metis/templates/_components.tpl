{{/*
Reusable component-deployment template. Pass dict:
  root      = $        (top-level scope)
  component = .Values.<server|ui|embeddings|copilot>
  name      = "server" | "ui" | "embeddings" | "copilot"
*/}}
{{- define "metis.componentDeployment" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $name := .name -}}
{{- include "metis.assertScalingBackends" $root -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ printf "%s-%s" (include "metis.fullname" $root) $name }}
  labels:
    {{- include "metis.labels" (dict "root" $root "component" $name) | nindent 4 }}
  {{- with $root.Values.commonAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  replicas: {{ $component.replicaCount }}
  {{- with $component.progressDeadlineSeconds }}
  # Issue #786 — bound how long a rollout may sit with pods that never go Ready
  # before the Deployment is marked `ProgressDeadlineExceeded`. For the embeddings
  # sidecar this is the alarm on "the model never warmed": the rollout FAILS
  # loudly and visibly while the previous ReplicaSet keeps serving, rather than
  # hanging quietly forever.
  progressDeadlineSeconds: {{ . }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "metis.selectorLabels" (dict "root" $root "component" $name) | nindent 6 }}
  strategy:
    {{- if and (eq $name "server") (eq (int $component.replicaCount) 1) }}
    # Single-replica server: Recreate avoids two server pods briefly racing on a
    # local (RWO PVC) LanceDB volume during a rolling update. For N>1 (shared
    # Postgres/pgvector/S3 backends, see `scaling`) RollingUpdate is correct.
    type: Recreate
    {{- else }}
    type: RollingUpdate
    {{- with $component.rollingUpdate }}
    # Issue #786 — surge-before-drain. `maxUnavailable: 0` means Kubernetes will
    # not remove a single old pod until a NEW one reports Ready. Because the
    # sidecar's readiness now means "the ONNX session is warm", a bad image (or a
    # model whose weights were never baked) can no longer take capacity away: the
    # new pod sits NotReady, the rollout stalls, and every request keeps going to
    # the old ReplicaSet. Relying on the DEFAULT (25%, which rounds to 0 at two
    # replicas) would make that guarantee an accident of arithmetic.
    rollingUpdate:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- end }}
  template:
    metadata:
      labels:
        {{- include "metis.selectorLabels" (dict "root" $root "component" $name) | nindent 8 }}
      {{- with $root.Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      serviceAccountName: {{ include "metis.serviceAccountName" $root }}
      securityContext:
        {{- include "metis.podSecurityContext" $root | nindent 8 }}
      {{- with $root.Values.image.pullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- /*
        Scheduling: a per-component block WINS over the chart-global one (#786).
        The embeddings sidecar needs its own `affinity` — `onnxruntime-node` ships
        prebuilt native bindings for linux x64 + arm64 only — and it must be able
        to state that without every other component inheriting a constraint that
        has nothing to do with them.
      */}}
      {{- with (default $root.Values.nodeSelector $component.nodeSelector) }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with (default $root.Values.tolerations $component.tolerations) }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with (default $root.Values.affinity $component.affinity) }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- if and (eq $name "server") (gt (int $component.replicaCount) 1) $component.topologySpreadConstraints }}
      topologySpreadConstraints:
        {{- toYaml $component.topologySpreadConstraints | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ $name }}
          image: {{ include "metis.image" (dict "root" $root "component" $component) }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          securityContext:
            {{- include "metis.containerSecurityContext" $root | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ $component.service.port }}
              protocol: TCP
          env:
            {{- include "metis.renderEnv" (dict "root" $root "env" $component.env) | nindent 12 }}
            {{- if eq $name "server" }}
            {{- include "metis.scalingEnv" $root | nindent 12 }}
            {{- end }}
            {{- include "metis.secretEnv" $root | nindent 12 }}
          {{- with $component.probes.liveness }}
          livenessProbe:
            httpGet:
              path: {{ .path }}
              port: http
            initialDelaySeconds: {{ .initialDelaySeconds | default 20 }}
            periodSeconds: {{ .periodSeconds | default 15 }}
            timeoutSeconds: {{ .timeoutSeconds | default 5 }}
            failureThreshold: {{ .failureThreshold | default 3 }}
          {{- end }}
          {{- with $component.probes.readiness }}
          readinessProbe:
            httpGet:
              path: {{ .path }}
              port: http
            initialDelaySeconds: {{ .initialDelaySeconds | default 5 }}
            periodSeconds: {{ .periodSeconds | default 10 }}
            timeoutSeconds: {{ .timeoutSeconds | default 5 }}
            failureThreshold: {{ .failureThreshold | default 3 }}
          {{- end }}
          {{- with $component.probes.startup }}
          {{- /*
            startupProbe (#786). While this probe has NOT yet succeeded, kubelet
            runs NEITHER liveness NOR readiness. That is the whole point: a cold
            ONNX load can take tens of seconds on a fresh node, and without a
            startupProbe the livenessProbe would be counting failures against a
            process that is doing exactly what it is supposed to. The budget is
            `periodSeconds × failureThreshold`.
          */}}
          startupProbe:
            httpGet:
              path: {{ .path }}
              port: http
            initialDelaySeconds: {{ .initialDelaySeconds | default 60 }}
            periodSeconds: {{ .periodSeconds | default 5 }}
            timeoutSeconds: {{ .timeoutSeconds | default 5 }}
            failureThreshold: {{ .failureThreshold | default 24 }}
          {{- end }}
          resources:
            {{- toYaml $component.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- if and (eq $name "server") $root.Values.persistence.enabled }}
            - name: uploads
              mountPath: {{ $root.Values.persistence.uploads.mountPath }}
            - name: lancedb
              mountPath: {{ $root.Values.persistence.lancedb.mountPath }}
            {{- else if eq $name "server" }}
            - name: uploads
              mountPath: {{ $root.Values.persistence.uploads.mountPath }}
            - name: lancedb
              mountPath: {{ $root.Values.persistence.lancedb.mountPath }}
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- if eq $name "server" }}
        {{- if $root.Values.persistence.enabled }}
        - name: uploads
          persistentVolumeClaim:
            claimName: {{ printf "%s-server-uploads" (include "metis.fullname" $root) }}
        - name: lancedb
          persistentVolumeClaim:
            claimName: {{ printf "%s-server-lancedb" (include "metis.fullname" $root) }}
        {{- else }}
        # WARNING: persistence disabled. uploads + LanceDB live on emptyDir
        # and will be wiped on every pod restart. NEVER use in production.
        - name: uploads
          emptyDir: {}
        - name: lancedb
          emptyDir: {}
        {{- end }}
        {{- end }}
{{- end -}}

{{/* Reusable component-service template. */}}
{{- define "metis.componentService" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $name := .name -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ printf "%s-%s" (include "metis.fullname" $root) $name }}
  labels:
    {{- include "metis.labels" (dict "root" $root "component" $name) | nindent 4 }}
spec:
  type: {{ $component.service.type }}
  ports:
    - port: {{ $component.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "metis.selectorLabels" (dict "root" $root "component" $name) | nindent 4 }}
{{- end -}}
