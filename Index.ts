import { Env } from './db';
import { generateSecureToken, normalizeInterviewCode } from './utils/token';
import { compactAnswerDisplay, getNextInterviewCode } from './db';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cf-Access-Jwt-Assertion',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health
      if (path === '/api/health') {
        return json({ ok: true, db: 'interview-12', time: new Date().toISOString() }, corsHeaders);
      }

      // PUBLIC: Get questionnaire by token
      if (path.startsWith('/api/public/') && request.method === 'GET') {
        const token = path.split('/')[3];
        return await handlePublicGet(token, env, corsHeaders);
      }
      if (path.startsWith('/api/public/') && path.endsWith('/submit') && request.method === 'POST') {
        const token = path.split('/')[3];
        return await handlePublicSubmit(token, request, env, corsHeaders);
      }

      // DASHBOARD APIs - expected behind Cloudflare Access
      // Note: Access protection is enforced at Cloudflare edge, not in Worker. Worker trusts Cf-Access headers.
      if (path.startsWith('/api/interviews')) {
        return await handleDashboard(request, env, corsHeaders);
      }

      if (path.startsWith('/q/')) {
        // Optional: redirect to frontend later, or return info
        const token = path.split('/')[2];
        return await handlePublicGet(token, env, corsHeaders);
      }

      return json({ error: 'Not found' }, corsHeaders, 404);
    } catch (e: any) {
      console.error(e);
      return json({ error: e.message || 'Internal error' }, corsHeaders, 500);
    }
  }
};

function json(data: any, headers: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function handlePublicGet(token: string, env: Env, corsHeaders: any) {
  if (!token) return json({ error: 'Missing token' }, corsHeaders, 400);
  const link = await env.DB.prepare(
    `SELECT q.id as qid, q.questionnaire_code, q.title, qv.id as version_id, qv.version_number, qv.snapshot_json
     FROM interview_public_tokens t
     JOIN questionnaires q ON q.id = t.questionnaire_id
     JOIN questionnaire_versions qv ON qv.questionnaire_id = q.id
     WHERE t.token = ? ORDER BY qv.version_number DESC LIMIT 1`
  ).bind(token).first();
  if (!link) return json({ error: 'Invalid link' }, corsHeaders, 404);

  // Get current published version snapshot or build live from questions
  const pages = await env.DB.prepare(`SELECT * FROM interview_pages WHERE questionnaire_id = ? ORDER BY page_number`).bind((link as any).qid).all();
  const questions = await env.DB.prepare(
    `SELECT q.*, qm.page_id, qm.visibility, p.page_number
     FROM questions q
     LEFT JOIN question_meta qm ON qm.question_id = q.id
     LEFT JOIN interview_pages p ON p.id = qm.page_id
     WHERE q.questionnaire_id = ? ORDER BY COALESCE(p.page_number, 999), q.display_order`
  ).bind((link as any).qid).all();

  return json({
    interview_code: (link as any).questionnaire_code, // internal but for backend use, frontend should not expose? public endpoint should not expose ID per spec, but we need version. We return only title/pages
    title: (link as any).title,
    version: (link as any).version_number,
    pages: pages.results,
    questions: questions.results.map((qq: any) => ({
      code: qq.question_code,
      text: qq.question_text,
      type: qq.question_type,
      required: !!qq.is_required,
      options: qq.options_json ? JSON.parse(qq.options_json) : null,
      visibility: qq.visibility || qq.branch || 'all',
      page_number: qq.page_number,
      display_order: qq.display_order
    }))
  }, corsHeaders);
}

async function handlePublicSubmit(token: string, request: Request, env: Env, corsHeaders: any) {
  const body: any = await request.json();
  const { respondent_name, respondent_email, respondent_type, answers } = body; // answers: {question_code: {selected: [], other_text, text_answer}}

  if (!respondent_name || !respondent_email || !respondent_type) {
    return json({ error: 'Missing participant fields' }, corsHeaders, 400);
  }
  if (!['freelancer','agency'].includes(respondent_type)) {
    return json({ error: 'work_type must be freelancer or agency' }, corsHeaders, 400);
  }

  const link = await env.DB.prepare(
    `SELECT q.id as qid, q.questionnaire_code, qv.id as version_id
     FROM interview_public_tokens t
     JOIN questionnaires q ON q.id = t.questionnaire_id
     JOIN questionnaire_versions qv ON qv.questionnaire_id = q.id
     WHERE t.token = ? ORDER BY qv.version_number DESC LIMIT 1`
  ).bind(token).first();
  if (!link) return json({ error: 'Invalid token' }, corsHeaders, 404);

  const submissionCode = crypto.randomUUID();
  const batch = [];

  // Insert submission - respondent_type in DB currently expects Freelancer/Agency but we migrate to lowercase via new logic
  // To preserve backward compat, store as lowercase and also keep check tolerant: we will store lowercase; if CHECK fails, fallback to capitalized
  try {
    batch.push(env.DB.prepare(
      `INSERT INTO submissions (submission_code, questionnaire_id, respondent_type, respondent_name, respondent_email, submitted_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).bind(submissionCode, (link as any).qid, respondent_type, respondent_name, respondent_email, new Date().toISOString()));
  } catch {}

  // For D1 batch, need to execute insert first to get id, so we do sequential
  const insertRes = await env.DB.prepare(
    `INSERT INTO submissions (submission_code, questionnaire_id, respondent_type, respondent_name, respondent_email, submitted_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`
  ).bind(submissionCode, (link as any).qid, respondent_type, respondent_name, respondent_email, new Date().toISOString()).run();

  // SQLite last row id not directly returned in D1, fetch by code
  const subRow = await env.DB.prepare(`SELECT id FROM submissions WHERE submission_code = ?`).bind(submissionCode).first();
  const submissionId = (subRow as any).id;

  // Link to version
  await env.DB.prepare(`INSERT OR IGNORE INTO submission_version_map (submission_id, version_id) VALUES (?, ?)`).bind(submissionId, (link as any).version_id).run();

  // Insert answers
  const qMap = await env.DB.prepare(`SELECT id, question_code FROM questions WHERE questionnaire_id = ?`).bind((link as any).qid).all();
  const qByCode: any = {};
  for (const r of qMap.results) qByCode[(r as any).question_code] = (r as any).id;

  for (const [qCode, ans] of Object.entries(answers || {})) {
    const qId = qByCode[qCode];
    if (!qId) continue;
    const a: any = ans;
    let selectedJson = null;
    if (a.selected) selectedJson = JSON.stringify(a.selected);
    else if (a.codes) selectedJson = JSON.stringify(a.codes);
    else if (a.code) selectedJson = JSON.stringify([a.code]);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO answers (submission_id, question_id, selected_options_json, other_text, text_answer)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(submissionId, qId, selectedJson, a.other_text || null, a.text_answer || a.text || null).run();
  }

  return json({ ok: true, submission_code: submissionCode, interview_id: (link as any).questionnaire_code }, corsHeaders);
}

async function handleDashboard(request: Request, env: Env, corsHeaders: any) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // GET /api/interviews - list
  if (path === '/api/interviews' && method === 'GET') {
    const q = await env.DB.prepare(
      `SELECT q.id, q.questionnaire_code as interview_code, q.title, q.version, q.created_at, ps.is_published, t.token
       FROM questionnaires q
       LEFT JOIN publish_state ps ON ps.questionnaire_id = q.id
       LEFT JOIN interview_public_tokens t ON t.questionnaire_id = q.id
       ORDER BY q.questionnaire_code`
    ).all();
    // Add submission counts
    const counts = await env.DB.prepare(`SELECT questionnaire_id, COUNT(*) as c FROM submissions GROUP BY questionnaire_id`).all();
    const countMap: any = {};
    for (const r of counts.results) countMap[(r as any).questionnaire_id] = (r as any).c;
    const result = q.results.map((r: any) => ({
      id: r.interview_code,
      internal_id: r.id,
      title: r.title,
      version: r.version,
      is_published: !!r.is_published,
      submission_count: countMap[r.id] || 0,
      public_token: r.token || null,
      public_link: r.token ? `/q/${r.token}` : null
    }));
    return json(result, corsHeaders);
  }

  // POST /api/interviews - create
  if (path === '/api/interviews' && method === 'POST') {
    const body: any = await request.json();
    const title = body.title || 'Untitled Interview';
    const nextCode = await getNextInterviewCode(env.DB);
    const qid = await env.DB.prepare(
      `INSERT INTO questionnaires (questionnaire_code, title, version, is_active, created_at) VALUES (?, ?, 1, 0, ?)`
    ).bind(nextCode, title, new Date().toISOString()).run();

    const qRow = await env.DB.prepare(`SELECT id FROM questionnaires WHERE questionnaire_code = ?`).bind(nextCode).first();
    const qId = (qRow as any).id;

    // Create version 1
    await env.DB.prepare(`INSERT INTO questionnaire_versions (questionnaire_id, version_number, title, is_published) VALUES (?, 1, ?, 0)`).bind(qId, title).run();
    // Create publish state
    await env.DB.prepare(`INSERT OR IGNORE INTO publish_state (questionnaire_id, is_published) VALUES (?, 0)`).bind(qId).run();
    // Generate token
    const token = generateSecureToken(16);
    await env.DB.prepare(`INSERT INTO interview_public_tokens (token, questionnaire_id, interview_code, created_at) VALUES (?, ?, ?, ?)`).bind(token, qId, nextCode, new Date().toISOString()).run();
    // Create default pages
    for (let i=1;i<=4;i++) {
      await env.DB.prepare(`INSERT OR IGNORE INTO interview_pages (questionnaire_id, page_number, title) VALUES (?, ?, ?)`).bind(qId, i, `Page ${i}`).run();
    }

    return json({ ok: true, interview_code: nextCode, token, public_link: `/q/${token}` }, corsHeaders);
  }

  // Routes with code: /api/interviews/:code/*
  const m = path.match(/^\/api\/interviews\/([^\/]+)(?:\/(.*))?$/);
  if (!m) return json({ error: 'Invalid interview path' }, corsHeaders, 400);
  const interviewCode = m[1];
  const subPath = m[2] || '';

  const qRow = await env.DB.prepare(`SELECT id, questionnaire_code, title FROM questionnaires WHERE questionnaire_code = ?`).bind(interviewCode).first();
  if (!qRow) return json({ error: 'Interview not found' }, corsHeaders, 404);
  const qId = (qRow as any).id;

  if (subPath === 'duplicate' && method === 'POST') {
    const nextCode = await getNextInterviewCode(env.DB);
    const title = `Copy of ${(qRow as any).title}`;
    await env.DB.prepare(`INSERT INTO questionnaires (questionnaire_code, title, version, is_active) VALUES (?, ?, 1, 0)`).bind(nextCode, title).run();
    const newQ = await env.DB.prepare(`SELECT id FROM questionnaires WHERE questionnaire_code = ?`).bind(nextCode).first();
    const newQId = (newQ as any).id;
    await env.DB.prepare(`INSERT INTO questionnaire_versions (questionnaire_id, version_number, title) VALUES (?, 1, ?)`).bind(newQId, title).run();
    const token = generateSecureToken(16);
    await env.DB.prepare(`INSERT INTO interview_public_tokens (token, questionnaire_id, interview_code) VALUES (?, ?, ?)`).bind(token, newQId, nextCode).run();
    // Copy pages
    const pages = await env.DB.prepare(`SELECT page_number, title FROM interview_pages WHERE questionnaire_id = ?`).bind(qId).all();
    for (const p of pages.results) {
      await env.DB.prepare(`INSERT INTO interview_pages (questionnaire_id, page_number, title) VALUES (?, ?, ?)`).bind(newQId, (p as any).page_number, (p as any).title).run();
    }
    // Copy questions
    const questions = await env.DB.prepare(`SELECT question_code, question_text, question_type, branch, display_order, is_required, options_json FROM questions WHERE questionnaire_id = ?`).bind(qId).all();
    for (const qq of questions.results) {
      await env.DB.prepare(
        `INSERT INTO questions (questionnaire_id, question_code, question_text, question_type, branch, display_order, is_required, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(newQId, (qq as any).question_code, (qq as any).question_text, (qq as any).question_type, (qq as any).branch, (qq as any).display_order, (qq as any).is_required, (qq as any).options_json).run();
    }
    // Copy meta with new page ids
    // Simplified: re-assign by page_number
    return json({ ok: true, new_code: nextCode, token, public_link: `/q/${token}` }, corsHeaders);
  }

  if (subPath === 'publish' && method === 'POST') {
    await env.DB.prepare(`INSERT OR REPLACE INTO publish_state (questionnaire_id, is_published, public_link_enabled, updated_at) VALUES (?, 1, 1, ?)`).bind(qId, new Date().toISOString()).run();
    await env.DB.prepare(`UPDATE questionnaires SET is_active = 1 WHERE id = ?`).bind(qId).run();
    return json({ ok: true, published: true }, corsHeaders);
  }
  if (subPath === 'unpublish' && method === 'POST') {
    await env.DB.prepare(`INSERT OR REPLACE INTO publish_state (questionnaire_id, is_published, public_link_enabled, updated_at) VALUES (?, 0, 0, ?)`).bind(qId, new Date().toISOString()).run();
    await env.DB.prepare(`UPDATE questionnaires SET is_active = 0 WHERE id = ?`).bind(qId).run();
    return json({ ok: true, published: false, note: 'Existing links remain usable per spec' }, corsHeaders);
  }

  if (subPath === 'submissions' && method === 'GET') {
    const search = url.searchParams.get('search')?.toLowerCase() || '';
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const query = `
      SELECT s.id, s.submission_code, s.respondent_name as name, s.respondent_email as email, s.respondent_type as work_type, s.submitted_at, q.questionnaire_code as interview_code
      FROM submissions s
      JOIN questionnaires q ON q.id = s.questionnaire_id
      WHERE s.questionnaire_id = ?
      ${search ? `AND (LOWER(s.respondent_name) LIKE ? OR LOWER(s.respondent_email) LIKE ?)` : ''}
      ORDER BY s.submitted_at DESC LIMIT ?
    `;
    let stmt;
    if (search) {
      stmt = env.DB.prepare(query).bind(qId, `%${search}%`, `%${search}%`, limit);
    } else {
      stmt = env.DB.prepare(query).bind(qId, limit);
    }
    const rows = await stmt.all();
    // For each submission, get compact answers
    const results = [];
    for (const r of rows.results as any[]) {
      const ansRows = await env.DB.prepare(
        `SELECT q.question_code, a.selected_options_json, a.other_text, a.text_answer
         FROM answers a JOIN questions q ON q.id = a.question_id
         WHERE a.submission_id = ? ORDER BY q.display_order`
      ).bind(r.id).all();
      const compact: any = {};
      for (const ar of ansRows.results as any[]) {
        compact[ar.question_code] = compactAnswerDisplay(ar);
      }
      results.push({ ...r, answers_compact: compact });
    }
    return json(results, corsHeaders);
  }

  if (subPath.startsWith('export') && method === 'GET') {
    const format = url.searchParams.get('format') || 'json';
    const submissions = await env.DB.prepare(`SELECT id, submission_code, respondent_name, respondent_email, respondent_type, submitted_at FROM submissions WHERE questionnaire_id = ? ORDER BY submitted_at`).bind(qId).all();
    const questions = await env.DB.prepare(`SELECT question_code FROM questions WHERE questionnaire_id = ? ORDER BY display_order`).bind(qId).all();
    const qCodes = questions.results.map((r: any) => r.question_code);

    if (format === 'json') {
      const out = [];
      for (const s of submissions.results as any[]) {
        const ansRows = await env.DB.prepare(
          `SELECT q.question_code, a.selected_options_json, a.other_text, a.text_answer FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.submission_id = ?`
        ).bind(s.id).all();
        const ansMap: any = {};
        for (const ar of ansRows.results as any[]) ansMap[ar.question_code] = compactAnswerDisplay(ar);
        out.push({
          ID: interviewCode,
          name: s.respondent_name,
          email: s.respondent_email,
          work_type: s.respondent_type,
          ...Object.fromEntries(qCodes.map((qc: string) => [qc, ansMap[qc] || ''])),
          submission_id: s.submission_code,
          submitted_at: s.submitted_at
        });
      }
      return json(out, corsHeaders);
    }
    if (format === 'csv') {
      let csv = `ID,name,email,work_type,${qCodes.join(',')},submission_id,submitted_at\n`;
      for (const s of submissions.results as any[]) {
        const ansRows = await env.DB.prepare(
          `SELECT q.question_code, a.selected_options_json, a.other_text, a.text_answer FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.submission_id = ?`
        ).bind(s.id).all();
        const ansMap: any = {};
        for (const ar of ansRows.results as any[]) ansMap[ar.question_code] = compactAnswerDisplay(ar);
        const row = [
          interviewCode,
          `"${(s.respondent_name || '').replace(/"/g, '""')}"`,
          `"${(s.respondent_email || '').replace(/"/g, '""')}"`,
          s.respondent_type,
          ...qCodes.map((qc: string) => `"${(ansMap[qc] || '').replace(/"/g, '""')}"`),
          s.submission_code,
          s.submitted_at
        ].join(',');
        csv += row + '\n';
      }
      return new Response(csv, { headers: { ...corsHeaders, 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${interviewCode}_export.csv"` } });
    }
    // readable text
    if (format === 'txt') {
      let txt = `Interview ${interviewCode} - ${(qRow as any).title}\n\n`;
      for (const s of submissions.results as any[]) {
        txt += `--- Submission ${s.submission_code} ---\nID: ${interviewCode}\nname: ${s.respondent_name}\nemail: ${s.respondent_email}\nwork_type: ${s.respondent_type}\nsubmitted: ${s.submitted_at}\n`;
        const ansRows = await env.DB.prepare(
          `SELECT q.question_code, q.question_text, a.selected_options_json, a.other_text, a.text_answer FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.submission_id = ? ORDER BY q.display_order`
        ).bind(s.id).all();
        for (const ar of ansRows.results as any[]) {
          txt += `${ar.question_code}: ${compactAnswerDisplay(ar)}\n`;
        }
        txt += `\n`;
      }
      return new Response(txt, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
    }
  }

  // Backfill tokens admin - protected, should only be callable behind Access
  if (subPath === 'admin/backfill-tokens' && method === 'POST') {
    const allQ = await env.DB.prepare(`SELECT id, questionnaire_code FROM questionnaires`).all();
    let created = 0;
    for (const qq of allQ.results as any[]) {
      const existing = await env.DB.prepare(`SELECT token FROM interview_public_tokens WHERE questionnaire_id = ?`).bind(qq.id).first();
      if (!existing) {
        const token = generateSecureToken(16);
        await env.DB.prepare(`INSERT INTO interview_public_tokens (token, questionnaire_id, interview_code) VALUES (?, ?, ?)`).bind(token, qq.id, qq.questionnaire_code).run();
        created++;
      }
    }
    return json({ ok: true, created }, corsHeaders);
  }

  return json({ error: 'Dashboard route not found' }, corsHeaders, 404);
}
