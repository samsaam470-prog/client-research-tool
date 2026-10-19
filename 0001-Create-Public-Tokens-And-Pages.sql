-- 0001: Non-destructive, idempotent. Only CREATE IF NOT EXISTS.
-- Preserves questionnaires, questions, submissions, answers, _cf_KV, sqlite_sequence.

-- Public secure tokens: maps random token -> questionnaire (interview)
CREATE TABLE IF NOT EXISTS interview_public_tokens (
  token TEXT PRIMARY KEY,
  questionnaire_id INTEGER NOT NULL,
  interview_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_public_tokens_qid ON interview_public_tokens(questionnaire_id);
CREATE INDEX IF NOT EXISTS idx_public_tokens_code ON interview_public_tokens(interview_code);

-- Pages for configurable layout
CREATE TABLE IF NOT EXISTS interview_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
  UNIQUE(questionnaire_id, page_number)
);

-- Question metadata: page assignment + visibility all/freelancer/agency
-- Keeps original questions table untouched for safety
CREATE TABLE IF NOT EXISTS question_meta (
  question_id INTEGER PRIMARY KEY,
  page_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','freelancer','agency')),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES interview_pages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_qmeta_page ON question_meta(page_id);

-- Backfill: Ensure every existing questionnaire has at least 4 pages (default structure)
-- Idempotent due to INSERT OR IGNORE on UNIQUE constraint
INSERT OR IGNORE INTO interview_pages (questionnaire_id, page_number, title)
SELECT id, 1, 'Participant Info' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages (questionnaire_id, page_number, title)
SELECT id, 2, 'Work Type' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages (questionnaire_id, page_number, title)
SELECT id, 3, 'Business Experience' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages (questionnaire_id, page_number, title)
SELECT id, 4, 'Research Questions' FROM questionnaires;
