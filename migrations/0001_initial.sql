-- Interview Research Platform schema.
-- Additive and repeatable: no DROP statements and no data deletion.
-- IMPORTANT: review against the live D1 schema before applying. This migration
-- has NOT been tested against the production database.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questionnaire_versions (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  created_at TEXT NOT NULL,
  UNIQUE (questionnaire_id, version_number),
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL,
  questionnaire_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE RESTRICT,
  FOREIGN KEY (questionnaire_version_id) REFERENCES questionnaire_versions(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  question_label TEXT NOT NULL,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, question_key),
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_questionnaire_status_updated
  ON questionnaires(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_questionnaire_version
  ON questionnaire_versions(questionnaire_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_questionnaire_created
  ON submissions(questionnaire_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_version
  ON submissions(questionnaire_version_id);
CREATE INDEX IF NOT EXISTS idx_answers_submission
  ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window
  ON rate_limits(window_start);
