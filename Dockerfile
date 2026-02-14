FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10.28.2

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-slim AS development

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  imagemagick \
  ghostscript \
  make \
  g++ \
  python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.28.2

COPY package.json pnpm-lock.yaml ./
RUN pnpm install

COPY . .

ENV NODE_ENV=development

CMD ["pnpm", "dev"]

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  imagemagick \
  ghostscript \
  make \
  g++ \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Copy artifacts from builder stage (dependencies and build output)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config/

# Environment
ENV NODE_ENV=production
ENV OPENZIGS_CONFIG_DIR=/app/config
ENV OPENZIGS_DATA_DIR=/data
ENV OPENZIGS_WORKSPACE=/workspace

# Expose ports
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Non-root user for security
RUN useradd -m openzigs && \
  mkdir -p /data /workspace && \
  chown -R openzigs:openzigs /app /data /workspace

USER openzigs

CMD ["node", "dist/server.js"]
