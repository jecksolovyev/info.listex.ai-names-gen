// Tiny stateless proxy: serves the static front-end AND a single generate
// endpoint, both behind HTTP Basic Auth. Holds the service account; forwards to
// Vertex AI. One service (per ADR-0001 / ADR-0002).

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import { generate, assertConfigured } from './vertex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// --- Health check (public, before auth) so Render can probe without creds ---
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- HTTP Basic Auth on everything else ---
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

app.use((req, res, next) => {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next(); // unset (local dev): no gate — logged at boot

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const i = decoded.indexOf(':'); // split once — passwords may contain ':'
    const u = i === -1 ? decoded : decoded.slice(0, i);
    const p = i === -1 ? '' : decoded.slice(i + 1);
    if (safeEqual(u, user) && safeEqual(p, pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Product Name Generator"');
  return res.status(401).send('Authentication required.');
});

// --- Generate endpoint ---
app.post('/api/generate', async (req, res) => {
  const { prompt, rows, model, temperature, thinkingBudget } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }
  try {
    const { items } = await generate({ prompt, rows, model, temperature, thinkingBudget });
    res.json({ items });
  } catch (err) {
    console.error('generate failed:', err.message);
    // Pass rate-limit / unavailable through so the client can back off; else 502.
    const status = err.status === 429 || err.status === 503 ? err.status : 502;
    res.status(status).json({ error: err.message });
  }
});

// --- Static front-end ---
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Product Name Generator proxy listening on :${PORT}`);
  if (!process.env.BASIC_AUTH_USER || !process.env.BASIC_AUTH_PASS) {
    console.warn('WARNING: BASIC_AUTH_USER / BASIC_AUTH_PASS unset — the app is NOT password-protected.');
  }
  try {
    assertConfigured();
    console.log(`Vertex: project=${process.env.GCP_PROJECT_ID} location(2.5)=${process.env.GCP_LOCATION || 'us-central1'} location(3.x)=${process.env.GCP_LOCATION_V3 || 'us'} default-model=${process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'}`);
  } catch (err) {
    console.warn('WARNING: Vertex not configured —', err.message);
  }
});
