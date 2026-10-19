import { jwtVerify, createRemoteJWKSet } from "jose";
import { compactAnswerDisplay, getNextInterviewCode, type Env } from "./db";
import { displayInterviewId, generateSecureToken } from "./utils/token";

type QRow = {
  id: number; question_code: string; question_text: string; question_type: string;
  branch: string; display_order: number; is_required: number; options_json: string | null;
  page_number?: number; visibility?: string;
};
type InterviewRow = { id:number; questionnaire_code:string; title:string; version:number; is_active:number };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  "Cache-Control": "no-store"
};

function response(data: unknown, status = 200, extra: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type":"application/json; charset=utf-8", ...extra } });
}
function safeJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function normalizeWorkType(value: unknown): "Freelancer" | "Agency" | null {
  if (value === "freelancer" || value === "Freelancer") return "Freelancer";
  if (value === "agency" || value === "Agency") return "Agency";
  return null;
}
function validateQuestion(q: any, i: number): string | null {
  if (!q || typeof q !== "object") return `Question ${i+1} must be an object`;
  if (typeof q.code !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(q.code)) return `Question ${i+1} needs a valid code`;
  if (typeof q.text !== "string" || q.text.trim().length > 5000) return `Question ${q.code} needs text (maximum 5000 characters)`;
  const types = ["short_text","long_text","single_choice","multiple_choice","yes_no","dropdown","checkbox","number","date","email","instruction","section_heading"];
  if (!types.includes(q.type)) return `Question ${q.code} has an unsupported type`;
  if (q.options !== undefined && q.options !== null && !Array.isArray(q.options)) return `Options for ${q.code} must be an array`;
  if (q.options && q.options.some((x:any) => typeof x !== "object" || typeof x.code !== "string" || typeof x.label !== "string")) return `Options for ${q.code} need code and label strings`;
  if (q.visibility !== undefined && !["all","freelancer","agency"].includes(q.visibility)) return `Question ${q.code} has invalid visibility`;
  if (q.page_number !== undefined && (!Number.isInteger(q.page_number) || q.page_number < 1 || q.page_number > 50)) return `Question ${q.code} has invalid page number`;
  return null;
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
  } catch { return false; }
}
async function ensureTokens(env: Env): Promise<void> {
  const qs = await env.DB.prepare("SELECT id, questionnaire_code FROM questionnaires").all<{id:number;questionnaire_code:string}>();
  for (const q of qs.results ?? []) {
    const existing = await env.DB.prepare("SELECT token FROM interview_public_tokens WHERE questionnaire_id=?").bind(q.id).first();
    if (!existing) await env.DB.prepare("INSERT INTO interview_public_tokens(token, questionnaire_id, interview_code) VALUES (?, ?, ?)")
      .bind(generateSecureToken(), q.id, q.questionnaire_code).run();
  }
}
async function resolveInterview(env: Env, requested: string): Promise<InterviewRow | null> {
  const rows = await env.DB.prepare("SELECT id, questionnaire_code, title, version, is_active FROM questionnaires").all<InterviewRow>();
  return (rows.results ?? []).find(q => q.questionnaire_code === requested || displayInterviewId(q.questionnaire_code) === requested) ?? null;
}
async function getVersionQuestions(env: Env, versionId: number): Promise<any[]> {
  const rows = await env.DB.prepare(
    "SELECT id, question_code AS code, question_text AS text, question_type AS type, branch, display_order, is_required, options_json, page_number FROM version_questions WHERE version_id=? ORDER BY page_number, display_order"
  ).bind(versionId).all<any>();
  return (rows.results ?? []).map(q => ({...q, options:safeJson(q.options_json), required:Boolean(q.is_required)}));
}
async function createSnapshot(env: Env, questionnaireId: number, versionId: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT q.id, q.question_code, q.question_text, q.question_type, q.branch, q.display_order, q.is_required, q.options_json,
            COALESCE(p.page_number, 1) AS page_number, COALESCE(qm.visibility, q.branch, 'all') AS visibility
     FROM questions q
     LEFT JOIN question_state qs ON qs.question_id=q.id
     LEFT JOIN question_meta qm ON qm.question_id=q.id
     LEFT JOIN interview_pages p ON p.id=qm.page_id
     WHERE q.questionnaire_id=? AND COALESCE(qs.is_active,1)=1
     ORDER BY COALESCE(p.page_number,1), q.display_order`
  ).bind(questionnaireId).all<QRow>();
  for (const q of rows.results ?? []) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO version_questions(version_id, question_code, question_text, question_type, branch, display_order, is_required, options_json, page_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(versionId,q.question_code,q.question_text,q.question_type,q.branch,q.display_order,q.is_required,q.options_json,q.page_number ?? 1).run();
  }
}
async function getCurrentVersion(env: Env, questionnaireId: number): Promise<{id:number;version_number:number;title:string}|null> {
  return env.DB.prepare("SELECT id, version_number, title FROM questionnaire_versions WHERE questionnaire_id=? ORDER BY version_number DESC LIMIT 1")
    .bind(questionnaireId).first<{id:number;version_number:number;title:string}>();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, {headers:cors});
    try {
      if (path === "/api/health" && request.method === "GET") {
        const result = await env.DB.prepare("SELECT 1 AS ok").first<{ok:number}>();
        return response({ok:result?.ok===1,service:"interview-12-backend"});
      }

      const publicMatch = path.match(/^\/api\/public\/([^/]+)(?:\/(submit))?$/);
      if (publicMatch) {
        const token = publicMatch[1];
        const link = await env.DB.prepare(
          `SELECT q.id AS qid, q.title, v.id AS version_id, v.version_number
           FROM interview_public_tokens t
           JOIN questionnaires q ON q.id=t.questionnaire_id
           JOIN questionnaire_versions v ON v.questionnaire_id=q.id AND v.is_published=1
           WHERE t.token=? ORDER BY v.version_number DESC LIMIT 1`
        ).bind(token).first<{qid:number;title:string;version_id:number;version_number:number}>();
        if (!link) return response({error:"This link is invalid or has not been published"},404);

        if (publicMatch[2] === "submit" && request.method === "POST") {
          let body:any;
          try { body=await request.json(); } catch { return response({error:"Invalid JSON body"},400); }
          const name = typeof body.respondent_name==="string" ? body.respondent_name.trim().slice(0,200) : "";
          const email = typeof body.respondent_email==="string" ? body.respondent_email.trim().slice(0,320) : "";
          const workType = normalizeWorkType(body.respondent_type);
          if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !workType)
            return response({error:"Valid name, email, and work type (freelancer or agency) are required"},400);

          const qs = await env.DB.prepare("SELECT id, question_code, question_type, is_required FROM version_questions WHERE version_id=? ORDER BY display_order")
            .bind(link.version_id).all<any>();
          const qByCode = new Map((qs.results ?? []).map(q=>[q.question_code,q]));
          const answers = body.answers && typeof body.answers==="object" && !Array.isArray(body.answers) ? body.answers : {};
          for (const q of qs.results ?? []) {
            const a=(answers as Record<string,any>)[q.question_code];
            const val=a?.text_answer ?? a?.text ?? a?.selected ?? a?.codes ?? a?.code;
            const filled=Array.isArray(val) ? val.length>0 : val!==undefined && val!==null && String(val).trim()!=="";
            if (q.is_required && q.question_type!=="instruction" && q.question_type!=="section_heading" && !filled)
              return response({error:`Required answer missing: ${q.question_code}`},400);
          }
          const submissionCode=crypto.randomUUID();
          const insert=await env.DB.prepare(
            "INSERT INTO submissions(submission_code, questionnaire_id, respondent_type, respondent_name, respondent_email, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
          ).bind(submissionCode,link.qid,workType,name,email,new Date().toISOString()).run();
          if (!insert.success) return response({error:"Could not save submission"},500);
          const sub=await env.DB.prepare("SELECT id FROM submissions WHERE submission_code=?").bind(submissionCode).first<{id:number}>();
          if (!sub) return response({error:"Submission was saved but could not be linked"},500);
          await env.DB.prepare("INSERT OR IGNORE INTO submission_version_map(submission_id, version_id) VALUES (?,?)").bind(sub.id,link.version_id).run();

          for (const [code,raw] of Object.entries(answers as Record<string,any>)) {
            const q=qByCode.get(code);
            if (!q) continue;
            const a=raw ?? {};
            const selected=Array.isArray(a.selected)?a.selected:Array.isArray(a.codes)?a.codes:a.code?[a.code]:null;
            const textAnswer=typeof a.text_answer==="string"?a.text_answer:typeof a.text==="string"?a.text:null;
            const other=typeof a.other_text==="string"?a.other_text:null;
            await env.DB.prepare(
              "INSERT OR REPLACE INTO versioned_answers(submission_id, version_question_id, selected_options_json, other_text, text_answer) VALUES (?, ?, ?, ?, ?)"
            ).bind(sub.id,q.id,selected?JSON.stringify(selected):null,other,textAnswer).run();
          }
          return response({ok:true,submission_code:submissionCode},201);
        }

        if (request.method!=="GET") return response({error:"Method not allowed"},405);
        const questions=await getVersionQuestions(env,link.version_id);
        const pages=await env.DB.prepare("SELECT page_number,title FROM interview_pages WHERE questionnaire_id=? ORDER BY page_number")
          .bind(link.qid).all<{page_number:number;title:string}>();
        return response({title:link.title,version:link.version_number,pages:pages.results??[],questions:questions.map(q=>({
          code:q.code,text:q.text,type:q.type,required:q.required,options:q.options,visibility:q.branch,page_number:q.page_number
        }))});
      }

      if (path.startsWith("/api/interviews")) {
        if (!(await requireAccess(request,env))) return response({error:"Unauthorized"},401);
        await ensureTokens(env);
        return dashboard(request,env,path,url);
      }
      if (path.startsWith("/q/")) {
        const token=path.split("/")[2];
        return Response.redirect(new URL(`/api/public/${encodeURIComponent(token)}`,url),302);
      }
      return response({error:"Not found"},404);
    } catch (err) {
      console.error("Request failed",err);
      return response({error:"Internal server error"},500);
    }
  }
};

async function dashboard(request:Request,env:Env,path:string,url:URL):Promise<Response> {
  if (path==="/api/interviews" && request.method==="GET") {
    const rows=await env.DB.prepare(
      `SELECT q.id,q.questionnaire_code,q.title,q.version,COALESCE(ps.is_published,0) AS is_published,t.token,
       (SELECT COUNT(*) FROM submissions s WHERE s.questionnaire_id=q.id) AS submission_count,
       (SELECT MAX(s.submitted_at) FROM submissions s WHERE s.questionnaire_id=q.id) AS latest_submission
       FROM questionnaires q LEFT JOIN publish_state ps ON ps.questionnaire_id=q.id
       LEFT JOIN interview_public_tokens t ON t.questionnaire_id=q.id ORDER BY q.id`
    ).all<any>();
    return response((rows.results??[]).map(r=>({ID:displayInterviewId(r.questionnaire_code),title:r.title,version:r.version,
      is_published:Boolean(r.is_published),submission_count:r.submission_count,latest_submission:r.latest_submission,
      public_link:r.token&&r.is_published? `/q/${r.token}`:null})));
  }
  if (path==="/api/interviews" && request.method==="POST") {
    const body:any=await request.json().catch(()=>({}));
    const title=typeof body.title==="string"&&body.title.trim()?body.title.trim().slice(0,200):"Untitled Interview";
    const code=await getNextInterviewCode(env.DB);
    const result=await env.DB.prepare("INSERT INTO questionnaires(questionnaire_code,title,version,is_active) VALUES (?, ?, 1, 0)").bind(code,title).run();
    if (!result.success) return response({error:"Could not create interview"},500);
    const q=await env.DB.prepare("SELECT id FROM questionnaires WHERE questionnaire_code=?").bind(code).first<{id:number}>();
    if (!q) return response({error:"Could not load interview"},500);
    const version=await env.DB.prepare("INSERT INTO questionnaire_versions(questionnaire_id,version_number,title,is_published) VALUES (?,1,?,0)").bind(q.id,title).run();
    if (!version.success) return response({error:"Could not initialize interview version"},500);
    await env.DB.prepare("INSERT INTO publish_state(questionnaire_id,is_published,public_link_enabled) VALUES (?,0,0)").bind(q.id).run();
    await env.DB.prepare("INSERT INTO interview_public_tokens(token,questionnaire_id,interview_code) VALUES (?,?,?)").bind(generateSecureToken(24),q.id,code).run();
    for (let n=1;n<=4;n++) await env.DB.prepare("INSERT OR IGNORE INTO interview_pages(questionnaire_id,page_number,title) VALUES (?,?,?)").bind(q.id,n,`Page ${n}`).run();
    return response({ok:true,ID:displayInterviewId(code)},201);
  }

  const match=path.match(/^\/api\/interviews\/([^/]+)(?:\/(.*))?$/);
  if (!match) return response({error:"Not found"},404);
  const code=match[1], sub=match[2]??"";
  const q=await resolveInterview(env,code);
  if (!q) return response({error:"Interview not found"},404);

  if (sub==="publish"&&request.method==="POST") {
    const current=await getCurrentVersion(env,q.id);
    if (!current) return response({error:"No questionnaire version exists"},409);
    const snapshotCount=await env.DB.prepare("SELECT COUNT(*) AS n FROM version_questions WHERE version_id=?").bind(current.id).first<{n:number}>();
    if (!snapshotCount || snapshotCount.n===0) await createSnapshot(env,q.id,current.id);
    await env.DB.prepare("UPDATE questionnaire_versions SET is_published=1 WHERE id=?").bind(current.id).run();
    await env.DB.prepare("UPDATE publish_state SET is_published=1,public_link_enabled=1,updated_at=CURRENT_TIMESTAMP WHERE questionnaire_id=?").bind(q.id).run();
    await env.DB.prepare("UPDATE questionnaires SET is_active=1 WHERE id=?").bind(q.id).run();
    return response({ok:true,published:true,version:current.version_number});
  }
  if (sub==="unpublish"&&request.method==="POST") {
    // Keep the version's is_published flag: existing opaque links continue to work.
    await env.DB.prepare("UPDATE publish_state SET is_published=0,public_link_enabled=0,updated_at=CURRENT_TIMESTAMP WHERE questionnaire_id=?").bind(q.id).run();
    await env.DB.prepare("UPDATE questionnaires SET is_active=0 WHERE id=?").bind(q.id).run();
    return response({ok:true,published:false,note:"Existing links continue to accept submissions."});
  }

  if (sub==="questions"&&request.method==="GET") {
    const rows=await env.DB.prepare(
      `SELECT q.id,q.question_code AS code,q.question_text AS text,q.question_type AS type,q.branch,q.display_order,
       q.is_required,q.options_json,COALESCE(p.page_number,1) AS page_number,COALESCE(qm.visibility,q.branch,'all') AS visibility
       FROM questions q LEFT JOIN question_state qs ON qs.question_id=q.id
       LEFT JOIN question_meta qm ON qm.question_id=q.id LEFT JOIN interview_pages p ON p.id=qm.page_id
       WHERE q.questionnaire_id=? AND COALESCE(qs.is_active,1)=1 ORDER BY COALESCE(p.page_number,1),q.display_order`
    ).bind(q.id).all<any>();
    return response((rows.results??[]).map(x=>({id:x.id,code:x.code,text:x.text,type:x.type,branch:x.branch,order:x.display_order,
      required:Boolean(x.is_required),options:safeJson(x.options_json),page_number:x.page_number,visibility:x.visibility})));
  }

  if (sub==="questions"&&request.method==="PUT") {
    let body:any; try {body=await request.json();} catch {return response({error:"Invalid JSON body"},400);}
    if (!Array.isArray(body.questions)||body.questions.length>300) return response({error:"questions must be an array of up to 300 items"},400);
    const seen=new Set<string>();
    for (let i=0;i<body.questions.length;i++) {
      const error=validateQuestion(body.questions[i],i);
      if (error) return response({error},400);
      if (seen.has(body.questions[i].code)) return response({error:`Duplicate question code: ${body.questions[i].code}`},400);
      seen.add(body.questions[i].code);
    }
    const pages=Array.isArray(body.pages)?body.pages:[];
    for (const p of pages) if (!Number.isInteger(p.page_number)||p.page_number<1||p.page_number>50||typeof p.title!=="string") return response({error:"Each page needs page_number (1-50) and title"},400);
    for (const p of pages) await env.DB.prepare("INSERT INTO interview_pages(questionnaire_id,page_number,title) VALUES (?,?,?) ON CONFLICT(questionnaire_id,page_number) DO UPDATE SET title=excluded.title").bind(q.id,p.page_number,p.title.slice(0,200)).run();

    const current=await getCurrentVersion(env,q.id);
    const nextVersion=(current?.version_number??q.version)+1;
    const title=typeof body.title==="string"&&body.title.trim()?body.title.trim().slice(0,200):q.title;
    // Mark old questions inactive instead of deleting them: existing answers keep their foreign-key targets.
    await env.DB.prepare("UPDATE question_state SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE question_id IN (SELECT id FROM questions WHERE questionnaire_id=?)").bind(q.id).run();
    for (let i=0;i<body.questions.length;i++) {
      const item=body.questions[i];
      const pageNumber=Number.isInteger(item.page_number)?item.page_number:1;
      await env.DB.prepare("INSERT OR IGNORE INTO interview_pages(questionnaire_id,page_number,title) VALUES (?,?,?)").bind(q.id,pageNumber,`Page ${pageNumber}`).run();
      const old=await env.DB.prepare("SELECT id FROM questions WHERE questionnaire_id=? AND question_code=?").bind(q.id,item.code).first<{id:number}>();
      if (old) {
        await env.DB.prepare("UPDATE questions SET question_text=?,question_type=?,branch=?,display_order=?,is_required=?,options_json=? WHERE id=?")
          .bind(item.text.trim(),item.type,item.visibility??item.branch??"shared",i+1,item.required===false?0:1,item.options?JSON.stringify(item.options):null,old.id).run();
        await env.DB.prepare("INSERT INTO question_state(question_id,is_active,updated_at) VALUES (?,1,CURRENT_TIMESTAMP) ON CONFLICT(question_id) DO UPDATE SET is_active=1,updated_at=CURRENT_TIMESTAMP").bind(old.id).run();
        const page=await env.DB.prepare("SELECT id FROM interview_pages WHERE questionnaire_id=? AND page_number=?").bind(q.id,pageNumber).first<{id:number}>();
        await env.DB.prepare("INSERT INTO question_meta(question_id,page_id,visibility) VALUES (?,?,?) ON CONFLICT(question_id) DO UPDATE SET page_id=excluded.page_id,visibility=excluded.visibility")
          .bind(old.id,page?.id??null,item.visibility??"all").run();
      } else {
        const ins=await env.DB.prepare("INSERT INTO questions(questionnaire_id,question_code,question_text,question_type,branch,display_order,is_required,options_json) VALUES (?,?,?,?,?,?,?,?)")
          .bind(q.id,item.code,item.text.trim(),item.type,item.visibility??item.branch??"shared",i+1,item.required===false?0:1,item.options?JSON.stringify(item.options):null).run();
        if (!ins.success) return response({error:`Could not save question ${item.code}`},500);
        const created=await env.DB.prepare("SELECT id FROM questions WHERE questionnaire_id=? AND question_code=?").bind(q.id,item.code).first<{id:number}>();
        if (created) {
          await env.DB.prepare("INSERT INTO question_state(question_id,is_active) VALUES (?,1)").bind(created.id).run();
          const page=await env.DB.prepare("SELECT id FROM interview_pages WHERE questionnaire_id=? AND page_number=?").bind(q.id,pageNumber).first<{id:number}>();
          await env.DB.prepare("INSERT INTO question_meta(question_id,page_id,visibility) VALUES (?,?,?)").bind(created.id,page?.id??null,item.visibility??"all").run();
        }
      }
    }
    await env.DB.prepare("INSERT INTO questionnaire_versions(questionnaire_id,version_number,title,is_published) VALUES (?,?,?,0)").bind(q.id,nextVersion,title).run();
    const newVersion=await env.DB.prepare("SELECT id FROM questionnaire_versions WHERE questionnaire_id=? AND version_number=?").bind(q.id,nextVersion).first<{id:number}>();
    if (!newVersion) return response({error:"Questions saved but version snapshot initialization failed"},500);
    await env.DB.prepare("UPDATE questionnaires SET title=?,version=? WHERE id=?").bind(title,nextVersion,q.id).run();
    await createSnapshot(env,q.id,newVersion.id);
    return response({ok:true,version:nextVersion,question_count:body.questions.length});
  }

  if (sub==="pages"&&request.method==="GET") {
    const pages=await env.DB.prepare("SELECT page_number,title FROM interview_pages WHERE questionnaire_id=? ORDER BY page_number").bind(q.id).all();
    return response(pages.results??[]);
  }
  if (sub==="submissions"&&request.method==="GET") {
    const search=(url.searchParams.get("search")??"").trim().toLowerCase();
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")??100)||100));
    const rows=await env.DB.prepare(
      `SELECT id,submission_code,respondent_name AS name,respondent_email AS email,LOWER(respondent_type) AS work_type,submitted_at,status
       FROM submissions WHERE questionnaire_id=? AND (?='' OR LOWER(respondent_name) LIKE ? OR LOWER(respondent_email) LIKE ?)
       ORDER BY submitted_at DESC LIMIT ?`
    ).bind(q.id,search,`%${search}%`,`%${search}%`,limit).all<any>();
    return response((rows.results??[]).map(r=>({...r,ID:displayInterviewId(q.questionnaire_code)})));
  }
  const detailMatch=sub.match(/^submissions\/([^/]+)$/);
  if (detailMatch&&request.method==="GET") {
    const raw=detailMatch[1];
    const subRow=await env.DB.prepare("SELECT * FROM submissions WHERE questionnaire_id=? AND (submission_code=? OR CAST(id AS TEXT)=?)").bind(q.id,raw,raw).first<any>();
    if (!subRow) return response({error:"Submission not found"},404);
    const version=await env.DB.prepare("SELECT version_id FROM submission_version_map WHERE submission_id=?").bind(subRow.id).first<{version_id:number}>();
    const answers=version ? await env.DB.prepare(
      `SELECT vq.question_code AS code,vq.question_text AS question,vq.question_type AS type,
       va.selected_options_json,va.other_text,va.text_answer
       FROM versioned_answers va JOIN version_questions vq ON vq.id=va.version_question_id
       WHERE va.submission_id=? ORDER BY vq.page_number,vq.display_order`
    ).bind(subRow.id).all<any>() : await env.DB.prepare(
      "SELECT q.question_code AS code,q.question_text AS question,q.question_type AS type,a.selected_options_json,a.other_text,a.text_answer FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=? ORDER BY q.display_order"
    ).bind(subRow.id).all<any>();
    return response({ID:displayInterviewId(q.questionnaire_code),name:subRow.respondent_name,email:subRow.respondent_email,
      work_type:String(subRow.respondent_type).toLowerCase(),submitted_at:subRow.submitted_at,answers:(answers.results??[]).map(a=>({
        code:a.code,question:a.question,type:a.type,value:compactAnswerDisplay(a)
      }))});
  }

  if (sub==="duplicate"&&request.method==="POST") {
    const next=await getNextInterviewCode(env.DB), title=`Copy of ${q.title}`;
    const created=await env.DB.prepare("INSERT INTO questionnaires(questionnaire_code,title,version,is_active) VALUES (?,?,1,0)").bind(next,title).run();
    if (!created.success) return response({error:"Could not create copy"},500);
    const copy=await env.DB.prepare("SELECT id FROM questionnaires WHERE questionnaire_code=?").bind(next).first<{id:number}>();
    if (!copy) return response({error:"Could not load copy"},500);
    await env.DB.prepare("INSERT INTO questionnaire_versions(questionnaire_id,version_number,title,is_published) VALUES (?,1,?,0)").bind(copy.id,title).run();
    await env.DB.prepare("INSERT INTO publish_state(questionnaire_id,is_published,public_link_enabled) VALUES (?,0,0)").bind(copy.id).run();
    await env.DB.prepare("INSERT INTO interview_public_tokens(token,questionnaire_id,interview_code) VALUES (?,?,?)").bind(generateSecureToken(24),copy.id,next).run();
    const pages=await env.DB.prepare("SELECT page_number,title FROM interview_pages WHERE questionnaire_id=? ORDER BY page_number").bind(q.id).all<any>();
    for (const p of pages.results??[]) await env.DB.prepare("INSERT OR IGNORE INTO interview_pages(questionnaire_id,page_number,title) VALUES (?,?,?)").bind(copy.id,p.page_number,p.title).run();
    const questions=await env.DB.prepare(
      `SELECT q.question_code,q.question_text,q.question_type,q.branch,q.display_order,q.is_required,q.options_json,
       COALESCE(p.page_number,1) AS page_number,COALESCE(qm.visibility,'all') AS visibility
       FROM questions q LEFT JOIN question_state qs ON qs.question_id=q.id
       LEFT JOIN question_meta qm ON qm.question_id=q.id LEFT JOIN interview_pages p ON p.id=qm.page_id
       WHERE q.questionnaire_id=? AND COALESCE(qs.is_active,1)=1 ORDER BY q.display_order`
    ).bind(q.id).all<any>();
    for (const old of questions.results??[]) {
      await env.DB.prepare("INSERT INTO questions(questionnaire_id,question_code,question_text,question_type,branch,display_order,is_required,options_json) VALUES (?,?,?,?,?,?,?,?)")
        .bind(copy.id,old.question_code,old.question_text,old.question_type,old.branch,old.display_order,old.is_required,old.options_json).run();
      const nq=await env.DB.prepare("SELECT id FROM questions WHERE questionnaire_id=? AND question_code=?").bind(copy.id,old.question_code).first<{id:number}>();
      const page=await env.DB.prepare("SELECT id FROM interview_pages WHERE questionnaire_id=? AND page_number=?").bind(copy.id,old.page_number).first<{id:number}>();
      if(nq) {
        await env.DB.prepare("INSERT INTO question_state(question_id,is_active) VALUES (?,1)").bind(nq.id).run();
        await env.DB.prepare("INSERT INTO question_meta(question_id,page_id,visibility) VALUES (?,?,?)").bind(nq.id,page?.id??null,old.visibility).run();
      }
    }
    const v=await env.DB.prepare("SELECT id FROM questionnaire_versions WHERE questionnaire_id=? AND version_number=1").bind(copy.id).first<{id:number}>();
    if(v) await createSnapshot(env,copy.id,v.id);
    return response({ok:true,ID:displayInterviewId(next)},201);
  }

  if (sub==="export"&&request.method==="GET") {
    const format=url.searchParams.get("format")??"json";
    if (!["json","csv","txt"].includes(format)) return response({error:"format must be json, csv, or txt"},400);
    const submissions=await env.DB.prepare("SELECT * FROM submissions WHERE questionnaire_id=? ORDER BY submitted_at").bind(q.id).all<any>();
    const allQuestions=await env.DB.prepare(
      `SELECT DISTINCT question_code,MIN(display_order) AS display_order FROM version_questions vq
       JOIN questionnaire_versions v ON v.id=vq.version_id WHERE v.questionnaire_id=? GROUP BY question_code ORDER BY display_order`
    ).bind(q.id).all<any>();
    const codes=(allQuestions.results??[]).map((x:any)=>x.question_code);
    const data:any[]=[];
    for(const s of submissions.results??[]) {
      const version=await env.DB.prepare("SELECT version_id FROM submission_version_map WHERE submission_id=?").bind(s.id).first<{version_id:number}>();
      const rows=version?await env.DB.prepare(
        "SELECT vq.question_code,va.selected_options_json,va.other_text,va.text_answer FROM versioned_answers va JOIN version_questions vq ON vq.id=va.version_question_id WHERE va.submission_id=?"
      ).bind(s.id).all<any>():await env.DB.prepare(
        "SELECT q.question_code,a.selected_options_json,a.other_text,a.text_answer FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=?"
      ).bind(s.id).all<any>();
      const map:Record<string,string>={};
      for(const a of rows.results??[]) map[a.question_code]=compactAnswerDisplay(a);
      data.push({ID:displayInterviewId(q.questionnaire_code),name:s.respondent_name,email:s.respondent_email,work_type:String(s.respondent_type).toLowerCase(),
        ...Object.fromEntries(codes.map((c:string)=>[c,map[c]??""])),submitted_at:s.submitted_at});
    }
    const filename=`${displayInterviewId(q.questionnaire_code)}-export.${format}`;
    if(format==="json") return response(data,200,{"Content-Disposition":`attachment; filename="${filename}"`});
    if(format==="csv") {
      const cols=["ID","name","email","work_type",...codes,"submitted_at"];
      const cell=(v:unknown)=>`"${String(v??"").replace(/"/g,'""')}"`;
      const csv=[cols.map(cell).join(","),...data.map(row=>cols.map(c=>cell(row[c])).join(","))].join("\r\n");
      return new Response(csv,{headers:{...cors,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="${filename}"`}});
    }
    return new Response(data.map(row=>Object.entries(row).map(([k,v])=>`${k}: ${v}`).join("\n")).join("\n\n"),
      {headers:{...cors,"Content-Type":"text/plain; charset=utf-8","Content-Disposition":`attachment; filename="${filename}"`}});
  }
  return response({error:"Route not implemented"},404);
}
