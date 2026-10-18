# Interview Research Platform backend

This backend is implemented as a Cloudflare Worker backed by D1. The existing frontend can call the Worker API from its Vercel origin.

## Important production-schema warning

The live D1 database was deliberately not inspected or queried while preparing these files. Migration `0001_initial.sql` is an additive, `CREATE TABLE/INDEX IF NOT EXISTS` migration, but compatibility with the existing live schema is **not verified**. Review the SQL and take an appropriate backup/export before approving a production migration. The workflow defaults both production actions to off and only runs on manual dispatch. No migration or deployment is triggered by a push.

## Files

- `src/index.js`: Worker API, validation, sessions, rate limits, CSV export.
- `migrations/0001_initial.sql`: initial additive schema.
- `wrangler.toml`: Worker and D1 binding configuration.
- `.github/workflows/manual-deploy.yml`: separately opted-in migration and deployment jobs.
- `tests/worker.test.js`: local unit tests with no production access.

## Before deployment

1. In Cloudflare, find the UUID for the existing D1 database named `interview-12`. Replace `REPLACE_WITH_EXISTING_D1_DATABASE_ID` in `wrangler.toml`. This does not query the database.
2. Set `ALLOWED_ORIGINS` to the exact Vercel production origin, plus any explicitly trusted preview origins separated by commas. Do not use `*`.
3. Add these Worker secrets using Cloudflare's dashboard or Wrangler locally; do not put them in Git:
   - `OWNER_EMAIL`: the single owner login email.
   - `OWNER_PASSWORD_HASH`: PBKDF2-SHA-256 password hash encoded as `salt_hex:hash_hex`, using a random salt of at least 16 bytes and 310,000 iterations. The resulting hash is 32 bytes.
   - `OWNER_SESSION_SECRET`: a cryptographically random secret of at least 32 bytes.
4. The existing GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are consumed only by the manual workflow. Ensure the token is scoped to the correct account and has Workers Scripts:Edit and D1:Edit permissions if using migrations.
5. In GitHub, consider configuring a required-reviewer protection rule for the `production` environment. The workflow also requires the explicit boolean input for each action.

### Create the owner password hash locally

Use Node.js on your own machine; this command prints a hash, not your password. Keep the output private and enter it as the Worker secret `OWNER_PASSWORD_HASH`.

```sh
node --input-type=module -e 'import {randomBytes,pbkdf2Sync} from "node:crypto"; const password=process.env.OWNER_PASSWORD; if(!password || password.length<16) throw new Error("Set OWNER_PASSWORD to at least 16 characters"); const salt=randomBytes(16); console.log(salt.toString("hex")+":"+pbkdf2Sync(password,salt,310000,32,"sha256").toString("hex"));'
```

Set `OWNER_PASSWORD` in your local shell before running it. Then add the output as a Worker secret; do not commit it.

Set Worker secrets (from a trusted local terminal, after replacing the account config):

```sh
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put OWNER_PASSWORD_HASH
npx wrangler secret put OWNER_SESSION_SECRET
```

## Local validation

```sh
npm install
npm test
npx wrangler dev
```

The unit tests do not access Cloudflare or D1. Local development requires a local D1 database; use a separate development database if testing persistence.

## Manual GitHub Actions procedure

1. Review `migrations/0001_initial.sql` against the live schema using your own approved process. This implementation did not inspect it, and no claim of compatibility is made.
2. Open **Actions → Manual D1 migration and Worker deployment → Run workflow** on the branch you intend to deploy.
3. First run with both inputs unchecked to validate the workflow wiring without production changes (the jobs are skipped).
4. To apply SQL, check `apply_migrations` only after your review/approval. This runs `wrangler d1 migrations apply interview-12 --remote`.
5. To deploy the Worker, check `deploy_worker` only after configuration and secrets are ready. Deployment runs local tests first, then `wrangler deploy`.
6. If both are selected, migration runs before deployment. If migration fails, deployment is blocked. If you choose deployment without migration, the workflow permits it only because you explicitly opted into deployment.
7. Verify the run in Actions. Then check the Worker URL `/api/health`, and test owner login and a draft questionnaire before pointing the frontend at production.

## API overview

All paths are relative to the Worker origin. JSON requests should use `Content-Type: application/json`. Owner routes use an HttpOnly signed session cookie issued by login. For cross-origin browser requests, use `credentials: "include"`; mutating owner requests must include `X-Requested-With: XMLHttpRequest` and an allowed Origin.

- `GET /api/health`
- `POST /api/owner/login` with `{ "email": "...", "password": "..." }`
- `POST /api/owner/logout`
- `GET /api/owner/me`
- `GET /api/owner/questionnaires` (includes response counts)
- `POST /api/owner/questionnaires` (create draft and version 1)
- `GET /api/owner/questionnaires/:id`
- `PUT /api/owner/questionnaires/:id` (creates a new immutable questionnaire version)
- `PATCH /api/owner/questionnaires/:id/status` with `{ "status": "active" | "inactive" | "draft" }`
- `GET /api/owner/questionnaires/:id/submissions`
- `GET /api/owner/submissions/:id`
- `GET /api/owner/questionnaires/:id/export.csv`
- `GET /api/public/questionnaires/:slug`
- `POST /api/public/questionnaires/:slug/submissions` with `{ "answers": { "questionId": "answer" } }`

Question types: `text`, `long_text`, `single_choice`, `multiple_choice`, `dropdown`, `rating`, `email`, `number`, `date`, `boolean`. Conditional question format: `condition: { "questionId": "previousQuestionId", "operator": "equals" | "not_equals" | "contains", "value": "..." }`.

## Security and operational notes

- Respondents have no read route for submissions; public APIs expose only an active questionnaire and accept submissions.
- Questionnaire versions are immutable and submissions point to the exact version used at submission time. Answers also store a label snapshot.
- SQL values are bound parameters; user input is validated and request bodies are capped at 64 KiB.
- CORS is exact-origin allow-list based. Rate limits use D1 fixed-window buckets keyed by a SHA-256 hash of the Cloudflare client IP and do not store raw IP addresses.
- The Worker session is HttpOnly, Secure, signed, and time-limited; mutating owner calls require an allowed Origin and custom header.
- CSV export neutralizes common spreadsheet formula injection prefixes.
- D1 does not make multiple independent writes atomic unless wrapped in a supported transaction/batch. Submission row and answer batch are separate calls, so an unexpected write failure after submission insertion could leave a submission with no/partial answers; monitor and address with an approved follow-up if strict atomicity is required.
- No deletion endpoint is provided. The schema uses restrictive foreign keys to protect historical records.
- Configure log retention and operational monitoring separately; do not log response bodies or credentials.
