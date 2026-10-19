CREATE TABLE IF NOT EXISTS question_state (
  question_id INTEGER PRIMARY KEY,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(question_id) REFERENCES questions(id)
);
INSERT OR IGNORE INTO question_state(question_id, is_active)
SELECT id, 1 FROM questions;

CREATE INDEX IF NOT EXISTS idx_question_state_active ON question_state(is_active);
