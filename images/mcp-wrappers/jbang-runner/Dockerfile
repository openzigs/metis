# syntax=docker/dockerfile:1.7
# Epic #271 — jbang wrapper for JVM-based MCP servers.
#
# Used by registering an MCP with:
#   runtime: 'docker-stdio'
#   command: 'ghcr.io/metis-mcps/jbang-runner:1.0'
#   args:    ['quarkiverse/quarkus-mcp-servers/jdbc-mcp']
#   env:     { JDBC_URL: '${vault:db}', … }
#
# The container entrypoint is `jbang`, so the first arg is the script /
# Maven coordinate. We pre-trust the quarkiverse org so unattended runs
# don't stall waiting for a y/n prompt.
FROM eclipse-temurin:21-jre-alpine AS base

ENV LANG=C.UTF-8 \
    JBANG_DIR=/home/app/.jbang

# Install jbang. The upstream installer honors JBANG_DIR (so the binary lands
# at $JBANG_DIR/bin/jbang, not /root/.jbang/bin/jbang as in older versions).
# We symlink it onto PATH instead of moving it, so the installer's tracked
# location stays valid for self-update.
RUN apk add --no-cache curl bash ca-certificates \
 && curl -Ls https://sh.jbang.dev | bash -s - app setup \
 && ln -sf "${JBANG_DIR}/bin/jbang" /usr/local/bin/jbang \
 && apk del curl \
 && adduser -D -u 1000 -s /sbin/nologin app \
 && chown -R 1000:1000 /home/app

USER 1000:1000
WORKDIR /home/app

# Trust quarkiverse + the common MCP-server publishers. Add more here as
# upstream packages emerge.
RUN jbang trust add https://github.com/quarkiverse/ \
 && jbang trust add https://repo1.maven.org/maven2/ \
 && jbang trust add https://repo.maven.apache.org/maven2/

ENTRYPOINT ["jbang"]
