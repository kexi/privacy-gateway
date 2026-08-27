# Cost kill switch — Pub/Sub push endpoint on Cloud Run.
#
# Same shape as the agent images (node:22-slim, pnpm workspace, dist-only
# runtime stage) for the same reason: @google-cloud/run pulls in google-gax,
# whose gRPC/protobuf path targets Node's runtime semantics.
#
# The runtime image carries no knowledge/ bundle the way the Synthesis image
# does: this service produces no OKF document and makes no attested claim. It
# reads a billing number and calls two Cloud Run APIs. The BUILD stage still
# needs knowledge/ because @privacy-gateway/common's build step hashes the
# leak-check computation into generated digest constants.

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
COPY services/kill-switch/package.json services/kill-switch/

RUN pnpm install --frozen-lockfile --filter @privacy-gateway/kill-switch...

COPY packages/common/ packages/common/
COPY services/kill-switch/ services/kill-switch/
COPY knowledge/ knowledge/

# The workspace dependency is built first: the kill switch imports its compiled
# config and logging output.
RUN pnpm --filter @privacy-gateway/common build \
 && pnpm --filter @privacy-gateway/kill-switch build

# Re-resolve with production dependencies only, so no dev tooling (tsc, vitest,
# oxlint) reaches the runtime image. `prune` would need a TTY to confirm the
# modules-directory removal, which a build stage does not have.
RUN pnpm install --frozen-lockfile --prod --filter @privacy-gateway/kill-switch...

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

# The tree is kept at its original /repo path. pnpm links each package to a
# central store via relative symlinks that reach outside the package directory,
# so relocating the service to /app would break every one of those links.
WORKDIR /repo/services/kill-switch

# node:22-slim ships an unprivileged `node` user (uid 1000); reuse it rather
# than creating another identity.
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/package.json /repo/package.json
COPY --from=build --chown=node:node /repo/packages/common/node_modules /repo/packages/common/node_modules
COPY --from=build --chown=node:node /repo/packages/common/package.json /repo/packages/common/package.json
COPY --from=build --chown=node:node /repo/packages/common/dist /repo/packages/common/dist
COPY --from=build --chown=node:node /repo/services/kill-switch/node_modules /repo/services/kill-switch/node_modules
COPY --from=build --chown=node:node /repo/services/kill-switch/package.json /repo/services/kill-switch/package.json
COPY --from=build --chown=node:node /repo/services/kill-switch/dist /repo/services/kill-switch/dist

USER node

# Cloud Run injects PORT and ignores EXPOSE; this documents the default.
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/server.js"]
