# Backend - interview-12 - PHASE 1

## File placement
Add all files at repo root exactly as:
- wrangler.toml
- package.json
- tsconfig.json
- src/index.ts
- src/db.ts
- src/utils/token.ts
- migrations/0001_create_public_tokens_and_pages.sql
- migrations/0002_create_versions.sql
- migrations/0003_seed_INT-001_token.sql
- .github/workflows/backend-migrate-and-deploy.yml

## Secrets required (already configured per your spec)
- GitHub Secrets: CLOUDFLARE_API_TOKEN (with D1 edit + Workers deploy perms)
- GitHub Variables: CLOUDFLARE_ACCOUNT_ID

No secrets in code. Never paste token in chat.

## How deployment works (auto, safe, idempotent)
1. Push backend files to `main` branch -> GitHub Actions triggers `Backend - Migrate and Deploy`
2. Job `migrate` runs:
   - `wrangler d1 execute interview-12 --remote --file=0001...` (CREATE IF NOT EXISTS only)
   - 0002, 0003 same. No DROP TABLE, no DELETE. Preserves INT-001.
3. Job `deploy` runs AFTER migrate succeeds (needs: migrate)
   - `wrangler deploy` deploys Worker `interview-12-backend`
4. Tokens: 128-bit crypto random via `crypto.getRandomValues` in Worker, never derived from ID. Existing interviews without token get token on first admin backfill call.

## Endpoints exposed (for frontend Phase 2)
Public (no auth):
- GET /api/public/:token -> returns interview structure
- POST /api/public/:token/submit -> body { respondent_name, respondent_email, respondent_type: 'freelancer'|'agency', answers: { Q1: {selected:['A'], other_text, text_answer} } }
- GET /q/:token -> same as public get (for direct link)

Dashboard (protect via Cloudflare Access path /api/interviews/*):
- GET /api/interviews -> list with submission counts, public_link
- POST /api/interviews -> create, auto-generates 001 sequential + secure token
- POST /api/interviews/:code/duplicate -> new ID + new token, no submissions copied
- POST /api/interviews/:code/publish | /unpublish -> publish controls dashboard sharing, but existing links remain usable per spec
- GET /api/interviews/:code/submissions?search=partialName&limit=100 -> case-insensitive search
- GET /api/interviews/:code/export?format=csv|json|txt -> one row per submission: ID,name,email,work_type,Q1,Q2... with compact codes A, A,C, F (text)
- POST /api/interviews/:code/admin/backfill-tokens -> generates secure tokens for missing interviews (call once after first deploy)

## Important - Access scope
In Cloudflare Zero Trust Access, create application:
- Application: interview-dashboard
- Path: YOUR-DOMAIN/api/interviews/* and YOUR-DOMAIN/api/health (or /dashboard/* for future frontend)
- DO NOT include /api/public/* or /q/* - those must remain public per spec, otherwise bearer links break.

## Minimal steps for you
1. Add files to GitHub repo root on main.
2. Ensure GitHub Variables/Secrets set.
3. Push -> Actions will migrate then deploy.
4. After first deploy, run once: curl -X POST https://interview-12-backend.<your-subdomain>.workers.dev/api/interviews/INT-001/admin/backfill-tokens -H "Cf-Access-Jwt-Assertion: ..." if behind Access, or temporarily allow.
5. Verify: https://interview-12-backend.<subdomain>.workers.dev/api/health

No frontend generated in this phase.


---

## Review notes for the corrected backend branch

The backend files are being reorganized under `src/`, configuration and migration filenames are normalized for Linux/Cloudflare tooling, and the GitHub Actions workflow now lives under `.github/workflows/`. The Worker checks Cloudflare Access JWTs for dashboard API routes and maps lowercase public work-type values to the capitalized values required by the existing D1 CHECK constraint.

### Required Cloudflare Access variables
- `ACCESS_TEAM_DOMAIN`: Access team domain, e.g. `your-team.cloudflareaccess.com`.
- `ACCESS_AUD`: AUD tag for the Access application protecting dashboard API routes.

Configure these as Worker environment variables before using the dashboard API. Do not protect `/api/public/*` with Access.

### Implemented routes in this branch
- `GET /api/health`
- `GET /api/public/{token}`
- `POST /api/public/{token}/submit`
- `GET /api/interviews`
- `POST /api/interviews`
- `POST /api/interviews/{code}/publish`
- `POST /api/interviews/{code}/unpublish`
- `POST /api/interviews/{code}/duplicate`
- `GET /api/interviews/{code}/submissions?search=...`
- `GET /api/interviews/{code}/export?format=json|csv|txt`

### Not production-complete yet
This branch is a repair pass, not a claim that the full product is complete. Question/page editing endpoints, a detailed-submission endpoint, immutable snapshots for historical questionnaire versions, and automated integration tests remain outstanding. Do not merge/deploy until the TypeScript check and a staging migration test pass. The migration SQL is additive and does not drop existing tables or delete the existing `INT-001` row.
