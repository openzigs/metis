# syntax=docker/dockerfile:1.7
# Epic #272 / Sub-issue #286 — jbang wrapper, SSE-exposing variant.
#
# Self-contained for PR validation; do not depend on a previously-published
# ghcr.io/metis-mcps/jbang-runner:latest image.
FROM eclipse-temurin:21-jre-alpine

ENV LANG=C.UTF-8 \
    JBANG_DIR=/home/app/.jbang

RUN apk add --no-cache bash ca-certificates curl nodejs npm \
 && curl -Ls https://sh.jbang.dev | bash -s - app setup \
 && ln -sf "${JBANG_DIR}/bin/jbang" /usr/local/bin/jbang \
 && npm install -g npm@latest \
 && npm install -g --omit=dev --ignore-scripts mcp-proxy@2.10.0 \
 && npm cache clean --force \
 && apk del curl \
 && adduser -D -u 1000 -s /sbin/nologin app \
 && chown -R 1000:1000 /home/app \
 && rm -rf /root/.npm /tmp/* /var/cache/apk/*

USER 1000:1000
WORKDIR /home/app

RUN jbang trust add https://github.com/quarkiverse/ \
 && jbang trust add https://repo1.maven.org/maven2/ \
 && jbang trust add https://repo.maven.apache.org/maven2/

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["mcp-proxy", "--port", "8080", "jbang"]
