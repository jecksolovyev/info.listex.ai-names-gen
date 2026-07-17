# Browser GUI + tiny Render proxy (not desktop, not pure-browser)

The tool is a browser front-end (all spreadsheet parsing and orchestration
client-side) backed by a **tiny stateless proxy** hosted on Render's free plan.
The proxy exists solely to hold the Google credential server-side and forward
requests to Vertex AI.

## Considered options
- **Pure browser, no backend** — rejected: a service-account key can't be shipped
  to a browser, and Vertex's OAuth + missing CORS make direct browser calls
  impossible.
- **Java (JavaFX) / Go (Fyne) desktop app** — rejected: per-platform builds
  (jpackage can't cross-build; Fyne needs cgo cross-toolchains), runtime/toolchain
  friction, no real gain for 1–2 internal users.
- **Browser + tiny proxy (chosen)** — the smallest thing that keeps the credential
  off the client while giving identical behaviour on macOS and Windows.
