import { jwtVerify, createRemoteJWKSet } from "jose";
import { compactAnswerDisplay, getNextInterviewCode, type Env } from "./db";
import { displayInterviewId, generateSecureToken } from "./utils/token";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  "Cache-Control": "no-store"
};

function response(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}

async function requireAccess(request: Request, env: Env): Promise<boolean> {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!domain || !aud || !token) return false;
  try {
    const issuer = domain.startsWith("https://") ? domain : `https://${domain}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    await jwtVerify(token, jwks, { issuer, audience: aud });
    return true;
  } catch {
    return false;
  }
}

async function ensureTokens(env: Env): Promise<void> {
  const qs = await env.DB.prepare("SELECT id, questionnaire_code FROM questionnaires").all<{id:number; questionnaire_code:string}>();
  for (const q of qs.results ?? []) {
    const existing = await env.DB.prepare("SELECT token FROM interview_public_tokens WHERE questionnaire_id = ?")
      .bind(q.id).first();
    if (!existing) {
      await env.DB.prepare("INSERT INTO interview_public_tokens(token, questionnaire_id, interview_code) VALUES (?, ?, ?)")
        .bind(generateSecureToken(), q.id, q.questionnaire_code).run();
    }
  }
}

function normalizedWorkType(value: unknown): "Freelancer" | "Agency" | null {
  if (value === "freelancer" || value === "Freelancer") return "Freelancer";
  if (value === "agency" || value === "Agency") return "Agency";
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (path === "/api/health" && request.method === "GET") {
        const check = await env.DB.prepare("SELECT 1 AS ok").first<{ok:number}>();
        return response({ ok: check?.ok === 1, service: "interview-12-backend" });
      }

      // Public bearer-token endpoints; no interview ID is exposed in the public payload.
      const publicMatch = path.match(/^\/api\/public\/([^/]+)(?:\/(submit))?$/);
      if (publicMatch) {
        const token = publicMatch[1];
        const link = await env.DB.prepare(
          `SELECT q.id AS qid, q.title, q.questionnaire_code, v.id AS version_id, v.version_number
           FROM interview_public_tokens t
           JOIN questionnaires q ON q.id = t.questionnaire_id
           JOIN questionnaire_versions v ON v.questionnaire_id = q.id
           WHERE t.token = ? ORDER BY v.version_number DESC LIMIT 1`
        ).bind(token).first<{qid:number;title:string;questionnaire_code:string;version_id:number;version_number:number}>();
        if (!link) return response({ error: "Invalid link" }, 404);

        if (publicMatch[2] === "submit" && request.method === "POST") {
          let body: any;
          try { body = await request.json(); } catch { return response({ error: "Invalid JSON body" }, 400); }
          const name = typeof body.respondent_name === "string" ? body.respondent_name.trim() : "";
          const email = typeof body.respondent_email === "string" ? body.respondent_email.trim() : "";
          const workType = normalizedWorkType(body.respondent_type);
          if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !workType) {
            return response({ error: "Valid name, email, and work type (freelancer or agency) are required" }, 400);
          }

          const questions = await env.DB.prepare(
            "SELECT id, question_code, is_required FROM questions WHERE questionnaire_id = ?"
          ).bind(link.qid).all<{id:number;question_code:string;is_required:number}>();
          const qByCode = new Map((questions.results ?? []).map(q => [q.question_code, q]));
          const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
          for (const q of questions.results ?? []) {
            const a = (answers as Record<string, any>)[q.question_code];
            const hasValue = a && ((Array.isArray(a.selected) && a.selected.length) || a.code || a.text_answer || a.text);
            if (q.is_required && !hasValue) return response({ error: `Required answer missing: ${q.question_code}` }, 400);
          }

          const submissionCode = crypto.randomUUID();
          const insert = await env.DB.prepare(
            `INSERT INTO submissions(submission_code, questionnaire_id, respondent_type, respondent_name, respondent_email, submitted_at, status)
             VALUES (?, ?, ?, ?, ?, ?, 'active')`
          ).bind(submissionCode, link.qid, workType, name, email, new Date().toISOString()).run();
          if (!insert.success) return response({ error: "Could not save submission" }, 500);
          const row = await env.DB.prepare("SELECT id FROM submissions WHERE submission_code = ?").bind(submissionCode).first<{id:number}>();
          if (!row) return response({ error: "Submission saved but could not be linked" }, 500);

          await env.DB.prepare("INSERT OR IGNORE INTO submission_version_map(submission_id, version_id) VALUES (?, ?)")
            .bind(row.id, link.version_id).run();

          for (const [code, raw] of Object.entries(answers as Record<string, any>)) {
            const q = qByCode.get(code);
            if (!q) continue;
            const a = raw ?? {};
            const selected = Array.isArray(a.selected) ? a.selected : Array.isArray(a.codes) ? a.codes : a.code ? [a.code] : null;
            await env.DB.prepare(
              "INSERT OR REPLACE INTO answers(submission_id, question_id, selected_options_json, other_text, text_answer) VALUES (?, ?, ?, ?, ?)"
            ).bind(row.id, q.id, selected ? JSON.stringify(selected) : null,
              typeof a.other_text === "string" ? a.other_text : null,
              typeof a.text_answer === "string" ? a.text_answer : typeof a.text === "string" ? a.text : null).run();
          }
          return response({ ok: true }, 201);
        }

        if (request.method !== "GET") return response({ error: "Method not allowed" }, 405);
        const pages = await env.DB.prepare("SELECT page_number, title FROM interview_pages WHERE questionnaire_id = ? ORDER BY page_number")
          .bind(link.qid).all();
        const questions = await env.DB.prepare(
          `SELECT q.question_code, q.question_text, q.question_type, q.is_required, q.options_json,
                  COALESCE(qm.visibility, q.branch, 'all') AS visibility, p.page_number
           FROM questions q
           LEFT JOIN question_meta qm ON qm.question_id = q.id
           LEFT JOIN interview_pages p ON p.id = qm.page_id
           WHERE q.questionnaire_id = ? ORDER BY COALESCE(p.page_number, 999), q.display_order`
        ).bind(link.qid).all<any>();
        return response({
          title: link.title,
          version: link.version_number,
          pages: pages.results ?? [],
          questions: (questions.results ?? []).map(q => ({
            code: q.question_code, text: q.question_text, type: q.question_type,
            required: Boolean(q.is_required), options: safeJson(q.options_json),
            visibility: q.visibility, page_number: q.page_number
          }))
        });
      }

      if (path.startsWith("/api/interviews")) {
        if (!(await requireAccess(request, env))) {
          return response({ error: "Unauthorized. Configure Cloudflare Access and its Worker variables." }, 401);
        }
        await ensureTokens(env);
        return await dashboard(request, env, path, url);
      }

      if (path.startsWith("/q/")) {
        const token = path.split("/")[2];
        return Response.redirect(new URL(`/api/public/${encodeURIComponent(token)}`, url), 302);
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      console.error("Request failed", error);
      return response({ error: "Internal server error" }, 500);
    }
  }
};

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function dashboard(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  if (path === "/api/interviews" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT q.id, q.questionnaire_code, q.title, q.version, q.created_at,
              COALESCE(ps.is_published, 0) AS is_published, t.token,
              (SELECT COUNT(*) FROM submissions s WHERE s.questionnaire_id=q.id) AS submission_count
       FROM questionnaires q
       LEFT JOIN publish_state ps ON ps.questionnaire_id=q.id
       LEFT JOIN interview_public_tokens t ON t.questionnaire_id=q.id
       ORDER BY q.id`
    ).all<any>();
    return response((rows.results ?? []).map(r => ({
      ID: displayInterviewId(r.questionnaire_code), title: r.title, version: r.version,
      is_published: Boolean(r.is_published), submission_count: r.submission_count,
      public_link: r.token ? `/q/${r.token}` : null
    })));
  }

  if (path === "/api/interviews" && request.method === "POST") {
    const body: any = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Untitled Interview";
    const code = await getNextInterviewCode(env.DB);
    const created = await env.DB.prepare(
      "INSERT INTO questionnaires(questionnaire_code, title, version, is_active) VALUES (?, ?, 1, 0)"
    ).bind(code, title).run();
    if (!created.success) return response({ error: "Could not create interview" }, 500);
    const q = await env.DB.prepare("SELECT id FROM questionnaires WHERE questionnaire_code=?").bind(code).first<{id:number}>();
    if (!q) return response({ error: "Could not load created interview" }, 500);
    await env.DB.prepare("INSERT INTO questionnaire_versions(questionnaire_id, version_number, title, is_published) VALUES (?, 1, ?, 0)").bind(q.id, title).run();
    await env.DB.prepare("INSERT INTO publish_state(questionnaire_id, is_published, public_link_enabled) VALUES (?, 0, 0)").bind(q.id).run();
    await env.DB.prepare("INSERT INTO interview_public_tokens(token, questionnaire_id, interview_code) VALUES (?, ?, ?)").bind(generateSecureToken(), q.id, code).run();
    for (let page = 1; page <= 4; page++) {
      await env.DB.prepare("INSERT OR IGNORE INTO interview_pages(questionnaire_id, page_number, title) VALUES (?, ?, ?)").bind(q.id, page, `Page ${page}`).run();
    }
    return response({ ok: true, ID: displayInterviewId(code) }, 201);
  }

  const match = path.match(/^\/api\/interviews\/([^/]+)(?:\/(.*))?$/);
  if (!match) return response({ error: "Not found" }, 404);
  const code = match[1];
  const sub = match[2] ?? "";
  const q = await env.DB.prepare("SELECT id, questionnaire_code, title, version FROM questionnaires WHERE questionnaire_code=?").bind(code).first<any>();
  if (!q) return response({ error: "Interview not found" }, 404);

  if (sub === "publish" && request.method === "POST") {
    await env.DB.prepare("UPDATE publish_state SET is_published=1, public_link_enabled=1, updated_at=CURRENT_TIMESTAMP WHERE questionnaire_id=?").bind(q.id).run();
    await env.DB.prepare("UPDATE questionnaires SET is_active=1 WHERE id=?").bind(q.id).run();
    return response({ ok: true, published: true });
  }
  if (sub === "unpublish" && request.method === "POST") {
    await env.DB.prepare("UPDATE publish_state SET is_published=0, public_link_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE questionnaire_id=?").bind(q.id).run();
    await env.DB.prepare("UPDATE questionnaires SET is_active=0 WHERE id=?").bind(q.id).run();
    return response({ ok: true, published: false, note: "Previously distributed links remain usable by design." });
  }

  if (sub === "duplicate" && request.method === "POST") {
    const next = await getNextInterviewCode(env.DB);
    const title = `Copy of ${q.title}`;
    await env.DB.prepare("INSERT INTO questionnaires(questionnaire_code, title, version, is_active) VALUES (?, ?, 1, 0)").bind(next, title).run();
    const copy = await env.DB.prepare("SELECT id FROM questionnaires WHERE questionnaire_code=?").bind(next).first<{id:number}>();
    if (!copy) return response({ error: "Could not create copy" }, 500);
    await env.DB.prepare("INSERT INTO questionnaire_versions(questionnaire_id, version_number, title, is_published) VALUES (?, 1, ?, 0)").bind(copy.id, title).run();
    await env.DB.prepare("INSERT INTO publish_state(questionnaire_id, is_published, public_link_enabled) VALUES (?, 0, 0)").bind(copy.id).run();
    await env.DB.prepare("INSERT INTO interview_public_tokens(token, questionnaire_id, interview_code) VALUES (?, ?, ?)").bind(generateSecureToken(), copy.id, next).run();
    const oldPages = await env.DB.prepare("SELECT page_number, title FROM interview_pages WHERE questionnaire_id=?").bind(q.id).all<any>();
    const pageMap = new Map<number, number>();
    for (const p of oldPages.results ?? []) {
      await env.DB.prepare("INSERT INTO interview_pages(questionnaire_id, page_number, title) VALUES (?, ?, ?)").bind(copy.id, p.page_number, p.title).run();
      const np = await env.DB.prepare("SELECT id FROM interview_pages WHERE questionnaire_id=? AND page_number=?").bind(copy.id, p.page_number).first<{id:number}>();
      if (np) pageMap.set(p.page_number, np.id);
    }
    const oldQs = await env.DB.prepare("SELECT * FROM questions WHERE questionnaire_id=? ORDER BY display_order").bind(q.id).all<any>();
    for (const old of oldQs.results ?? []) {
      await env.DB.prepare("INSERT INTO questions(questionnaire_id, question_code, question_text, question_type, branch, display_order, is_required, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(copy.id, old.question_code, old.question_text, old.question_type, old.branch, old.display_order, old.is_required, old.options_json).run();
    }
    return response({ ok: true, ID: displayInterviewId(next) }, 201);
  }

  if (sub === "submissions" && request.method === "GET") {
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
    const rows = await env.DB.prepare(
      `SELECT id, submission_code, respondent_name AS name, respondent_email AS email,
              LOWER(respondent_type) AS work_type, submitted_at
       FROM submissions WHERE questionnaire_id=?
       AND (?='' OR LOWER(respondent_name) LIKE ? OR LOWER(respondent_email) LIKE ?)
       ORDER BY submitted_at DESC LIMIT ?`
    ).bind(q.id, search, `%${search}%`, `%${search}%`, limit).all<any>();
    const output = [];
    for (const r of rows.results ?? []) {
      const answers = await env.DB.prepare(
        "SELECT q.question_code, a.selected_options_json, a.other_text, a.text_answer FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=? ORDER BY q.display_order"
      ).bind(r.id).all<any>();
      const compact: Record<string, string> = {};
      for (const a of answers.results ?? []) compact[a.question_code] = compactAnswerDisplay(a);
      output.push({ ...r, ID: displayInterviewId(q.questionnaire_code), answers: compact });
    }
    return response(output);
  }

  if (sub === "export" && request.method === "GET") {
    const format = url.searchParams.get("format") ?? "json";
    if (!["json", "csv", "txt"].includes(format)) return response({ error: "format must be json, csv, or txt" }, 400);
    const submissions = await env.DB.prepare("SELECT * FROM submissions WHERE questionnaire_id=? ORDER BY submitted_at").bind(q.id).all<any>();
    const questions = await env.DB.prepare("SELECT question_code FROM questions WHERE questionnaire_id=? ORDER BY display_order").bind(q.id).all<any>();
    const qCodes = (questions.results ?? []).map((x:any) => x.question_code);
    const data = [];
    for (const s of submissions.results ?? []) {
      const ans = await env.DB.prepare("SELECT q.question_code, a.selected_options_json, a.other_text, a.text_answer FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=?").bind(s.id).all<any>();
      const map: Record<string,string> = {};
      for (const a of ans.results ?? []) map[a.question_code] = compactAnswerDisplay(a);
      data.push({ ID: displayInterviewId(q.questionnaire_code), name: s.respondent_name, email: s.respondent_email, work_type: String(s.respondent_type).toLowerCase(), ...Object.fromEntries(qCodes.map((c:string) => [c, map[c] ?? ""])), submitted_at: s.submitted_at });
    }
    if (format === "json") return response(data, 200, { "Content-Disposition": `attachment; filename="${displayInterviewId(q.questionnaire_code)}-export.json"` });
    if (format === "csv") {
      const cols = ["ID", "name", "email", "work_type", ...qCodes, "submitted_at"];
      const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.map(cell).join(","), ...data.map(row => cols.map(c => cell((row as any)[c])).join(","))].join("\r\n");
      return new Response(csv, { headers: { ...cors, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${displayInterviewId(q.questionnaire_code)}-export.csv"` } });
    }
    const txt = data.map((row:any) => Object.entries(row).map(([k,v]) => `${k}: ${v}`).join("\n")).join("\n\n");
    return new Response(txt, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
  }

  return response({ error: "Route not implemented" }, 404);
}
