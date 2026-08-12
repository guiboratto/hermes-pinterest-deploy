FROM n8nio/n8n:latest

# Healthcheck uses wget (already in alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:5678/healthz || exit 1
