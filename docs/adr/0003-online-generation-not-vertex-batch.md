# Online generation, not the Vertex Batch Prediction API

Names are generated via **online** Vertex AI calls orchestrated from the browser,
not via the **Vertex Batch Prediction API**.

## Considered options
- **Vertex Batch Prediction** — rejected: ~50% cheaper and it removes the
  long-running-tab problem, but it requires Cloud Storage I/O, async job tracking,
  and extra IAM — too much surface for a "tiny" tool with a single user.
- **Online (chosen)** — simpler infra: no bucket, no async job, the service account
  only needs `Vertex AI User`.

## Consequences
Runs are browser-driven and synchronous. Chunking (ADR-0004) keeps even a 60k-row
run to tens of minutes, which makes the online path tolerable. Someone will suggest
Batch again at scale — this records why we did not start there.
