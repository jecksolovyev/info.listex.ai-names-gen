# Auth: service-account → Vertex AI, gated by HTTP Basic Auth

The proxy authenticates to Google with the existing `listex-ua-production`
service-account JSON (supplied as a **base64 env var** on Render) and calls
**Vertex AI** (project `listex-ua-production`, region `us` multi-region). The proxy
serves both the GUI and the API and puts **HTTP Basic Auth** (username/password in
env vars) in front of **every** route. Credentials are handed only to the content
manager.

## Why
A service-account key must never ship to a browser, so a server-side proxy is the
only place it can live. A password enforced in the browser is worthless — the real
attack surface is the proxy URL, so the proxy itself must reject unauthenticated
requests. Render provides HTTPS, so Basic Auth is not sent in cleartext.

## Considered options
- Gemini Developer API key instead of the service account — rejected: we already
  have the service account + project, and Vertex gives data-governance (no training
  on our catalog) and region control.
