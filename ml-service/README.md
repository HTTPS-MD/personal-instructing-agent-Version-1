# PIA ML service (hardened pia-ml-api)

Model and inference: the original's, unchanged (see the VERBATIM block in `src/entry.py`).
Exposure: server-to-server only. Read `docs/game-rules-and-open-decisions.md` for the full picture.

## Test (no Cloudflare needed, synthetic data only)
    python3 ml-service/tests/test_ml_service.py
    node tests/learning-profile-edge.cjs        # Edge Function logic -> the real Worker code, on loopback

## Staging (never production first)
1. `cd ml-service` and log in to the CLI with YOUR Cloudflare account.
2. Python Workers need the `workers` module that only `pywrangler` provides (plain `wrangler dev` fails with "No module named 'workers'"). Needs `uv` and Node on PATH:
   `uv run --with workers-py pywrangler dev --env staging` (local, real workerd/Pyodide runtime; put `ML_TOKEN=<synthetic>` in an untracked `.dev.vars`), then `uv run --with workers-py pywrangler deploy --env staging`.
3. `npx wrangler secret put ML_TOKEN --env staging`  (a long random value; never in the repo or the browser).
4. Optional: bind a KV namespace `ML_MODEL` (read-only use) holding the old model's centres under key `pia_online_kmeans_v2_human_reactions`.
5. Supabase: `supabase functions deploy learning-profile`, then set the secrets
   `PIA_ML_URL` (the staging Worker URL), `PIA_ML_TOKEN` (same value as ML_TOKEN), `PIA_ALLOWED_ORIGINS`.
6. Apply `supabase/migrations/20261004_0044_learning_features.sql` to the STAGING database first.
7. Try with a synthetic student only. Production only after review.
