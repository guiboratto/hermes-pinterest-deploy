FROM node:20-alpine

WORKDIR /app

# Install deps for server
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY server.js ./

# Copy landings + gifs (for static serving)
COPY landings ./landings
COPY gifs ./gifs

# Healthcheck uses wget (built into alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:5678/healthz || exit 1

EXPOSE 5678
CMD ["node", "server.js"]
