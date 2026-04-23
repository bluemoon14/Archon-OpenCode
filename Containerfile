# Containerfile — Archon CLI (Podman / Docker compatible)
# Builds a single-stage image that compiles the CLI binary and runs it as entrypoint.
# Usage:
#   podman build -f Containerfile -t archon .
#   podman run --rm archon workflow list

FROM docker.io/oven/bun:1-alpine AS build

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/workflows/package.json ./packages/workflows/
RUN bun install --frozen-lockfile

# Copy source and build the CLI binary
COPY . .
RUN bun run build:binaries

FROM docker.io/oven/bun:1-alpine

# Runtime basics: git (workflows shell out) and CA certs
RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY --from=build /app/dist/binaries/archon-linux-x64 /usr/local/bin/archon
RUN chmod +x /usr/local/bin/archon

ENV ARCHON_HOME=/.archon
VOLUME /.archon

ENTRYPOINT ["archon"]
CMD ["--help"]
