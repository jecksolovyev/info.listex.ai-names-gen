// Vertex AI client. Loads the service account from a base64 env var, initializes
// the Google Gen AI SDK in Vertex mode, and exposes generate({ prompt, rows }).
//
// The SA credential lives only here, server-side — never shipped to the browser.

import { GoogleGenAI, Type } from '@google/genai';

// Models the client is allowed to request. Keep in sync with GEMINI_MODELS in app.js.
//
// Each model is served from exactly one kind of Vertex endpoint, verified by real
// calls: the Gemini 2.5 models live ONLY on a single region (us-central1) and 404 on
// the multi-region endpoints; the Gemini 3.x models live ONLY on the `us`/`eu`
// multi-region endpoints and 404 on us-central1. So the location travels WITH the
// model, and we keep one client per location.
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
]);

// Models served from the `us`/`eu` multi-region endpoints (Gemini 3.x). Everything
// else uses the single-region GCP_LOCATION.
const MULTIREGION_MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-3.5-flash']);

// Models that reject thinkingBudget:0 with a 400 (the "pro" tier can't turn thinking
// off). For these we simply omit thinkingConfig and let the model think.
const NO_THINKING_OFF = new Set(['gemini-2.5-pro']);

function locationFor(model) {
  return MULTIREGION_MODELS.has(model)
    ? process.env.GCP_LOCATION_V3 || 'us'
    : process.env.GCP_LOCATION || 'us-central1';
}

// One GoogleGenAI client per location (2.5 → single-region, 3.x → multi-region).
const clients = new Map();

function defaultModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
}

function resolveModel(requested) {
  return requested && ALLOWED_MODELS.has(requested) ? requested : defaultModel();
}

function loadCredentials() {
  const b64 = process.env.GCP_SA_BASE64;
  if (!b64) throw new Error('GCP_SA_BASE64 is not set');
  let json;
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('GCP_SA_BASE64 is not valid base64-encoded JSON: ' + e.message);
  }
  if (json.type !== 'service_account' || !json.client_email || !json.private_key) {
    throw new Error('GCP_SA_BASE64 does not contain a service_account credential');
  }
  return json;
}

function getClient(location) {
  const cached = clients.get(location);
  if (cached) return cached;
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error('GCP_PROJECT_ID is not set');

  const client = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    googleAuthOptions: {
      credentials: loadCredentials(),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  });
  clients.set(location, client);
  return client;
}

// One JSON object per row: { row_id, F (full), G (short) }.
const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      row_id: { type: Type.INTEGER },
      F: { type: Type.STRING },
      G: { type: Type.STRING },
    },
    required: ['row_id', 'F', 'G'],
  },
};

function buildPrompt(rules, rows) {
  return [
    rules.trim(),
    '',
    '---',
    'Apply the rules above to every product row below. For each row produce the',
    'Full name (F) and the Short name (G) exactly as the rules define them. Each',
    "row's cells are labeled by both spreadsheet column letter and header name, so",
    'rules may refer to columns either way.',
    '',
    'Return ONLY a JSON array with one object per row: { "row_id", "F", "G" }.',
    'Keep every row_id exactly as given. Do not add, drop, merge, or reorder rows.',
    '',
    'Rows (JSON):',
    JSON.stringify(rows),
  ].join('\n');
}

const RETRYABLE = new Set([429, 500, 503]);

function statusOf(err) {
  // Trust the structured status/code first.
  const direct = err && (err.status ?? err.code);
  if (typeof direct === 'number') return direct;
  // Narrow message fallback: only when the number is clearly an HTTP status/code,
  // not any digit run that happens to appear in a message.
  const m = /(?:status|code)\D{0,4}(429|500|503)\b/i.exec((err && err.message) || '');
  return m ? Number(m[1]) : 0;
}

// Retry transient Vertex errors (rate limits / 5xx) with exponential backoff + jitter.
async function withBackoff(fn) {
  const MAX = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      if (!RETRYABLE.has(status) || attempt >= MAX) {
        if (status) err.status = status; // surface upstream status to the caller
        throw err;
      }
      const wait = 500 * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Gemini accepts temperature in [0, 2]. Clamp and fall back to a low default when
// the caller sends nothing usable.
function resolveTemperature(t) {
  return Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.1;
}

// thinkingBudget = thinking tokens the model may spend. 0 disables thinking (fast);
// a positive value caps it. Non-negative integer; anything else falls back to 0.
function resolveThinkingBudget(t) {
  return Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0;
}

export async function generate({ prompt, rows, model, temperature, thinkingBudget }) {
  const modelId = resolveModel(model);
  const ai = getClient(locationFor(modelId));
  const config = {
    temperature: resolveTemperature(temperature),
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
  };
  // Apply the requested thinking budget — except on models that reject
  // thinkingBudget:0 (see NO_THINKING_OFF): for those we send no thinkingConfig at
  // all and let the model think, ignoring whatever budget was requested.
  if (!NO_THINKING_OFF.has(modelId)) {
    config.thinkingConfig = { thinkingBudget: resolveThinkingBudget(thinkingBudget) };
  }
  const response = await withBackoff(() =>
    ai.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts: [{ text: buildPrompt(prompt, rows) }] }],
      config,
    })
  );

  const text = response.text;
  let items;
  try {
    items = JSON.parse(text);
  } catch (e) {
    throw new Error('Model did not return valid JSON: ' + (text || '').slice(0, 200));
  }
  if (!Array.isArray(items)) throw new Error('Model JSON was not an array');
  return { items };
}

// Fail fast at boot if config is obviously wrong (called from index.js).
export function assertConfigured() {
  loadCredentials();
  if (!process.env.GCP_PROJECT_ID) throw new Error('GCP_PROJECT_ID is not set');
}
