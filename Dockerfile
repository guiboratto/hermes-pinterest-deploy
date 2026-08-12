FROM n8nio/n8n:latest

# Health check endpoint for Render
USER root
RUN apk add --no-cache curl
USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:5678/healthz || exit 1