# Gateway Agent (TypeScript) — HTTP entry point + web UI on Cloud Run.
#
# Multi-stage: the Vite build for `web/` and the tsc build for the agent happen
# in the same builder, and only their outputs reach the runtime image. The
# gateway serves web/dist itself, so the demo UI and the API share one origin
# and one Cloud Run service.
#
# Why node:22-slim and not bun? The Google libraries this agent depends on
# (@google/adk, @google/genai, @google-cloud/firestore, google-auth-library and
# the OpenTelemetry SDKs pulled in transitively) target Node's runtime semantics
# — native crypto, gRPC/protobuf addons and ADC credential discovery among them.
# Bun's Node compatibility is close but not complete for that stack, and the
# agent that owns the trust boundary is the wrong place to absorb
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
COPY agents/gateway/package.json agents/gateway/
COPY web/package.json web/

RUN pnpm install --frozen-lockfile \
      --filter @privacy-gateway/gateway... \
      --filter web...

COPY packages/common/ packages/common/
COPY agents/gateway/ agents/gateway/
# The Attested Computation document, needed only at build time.
#
# `packages/common`'s build hashes it (and the attester source) into
# `attestation_digests.generated.ts`, so the digests the runtime records are
# fixed here rather than read from disk later. Why not copy it into the runtime
# stage instead: the image would then carry a second copy that could drift from
# the one the digest was taken over, and every consumer would have to decide
# which copy is canonical. A constant has exactly one answer.
COPY knowledge/computations/ knowledge/computations/

COPY web/ web/

# The shared package is built first; both the agent and the web UI import it.
RUN pnpm --filter @privacy-gateway/common build \
 && pnpm --filter @privacy-gateway/gateway build \
 && pnpm --filter web build

# Re-resolve with production dependencies only, so no dev tooling (tsc, vite,
# vitest, oxlint) reaches the runtime image. `prune` would need a TTY to confirm
# the modules-directory removal, which a build stage does not have.
RUN pnpm install --frozen-lockfile --prod --filter @privacy-gateway/gateway...

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

# The tree is kept at its original /repo path. pnpm links each package to a
# central store via relative symlinks that reach outside the package directory,
# so relocating the agent to /app would break every one of those links.
WORKDIR /repo/agents/gateway

# node:22-slim ships an unprivileged `node` user (uid 1000); reuse it rather
# than creating another identity.
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/package.json /repo/package.json
COPY --from=build --chown=node:node /repo/packages/common/node_modules /repo/packages/common/node_modules
COPY --from=build --chown=node:node /repo/packages/common/package.json /repo/packages/common/package.json
COPY --from=build --chown=node:node /repo/packages/common/dist /repo/packages/common/dist
COPY --from=build --chown=node:node /repo/agents/gateway/node_modules /repo/agents/gateway/node_modules
COPY --from=build --chown=node:node /repo/agents/gateway/package.json /repo/agents/gateway/package.json
COPY --from=build --chown=node:node /repo/agents/gateway/dist /repo/agents/gateway/dist

# The built UI, served statically by the agent.
COPY --from=build --chown=node:node /repo/web/dist /repo/web/dist

USER node

# Resolved against the runtime WORKDIR, matching the layout copied above.
ENV WEB_DIR=/repo/web/dist

# Cloud Run injects PORT and ignores EXPOSE; this documents the default.
ENV PORT=8081
EXPOSE 8081

CMD ["node", "dist/server.js"]
