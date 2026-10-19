-- Additive migration only. Existing questionnaire/submission/answer data is preserved.
CREATE TABLE IF NOT EXISTS interview_public_tokens (
  token TEXT PRIMARY KEY,
  questionnaire_id INTEGER NOT NULL,
  interview_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_tokens_questionnaire
  ON interview_public_tokens(questionnaire_id);
CREATE INDEX IF NOT EXISTS idx_public_tokens_code
  ON interview_public_tokens(interview_code);

CREATE TABLE IF NOT EXISTS interview_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id),
  UNIQUE(questionnaire_id, page_number)
);

CREATE TABLE IF NOT EXISTS question_meta (
  question_id INTEGER PRIMARY KEY,
  page_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'all'
    CHECK (visibility IN ('all', 'freelancer', 'agency')),
  FOREIGN KEY (question_id) REFERENCES questions(id),
  FOREIGN KEY (page_id) REFERENCES interview_pages(id)
);
CREATE INDEX IF NOT EXISTS idx_question_meta_page ON question_meta(page_id);

INSERT OR IGNORE INTO interview_pages(questionnaire_id, page_number, title)
SELECT id, 1, 'Participant Info' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages(questionnaire_id, page_number, title)
SELECT id, 2, 'Work Type' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages(questionnaire_id, page_number, title)
SELECT id, 3, 'Business Experience' FROM questionnaires;
INSERT OR IGNORE INTO interview_pages(questionnaire_id, page_number, title)
SELECT id, 4, 'Research Questions' FROM questionnaires;
