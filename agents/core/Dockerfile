# Core Agent (TypeScript) — A2A server on Cloud Run.
#
# Why node:22-slim and not bun? The Google libraries this agent depends on
# (@google/adk, @google/genai, google-auth-library, and the OpenTelemetry SDKs
# pulled in transitively) target Node's runtime semantics — native crypto,
# gRPC/protobuf addons and ADC credential discovery among them. Bun's Node
# compatibility is close but not complete for that stack, and an agent whose
# whole purpose is to sit on a trust boundary is the wrong place to absorb
# runtime-compatibility risk for a marginal cold-start win.

# ---------- build stage ----------
FROM node:22-slim AS build

# Pin pnpm to the version in package.json's packageManager field so the
# lockfile is interpreted by exactly the resolver that wrote it.
ARG PNPM_VERSION=11.5.3
RUN npm install -g "pnpm@${PNPM_VERSION}"

# A build stage has no TTY, so pnpm would otherwise refuse to replace an existing
# modules directory rather than prompt for confirmation.
ENV CI=true

WORKDIR /repo

# Copy only what the resolver needs first, so dependency layers stay cached
# across source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/common/package.json packages/common/
COPY agents/core/package.json agents/core/

RUN pnpm install --frozen-lockfile --filter @privacy-gateway/core...

COPY packages/common/ packages/common/
COPY agents/core/ agents/core/

# The shared package is built first. Core imports only its vault-free subpaths
# (config, logging, schema, telemetry), which is what keeps "Core cannot read the
# vault" a property of the dependency graph.
RUN pnpm --filter @privacy-gateway/common build \
 && pnpm --filter @privacy-gateway/core build

# Re-resolve with production dependencies only, so no dev tooling (tsc, vitest,
# eslint) reaches the runtime image. `prune` would need a TTY to confirm the
# modules-directory removal, which a build stage does not have.
WORKDIR /repo
RUN pnpm install --frozen-lockfile --prod --filter @privacy-gateway/core...

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

# The tree is kept at its original /repo path. pnpm links each package to a
# central store via relative symlinks that reach outside the package directory,
# so relocating agents/core to /app would break every one of those links.
WORKDIR /repo/agents/core

# node:22-slim ships an unprivileged `node` user (uid 1000); reuse it rather
# than creating another identity.
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/package.json /repo/package.json
COPY --from=build --chown=node:node /repo/packages/common/node_modules /repo/packages/common/node_modules
COPY --from=build --chown=node:node /repo/packages/common/package.json /repo/packages/common/package.json
COPY --from=build --chown=node:node /repo/packages/common/dist /repo/packages/common/dist
COPY --from=build --chown=node:node /repo/agents/core/node_modules /repo/agents/core/node_modules
COPY --from=build --chown=node:node /repo/agents/core/package.json /repo/agents/core/package.json
COPY --from=build --chown=node:node /repo/agents/core/dist /repo/agents/core/dist

USER node

# Cloud Run injects PORT and ignores EXPOSE; this documents the default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
