const QUESTION_TYPES = new Set([
  "text", "long_text", "single_choice", "multiple_choice", "dropdown",
  "rating", "email", "number", "date", "boolean"
]);
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = "__Host-interview_owner";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers }
  });
}
function nowIso() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function slugify(value) {
  return String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || crypto.randomUUID().slice(0, 8);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function parseOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = parseOrigins(env);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Requested-With",
    "access-control-allow-credentials": "true",
    "vary": "Origin"
  };
}
function isOriginAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || parseOrigins(env).includes(origin);
}
function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON body"); }
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function validateQuestionnaire(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Expected a questionnaire object");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!title || title.length > 200) throw new HttpError(400, "Title is required and must be at most 200 characters");
  if (description.length > 5000) throw new HttpError(400, "Description is too long");
  if (!Array.isArray(input.questions) || input.questions.length > 150) throw new HttpError(400, "Questions must be an array of at most 150 items");
  const seen = new Set();
  const questions = input.questions.map((q, index) => {
    if (!q || typeof q !== "object" || Array.isArray(q)) throw new HttpError(400, "Invalid question at index " + index);
    const qid = typeof q.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(q.id) ? q.id : "q_" + (index + 1);
    if (seen.has(qid)) throw new HttpError(400, "Question IDs must be unique");
    seen.add(qid);
    if (typeof q.label !== "string" || !q.label.trim() || q.label.trim().length > 1000) throw new HttpError(400, "Each question needs a label of at most 1000 characters");
    if (!QUESTION_TYPES.has(q.type)) throw new HttpError(400, "Unsupported question type: " + String(q.type));
    const item = { id: qid, label: q.label.trim(), type: q.type, required: q.required === true };
    if (["single_choice", "multiple_choice", "dropdown"].includes(q.type)) {
      if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 100 ||
          q.options.some(o => typeof o !== "string" || !o.trim() || o.length > 300)) {
        throw new HttpError(400, "Choice questions require 1–100 non-empty options");
      }
      item.options = [...new Set(q.options.map(o => o.trim()))];
      if (!item.options.length) throw new HttpError(400, "Choice options cannot be empty");
    }
    if (q.type === "rating") {
      item.min = Number.isInteger(q.min) ? Math.max(0, Math.min(10, q.min)) : 1;
      item.max = Number.isInteger(q.max) ? Math.max(item.min + 1, Math.min(10, q.max)) : 5;
      if (item.max > 10 || item.min >= item.max) throw new HttpError(400, "Rating range must be valid and no wider than 0–10");
    }
    if (q.type === "number") {
      if (q.min !== undefined && Number.isFinite(q.min)) item.min = q.min;
      if (q.max !== undefined && Number.isFinite(q.max)) item.max = q.max;
      if (item.min !== undefined && item.max !== undefined && item.min > item.max) throw new HttpError(400, "Invalid numeric range");
    }
    if (q.condition !== undefined && q.condition !== null) {
      const c = q.condition;
      if (!c || typeof c !== "object" || !["equals", "not_equals", "contains"].includes(c.operator) ||
          typeof c.questionId !== "string" || !seen.has(c.questionId)) {
        throw new HttpError(400, "A condition must reference an earlier question and use equals, not_equals, or contains");
      }
      item.condition = { questionId: c.questionId, operator: c.operator, value: c.value };
    }
    return item;
  });
  return { title, description, questions };
}
function conditionMatches(condition, answers) {
  if (!condition) return true;
  const actual = answers[condition.questionId];
  if (condition.operator === "equals") return JSON.stringify(actual) === JSON.stringify(condition.value);
  if (condition.operator === "not_equals") return JSON.stringify(actual) !== JSON.stringify(condition.value);
  if (condition.operator === "contains") {
    return Array.isArray(actual) ? actual.includes(condition.value) : typeof actual === "string" && actual.includes(String(condition.value));
  }
  return false;
}
function validateAnswers(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Answers must be an object keyed by question ID");
  const clean = {};
  const questions = schema.questions || [];
  for (const q of questions) {
    const visible = conditionMatches(q.condition, clean);
    const value = input[q.id];
    if (!visible) continue;
    if (value === undefined || value === null || value === "") {
      if (q.required) throw new HttpError(400, "Required answer missing: " + q.id);
      continue;
    }
    let valid = true;
    if (["text", "long_text", "email", "date"].includes(q.type)) {
      valid = typeof value === "string" && value.length <= (q.type === "long_text" ? 10000 : 2000);
      if (valid && q.type === "email") valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      if (valid && q.type === "date") valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    } else if (q.type === "number") {
      valid = typeof value === "number" && Number.isFinite(value) &&
        (q.min === undefined || value >= q.min) && (q.max === undefined || value <= q.max);
    } else if (q.type === "rating") {
      valid = Number.isInteger(value) && value >= q.min && value <= q.max;
    } else if (q.type === "boolean") {
      valid = typeof value === "boolean";
    } else if (q.type === "single_choice" || q.type === "dropdown") {
      valid = typeof value === "string" && q.options.includes(value);
    } else if (q.type === "multiple_choice") {
      valid = Array.isArray(value) && value.length <= q.options.length &&
        value.every(v => typeof v === "string" && q.options.includes(v)) && new Set(value).size === value.length;
    }
    if (!valid) throw new HttpError(400, "Invalid answer for question: " + q.id);
    clean[q.id] = value;
  }
  for (const key of Object.keys(input)) {
    if (!questions.some(q => q.id === key)) throw new HttpError(400, "Unknown question ID: " + key);
  }
  return clean;
}
function csvCell(value) {
  let s = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // Prevent spreadsheet formula injection as well as CSV quoting errors.
  if (/^[\s]*[=+@\-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(rows) {
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
function bytesToBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
async function issueSession(env) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ sub: env.OWNER_EMAIL, exp: Math.floor(Date.now() / 1000) + Number(env.SESSION_TTL_SECONDS || 28800) })));
  const sig = bytesToBase64Url(await hmac(env.OWNER_SESSION_SECRET, payload));
  return payload + "." + sig;
}
async function verifySession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  if (!token || !env.OWNER_SESSION_SECRET || !env.OWNER_EMAIL) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = bytesToBase64Url(await hmac(env.OWNER_SESSION_SECRET, parts[0]));
  if (!safeEqual(expected, parts[1])) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    return payload.sub === env.OWNER_EMAIL && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || !encoded || !encoded.includes(":")) return false;
  const [saltHex, hashHex] = encoded.split(":");
  if (!/^[0-9a-f]{32,128}$/i.test(saltHex) || !/^[0-9a-f]{64}$/i.test(hashHex)) return false;
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), x => parseInt(x, 16));
  const expected = Uint8Array.from(hashHex.match(/.{2}/g), x => parseInt(x, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, key, 256);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
async function rateLimit(request, env, bucket, limit) {
  const windowSeconds = Math.max(10, Number(env.RATE_LIMIT_WINDOW_SECONDS || 60));
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bucket + "|" + ip));
  const key = bucket + ":" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(`INSERT INTO rate_limits (bucket_key, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_start = excluded.window_start,
      request_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.request_count + 1 ELSE 1 END`)
    .bind(key, windowStart).run();
  const row = await env.DB.prepare("SELECT request_count FROM rate_limits WHERE bucket_key = ?").bind(key).first();
  return Number(row?.request_count || 0) <= limit;
}
async function ownerOnly(request, env) {
  if (!await verifySession(request, env)) throw new HttpError(401, "Owner authentication required");
  if (["POST", "PUT", "PATCH"].includes(request.method) && request.headers.get("Origin") &&
      (!isOriginAllowed(request, env) || request.headers.get("X-Requested-With") !== "XMLHttpRequest")) {
    throw new HttpError(403, "Request origin or CSRF header rejected");
  }
}
async function listQuestionnaires(env) {
  const { results = [] } = await env.DB.prepare(`SELECT q.id, q.slug, q.title, q.description, q.status,
    q.current_version_id, q.created_at, q.updated_at,
    (SELECT COUNT(*) FROM submissions s WHERE s.questionnaire_id = q.id) AS response_count
    FROM questionnaires q ORDER BY q.updated_at DESC`).all();
  return results;
}
async function handle(request, env) {
  if (!env.DB) throw new HttpError(500, "D1 binding DB is not configured");
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") {
    if (!isOriginAllowed(request, env)) return json({ error: "Origin not allowed" }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "interview-research-api" });
  if (path === "/api/owner/login" && request.method === "POST") {
    if (!isOriginAllowed(request, env)) throw new HttpError(403, "Origin not allowed");
    if (!await rateLimit(request, env, "owner-login", Number(env.OWNER_LOGIN_RATE_LIMIT || 8))) throw new HttpError(429, "Too many login attempts");
    const body = await readJson(request);
    if (typeof body.email !== "string" || body.email.toLowerCase() !== String(env.OWNER_EMAIL || "").toLowerCase() ||
        !await verifyPassword(body.password, env.OWNER_PASSWORD_HASH)) throw new HttpError(401, "Invalid email or password");
    const token = await issueSession(env);
    return json({ ok: true, email: env.OWNER_EMAIL }, 200, {
      "set-cookie": SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=" + Number(env.SESSION_TTL_SECONDS || 28800)
    });
  }
  if (path === "/api/owner/logout" && request.method === "POST") {
    await ownerOnly(request, env);
    return json({ ok: true }, 200, { "set-cookie": SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0" });
  }
  const publicMatch = path.match(/^\/api\/public\/questionnaires\/([a-z0-9-]+)$/);
  if (publicMatch && request.method === "GET") {
    if (!await rateLimit(request, env, "public-read", Number(env.PUBLIC_RATE_LIMIT || 20))) throw new HttpError(429, "Rate limit exceeded");
    const row = await env.DB.prepare(`SELECT q.id, q.slug, q.title, q.description, v.id AS version_id, v.version_number, v.schema_json
      FROM questionnaires q JOIN questionnaire_versions v ON v.id = q.current_version_id
      WHERE q.slug = ? AND q.status = 'active'`).bind(publicMatch[1]).first();
    if (!row) throw new HttpError(404, "Questionnaire not found or inactive");
    const schema = JSON.parse(row.schema_json);
    return json({ id: row.id, slug: row.slug, title: row.title, description: row.description, version: row.version_number, questions: schema.questions });
  }
  const submitMatch = path.match(/^\/api\/public\/questionnaires\/([a-z0-9-]+)\/submissions$/);
  if (submitMatch && request.method === "POST") {
    if (!await rateLimit(request, env, "public-submit", Number(env.PUBLIC_RATE_LIMIT || 20))) throw new HttpError(429, "Rate limit exceeded");
    const row = await env.DB.prepare(`SELECT q.id, q.current_version_id, v.schema_json
      FROM questionnaires q JOIN questionnaire_versions v ON v.id = q.current_version_id
      WHERE q.slug = ? AND q.status = 'active'`).bind(submitMatch[1]).first();
    if (!row) throw new HttpError(404, "Questionnaire not found or inactive");
    const body = await readJson(request);
    const clean = validateAnswers(JSON.parse(row.schema_json), body.answers);
    const submissionId = id();
    const createdAt = nowIso();
    await env.DB.prepare("INSERT INTO submissions (id, questionnaire_id, questionnaire_version_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(submissionId, row.id, row.current_version_id, createdAt).run();
    const versionSchema = JSON.parse(row.schema_json);
    const stmts = Object.entries(clean).map(([key, value]) => {
      const question = versionSchema.questions.find(q => q.id === key);
      return env.DB.prepare("INSERT INTO answers (id, submission_id, question_key, question_label, answer_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id(), submissionId, key, question.label, JSON.stringify(value), createdAt);
    });
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, receipt: submissionId }, 201);
  }
  if (path.startsWith("/api/owner/")) await ownerOnly(request, env);
  if (path === "/api/owner/me" && request.method === "GET") return json({ email: env.OWNER_EMAIL });
  if (path === "/api/owner/questionnaires" && request.method === "GET") return json({ questionnaires: await listQuestionnaires(env) });
  if (path === "/api/owner/questionnaires" && request.method === "POST") {
    const schema = validateQuestionnaire(await readJson(request));
    const questionnaireId = id(), versionId = id(), createdAt = nowIso();
    let slug = slugify(schema.title);
    const existing = await env.DB.prepare("SELECT id FROM questionnaires WHERE slug = ?").bind(slug).first();
    if (existing) slug = slug.slice(0, 55) + "-" + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare("INSERT INTO questionnaires (id, slug, title, description, status, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)")
      .bind(questionnaireId, slug, schema.title, schema.description, versionId, createdAt, createdAt).run();
    await env.DB.prepare("INSERT INTO questionnaire_versions (id, questionnaire_id, version_number, schema_json, created_at) VALUES (?, ?, 1, ?, ?)")
      .bind(versionId, questionnaireId, JSON.stringify(schema), createdAt).run();
    return json({ id: questionnaireId, slug, version: 1, status: "draft" }, 201);
  }
  const questionnaireMatch = path.match(/^\/api\/owner\/questionnaires\/([0-9a-f-]+)$/i);
  if (questionnaireMatch && request.method === "GET") {
    const q = await env.DB.prepare("SELECT * FROM questionnaires WHERE id = ?").bind(questionnaireMatch[1]).first();
    if (!q) throw new HttpError(404, "Questionnaire not found");
    const v = await env.DB.prepare("SELECT id, version_number, schema_json, created_at FROM questionnaire_versions WHERE id = ?").bind(q.current_version_id).first();
    return json({ ...q, current_version: v ? { id: v.id, version: v.version_number, schema: JSON.parse(v.schema_json), created_at: v.created_at } : null });
  }
  if (questionnaireMatch && request.method === "PUT") {
    const questionnaireId = questionnaireMatch[1];
    const existing = await env.DB.prepare("SELECT * FROM questionnaires WHERE id = ?").bind(questionnaireId).first();
    if (!existing) throw new HttpError(404, "Questionnaire not found");
    const schema = validateQuestionnaire(await readJson(request));
    const latest = await env.DB.prepare("SELECT MAX(version_number) AS version FROM questionnaire_versions WHERE questionnaire_id = ?").bind(questionnaireId).first();
    const versionNumber = Number(latest?.version || 0) + 1, versionId = id(), updatedAt = nowIso();
    await env.DB.prepare("INSERT INTO questionnaire_versions (id, questionnaire_id, version_number, schema_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(versionId, questionnaireId, versionNumber, JSON.stringify(schema), updatedAt).run();
    await env.DB.prepare("UPDATE questionnaires SET title = ?, description = ?, current_version_id = ?, updated_at = ? WHERE id = ?")
      .bind(schema.title, schema.description, versionId, updatedAt, questionnaireId).run();
    return json({ id: questionnaireId, version: versionNumber, status: existing.status });
  }
  const statusMatch = path.match(/^\/api\/owner\/questionnaires\/([0-9a-f-]+)\/status$/i);
  if (statusMatch && request.method === "PATCH") {
    const body = await readJson(request);
    if (!["draft", "active", "inactive"].includes(body.status)) throw new HttpError(400, "Status must be draft, active, or inactive");
    const result = await env.DB.prepare("UPDATE questionnaires SET status = ?, updated_at = ? WHERE id = ?")
      .bind(body.status, nowIso(), statusMatch[1]).run();
    if (!result.meta?.changes) throw new HttpError(404, "Questionnaire not found");
    return json({ ok: true, status: body.status });
  }
  const submissionsMatch = path.match(/^\/api\/owner\/questionnaires\/([0-9a-f-]+)\/submissions$/i);
  if (submissionsMatch && request.method === "GET") {
    const q = await env.DB.prepare("SELECT id FROM questionnaires WHERE id = ?").bind(submissionsMatch[1]).first();
    if (!q) throw new HttpError(404, "Questionnaire not found");
    const { results = [] } = await env.DB.prepare("SELECT id, questionnaire_version_id, created_at FROM submissions WHERE questionnaire_id = ? ORDER BY created_at DESC LIMIT 1000")
      .bind(submissionsMatch[1]).all();
    return json({ submissions: results });
  }
  const submissionMatch = path.match(/^\/api\/owner\/submissions\/([0-9a-f-]+)$/i);
  if (submissionMatch && request.method === "GET") {
    const submission = await env.DB.prepare(`SELECT s.id, s.questionnaire_id, s.questionnaire_version_id, s.created_at,
      q.title AS questionnaire_title, v.version_number
      FROM submissions s JOIN questionnaires q ON q.id = s.questionnaire_id
      JOIN questionnaire_versions v ON v.id = s.questionnaire_version_id WHERE s.id = ?`)
      .bind(submissionMatch[1]).first();
    if (!submission) throw new HttpError(404, "Submission not found");
    const { results = [] } = await env.DB.prepare("SELECT question_key, question_label, answer_json FROM answers WHERE submission_id = ? ORDER BY rowid")
      .bind(submissionMatch[1]).all();
    return json({ ...submission, answers: results.map(a => ({ question_id: a.question_key, question: a.question_label, answer: JSON.parse(a.answer_json) })) });
  }
  const exportMatch = path.match(/^\/api\/owner\/questionnaires\/([0-9a-f-]+)\/export\.csv$/i);
  if (exportMatch && request.method === "GET") {
    const q = await env.DB.prepare("SELECT id, title FROM questionnaires WHERE id = ?").bind(exportMatch[1]).first();
    if (!q) throw new HttpError(404, "Questionnaire not found");
    const { results = [] } = await env.DB.prepare(`SELECT s.id AS submission_id, s.created_at, s.questionnaire_version_id,
      a.question_key, a.question_label, a.answer_json
      FROM submissions s LEFT JOIN answers a ON a.submission_id = s.id
      WHERE s.questionnaire_id = ? ORDER BY s.created_at DESC, a.rowid`).bind(q.id).all();
    const rows = [["submission_id", "submitted_at", "questionnaire_version_id", "question_id", "question", "answer"]];
    for (const r of results) rows.push([r.submission_id, r.created_at, r.questionnaire_version_id, r.question_key || "", r.question_label || "", r.answer_json ? JSON.parse(r.answer_json) : ""]);
    return new Response(toCsv(rows), { status: 200, headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="' + slugify(q.title) + '-responses.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }});
  }
  throw new HttpError(404, "Route not found");
}
export {
  QUESTION_TYPES, validateQuestionnaire, validateAnswers, conditionMatches, csvCell, toCsv,
  corsHeaders, isOriginAllowed, slugify, verifyPassword, handle
};
export default {
  async fetch(request, env) {
    try {
      return withCors(await handle(request, env), request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = status === 500 ? "Internal server error" : error.message;
      return withCors(json({ error: message }, status), request, env);
    }
  }
};
