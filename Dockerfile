FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application
COPY dist/ ./dist/
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
RUN useradd -m openzigs
USER openzigs

CMD ["node", "dist/server.js"]
