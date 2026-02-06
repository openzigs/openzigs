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

FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10.28.2

# Copy package files
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy built application
COPY --from=builder /app/dist ./dist
COPY config/ ./config/

# Environment
ENV NODE_ENV=production
ENV OPENZIGS_CONFIG_DIR=/config
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
    chown -R openzigs:openzigs /data /workspace

USER openzigs

CMD ["node", "dist/server.js"]
