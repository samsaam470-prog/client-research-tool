export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export async function getNextInterviewCode(DB: D1Database): Promise<string> {
  const rows = await DB.prepare("SELECT questionnaire_code FROM questionnaires").all<{ questionnaire_code: string }>();
  let max = 0;
  for (const row of rows.results ?? []) {
    const match = String(row.questionnaire_code).match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  return next < 1000 ? String(next).padStart(3, "0") : String(next);
}

export function compactAnswerDisplay(row: {
  selected_options_json: string | null;
  other_text: string | null;
  text_answer: string | null;
}): string {
  if (row.text_answer && !row.selected_options_json) return row.text_answer;
  if (row.selected_options_json) {
    try {
      const parsed: unknown = JSON.parse(row.selected_options_json);
      const codes = (Array.isArray(parsed) ? parsed : [parsed]).map(String);
      const other = row.other_text?.trim();
      return codes.map(code => code === "F" && other ? `F (${other})` : code).join(",");
    } catch {
      return row.selected_options_json;
    }
  }
  return row.other_text?.trim() || "";
}
