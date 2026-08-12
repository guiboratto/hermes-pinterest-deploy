# hermes-pinterest (n8n on Render)

Public n8n deployment for Pinterest Standard access OAuth2 demo.
Public URL: `https://hermes-pinterest.onrender.com`

## Why Render and not Railway/Fly
- Free tier with persistent disk (1GB)
- Native Docker support (we ship Dockerfile)
- HTTPS auto-provisioned (required for Pinterest OAuth)
- Health check path support (`/healthz`)
- n8n's official Render guide matches this config

## What lives where
- `render.yaml` - Render Blueprint (auto-deploy on push)
- `Dockerfile` - n8n + healthcheck
- `workflow.json` - the actual workflow (import in n8n UI after first login)
- `oauth-callback.md` - what user sees after Pinterest OAuth redirect

## OAuth2 flow
1. User clicks "Connect" in n8n credentials → redirected to Pinterest
2. User authorizes → Pinterest redirects back to:
   `https://hermes-pinterest.onrender.com/rest/oauth2-credential/callback?code=XXX&state=YYY`
3. n8n auto-exchanges code for access_token
4. Token stored in n8n credential vault (encrypted)

## Local dev alternative
If Render free tier spins down (cold start ~50s), keep local Docker container running too:
- Local: `docker run -d -p 5678:5678 -e N8N_HOST=localhost n8nio/n8n`
- Cloud: only for OAuth callback + production workflow runs

## Deploy steps
1. Push repo to GitHub: `github.com/guiboratto50/hermes-pinterest-deploy`
2. Render Dashboard → New → Blueprint → select repo
3. Render auto-creates service from `render.yaml`
4. Wait ~5 min for first build
5. Open `https://hermes-pinterest.onrender.com` → login with basic auth
6. Import `workflow.json` via n8n UI
7. Set OAuth2 credentials (Client ID + Secret + Scopes)
8. Update redirect URI in Pinterest dashboard to:
   `https://hermes-pinterest.onrender.com/rest/oauth2-credential/callback`