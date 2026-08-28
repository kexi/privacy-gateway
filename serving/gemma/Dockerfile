# Image for running Gemma 3 with Ollama on Cloud Run GPU (NVIDIA L4).
# Based on Google's "Run Gemma on Cloud Run with Ollama" tutorial.
#
# Approach: bake the model into the image at build time.
# Why not `ollama pull` at startup: Cloud Run must finish starting before a
# request arrives, and fetching ~8.1GB for 12b on every cold start would fail
# the startup probe. Baking it in lets Cloud Run's image streaming load it
# lazily, keeping cold starts within a usable range (tens of seconds).
# Pinned by digest, not by `:latest`.
#
# Why not `:latest`: it changed the serving runtime under a deployed fleet with
# no commit to point at. Judge verdicts flipped from mostly `leak: false` to
# near-uniformly `leak: true` mid-afternoon on 2026-08-27 with no code change on
# either side (docs/proof/openai-compat.md), and because the base was floating
# there was no way to tell which Ollama had produced which behaviour, or to get
# the earlier one back. A tag alone is not enough — tags are mutable — so the
# digest is what actually fixes the bits.
#
# 0.33.1 is the current stable release and is the version the fleet was
# observed running, so this pins the deployment to a known state rather than
# combining a bug fix with an untested version bump.
FROM ollama/ollama:0.33.1@sha256:317a9773ab450c6aa5c51797d12548ff39129abbaea64debc16f8f1b564027b7

# Model baked in at build time. gemma3:12b (~8.1GB) is the default and fits the
# L4's 24GB of VRAM. Fall back with --build-arg GEMMA_MODEL=gemma3:4b if quota
# is unavailable.
ARG GEMMA_MODEL=gemma3:12b

# Make Ollama listen on every interface in the container, on Cloud Run's PORT.
ENV OLLAMA_HOST=0.0.0.0:8080
# Where models are stored. The build-time pull and the runtime serve must agree.
ENV OLLAMA_MODELS=/models
# Parallelism, matched to Cloud Run's --concurrency (4, set in deploy.sh).
ENV OLLAMA_NUM_PARALLEL=4
# Keep the model resident so it is not reloaded on every request.
ENV OLLAMA_KEEP_ALIVE=-1
ENV OLLAMA_DEBUG=false

# Start ollama serve temporarily during the build, pull the model, and freeze it
# into a layer.
RUN mkdir -p /models \
 && (ollama serve &) \
 && timeout 300 sh -c 'until ollama list >/dev/null 2>&1; do sleep 1; done' \
 && ollama pull "${GEMMA_MODEL}" \
 && ollama list

# The base image's ENTRYPOINT is /bin/ollama, so only `serve` is passed.
ENTRYPOINT ["/bin/ollama"]
CMD ["serve"]
