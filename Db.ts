export type Env = {
  DB: D1Database;
  ENVIRONMENT: string;
};

export async function getNextInterviewCode(DB: D1Database): Promise<string> {
  // Find max numeric code from questionnaires table where code is numeric or INT-xxx
  // We store interview code as questionnaires.questionnaire_code
  // This function assumes questionnaire_code format is either 001 or INT-001
  const rows = await DB.prepare(`SELECT questionnaire_code FROM questionnaires`).all();
  let max = 0;
  for (const r of rows.results as any[]) {
    const code: string = r.questionnaire_code;
    const m = code.match(/(\d+)/);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!isNaN(num) && num > max) max = num;
    }
  }
  const next = max + 1;
  if (next < 1000) return String(next).padStart(3, '0');
  return String(next);
}

export function compactAnswerDisplay(row: {
  selected_options_json: string | null;
  other_text: string | null;
  text_answer: string | null;
}): string {
  // Implements: A, A,C, text, F (text) / F
  if (row.text_answer && !row.selected_options_json) {
    return row.text_answer;
  }
  if (row.selected_options_json) {
    try {
      const parsed = JSON.parse(row.selected_options_json);
      const codes: string[] = Array.isArray(parsed) ? parsed : [parsed];
      const codesStr = codes.join(',');
      // Check for Other F
      const hasF = codes.includes('F');
      if (hasF && row.other_text && row.other_text.trim().length > 0) {
        // Replace F with F (text) preserving other codes
        const others = codes.filter(c => c !== 'F');
        const base = others.length ? others.join(',') + ',' : '';
        return `${base}F (${row.other_text.trim()})`;
      }
      if (hasF && row.other_text) {
        // No text provided
        return codesStr;
      }
      return codesStr;
    } catch {
      // Fallback if stored as plain string
      const s = row.selected_options_json;
      if (s === 'F' && row.other_text) {
        return row.other_text.trim() ? `F (${row.other_text.trim()})` : 'F';
      }
      return s;
    }
  }
  if (row.other_text) return row.other_text;
  return '';
}
