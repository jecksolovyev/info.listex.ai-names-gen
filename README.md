# Product Name Generator

A browser tool for a single content manager to bulk-rewrite existing product names
into rules-conformant **Full** and **Short** variants using Gemini (Vertex AI). Load
an `.xlsx`, paste the rewriting Rules as a prompt, run, and download the same file with
two columns appended.

See [DESIGN.md](./DESIGN.md), [CONTEXT.md](./CONTEXT.md), [PLAN.md](./PLAN.md), and
[docs/adr/](./docs/adr/) for the design and the decisions behind it.

## Architecture

- **`public/`** — vanilla-JS front-end (SheetJS from CDN, no build). Parses the file,
  orchestrates chunked generation, appends columns, downloads. Persists sessions in
  IndexedDB.
- **`server/`** — tiny Node/Express proxy. Serves `public/` **and** `POST /api/generate`,
  both behind HTTP Basic Auth. Holds the service account; forwards to Vertex AI. The
  credential never reaches the browser.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm run dev               # or: npm start
# open http://localhost:3000
```

The browser will prompt for the Basic Auth user/password you set. Same-origin `fetch`
calls to `/api/generate` reuse those cached credentials automatically.

### UI-only, no server

To click through the UI with a **mock** generator (no proxy, no Gemini):

```bash
npm run serve            # static server on http://localhost:3000
# open http://localhost:3000/?mock
```

### Environment variables

| Var | Purpose |
| --- | --- |
| `GCP_PROJECT_ID` | Vertex project (`listex-ua-production`) |
| `GCP_LOCATION` | Region for the Gemini **2.5** models (`us-central1`; single-region) |
| `GCP_LOCATION_V3` | Region for the Gemini **3.x** models (`us`; multi-region) |
| `GEMINI_MODEL` | Default model id (`gemini-2.5-flash-lite`, the cheapest; swap to another to compare) |
| `GCP_SA_BASE64` | Service-account JSON, base64 (one line) |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Login for the content manager (blank = no gate) |
| `PORT` | Server port (default 3000) |

Encode the service account:

```bash
base64 -i /path/to/service-account.json | tr -d '\n'
```

The SA needs the **Vertex AI User** role and the **Vertex AI API** enabled on the project.

## Deploy to Render (free)

End-to-end, from a clean machine to a live URL the content manager can log into.

### 1. Prepare Google Cloud (one time)

Do this once for the project (`listex-ua-production`). Use the Cloud Console or the
`gcloud` CLI.

1. **Enable the Vertex AI API** on the project:
   ```bash
   gcloud services enable aiplatform.googleapis.com --project listex-ua-production
   ```
   (Console: APIs & Services → Enable APIs → search "Vertex AI API" → Enable.)

2. **Grant the service account the Vertex AI User role.** Find the SA email inside the
   JSON key (`client_email`), then:
   ```bash
   gcloud projects add-iam-policy-binding listex-ua-production \
     --member="serviceAccount:<client_email>" \
     --role="roles/aiplatform.user"
   ```
   (Console: IAM & Admin → IAM → grant the SA the **Vertex AI User** role.)

3. **Region travels with the model** (verified by real calls). The Gemini **2.5**
   models are served **only** from the single-region endpoint (`GCP_LOCATION=us-central1`)
   and 404 on multi-region; the Gemini **3.x** models (`gemini-3.1-flash-lite`,
   `gemini-3.5-flash`) are served **only** from the multi-region endpoint
   (`GCP_LOCATION_V3=us`, or `eu`) and 404 on `us-central1`. The server routes each
   request to the right region automatically, so leave both set. `gemini-2.5-flash-lite`
   is the default; the selectable set is fixed in code (`GEMINI_MODELS` in `app.js`).

4. **(Optional) Check quota** before large runs: Console → IAM & Admin → Quotas →
   filter "Vertex AI API" (requests per minute / tokens per minute). Request an
   increase if you plan to raise `CONCURRENCY`.

### 2. Encode the service account key

The proxy reads the SA from a single-line base64 env var (never commit the JSON):

```bash
base64 -i /path/to/service-account.json | tr -d '\n'
```

Copy the entire one-line output — you'll paste it into `GCP_SA_BASE64` in step 4.

### 3. Push the repo to GitHub

`.gitignore` already excludes `.env` and `node_modules`, so no secret is committed.

```bash
git init
git add .
git commit -m "Product Name Generator"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

### 4. Create the Render service

1. In [Render](https://dashboard.render.com): **New → Blueprint**.
2. Connect the GitHub repo. Render reads [`render.yaml`](./render.yaml) and proposes a
   free Node web service (`buildCommand: npm install`, `startCommand: npm start`,
   health check `/healthz`).
3. Click **Apply / Create**. It will build once, then wait for env vars.
4. In the service’s **Environment** tab, fill in the three secrets. Everything else is
   pre-filled from `render.yaml`; only the `sync:false` rows below start blank:

   | Var | Value | |
   | --- | --- | --- |
   | `GCP_PROJECT_ID` | `listex-ua-production` | *pre-filled* |
   | `GCP_LOCATION` | `us-central1` | *pre-filled — single-region, Gemini 2.5* |
   | `GCP_LOCATION_V3` | `us` | *pre-filled — multi-region, Gemini 3.x* |
   | `GEMINI_MODEL` | `gemini-2.5-flash-lite` | *pre-filled — cheapest; change to compare* |
   | `GCP_SA_BASE64` | the one-line base64 from step 2 | **secret — you set this** |
   | `BASIC_AUTH_USER` | the login for the content manager | **secret — you set this** |
   | `BASIC_AUTH_PASS` | the password | **secret — you set this** |

5. **Save** — Render redeploys with the new env. Watch the deploy **Logs**; on a good
   boot you’ll see:
   ```
   Product Name Generator proxy listening on :10000
   Vertex: project=listex-ua-production location(2.5)=us-central1 location(3.x)=us default-model=gemini-2.5-flash-lite
   ```
   (Render sets `PORT` itself — do **not** hard-set it.) A `WARNING: Vertex not
   configured` or `... NOT password-protected` line means an env var is missing.

### 5. Verify

- Open `https://<your-service>.onrender.com/healthz` → `{"ok":true}` (no login).
- Open `https://<your-service>.onrender.com/` → the browser prompts for the Basic Auth
  user/password. Log in, load `example.xlsx`, paste a prompt, **TEST (first 5)**, then
  run a small window and **Download**.

### 6. Hand off

Give the content manager the URL + the `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`. Nothing
else to install — sessions live in their browser.

> **Free-tier behavior:** the service spins down after ~15 min idle; the first request
> after that takes ~30–60s to wake (later requests are fast). The app is stateless —
> all session/results data lives in the browser (IndexedDB), so a spin-down loses
> nothing. Redeploys don’t touch user data either.

### Updating the deployment

Push to the `main` branch — Render auto-deploys. To change the login or rotate the SA
key, edit the env vars in the dashboard and save (triggers a redeploy).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `502 ... PERMISSION_DENIED` | SA lacks **Vertex AI User**, or the Vertex AI API isn’t enabled (step 1). |
| `502 ... GCP_SA_BASE64 does not contain a service_account` | Bad/partial base64 — re-encode with the exact command in step 2 (no line breaks). |
| Boot log: `WARNING: Vertex not configured` | `GCP_SA_BASE64` or `GCP_PROJECT_ID` not set. |
| Boot log: `... NOT password-protected` | `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` blank — set both. |
| `429` / "throttled" during a run | Vertex rate limit; the app already backs off and lowers concurrency. Raise quota (step 1.4) or lower `CONCURRENCY`. |
| First request very slow | Free-tier cold start (~30–60s). Normal. |
| `404` on the model | Model/region mismatch. Gemini 2.5 needs `GCP_LOCATION=us-central1`; Gemini 3.x needs `GCP_LOCATION_V3=us` (or `eu`). The server routes per model — check both are set. |

## Smoke test (local or deployed)

- `GET /healthz` → `{"ok":true}` (no auth).
- Open the app, load `example.xlsx`, paste a prompt, **TEST (first 5)**, then **Run**.
