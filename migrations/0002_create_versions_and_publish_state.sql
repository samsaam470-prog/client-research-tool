-- Additive migration only. Never drops or rewrites existing tables.
CREATE TABLE IF NOT EXISTS questionnaire_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  snapshot_json TEXT,
  is_published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id),
  UNIQUE(questionnaire_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_questionnaire_versions_qid
  ON questionnaire_versions(questionnaire_id);

CREATE TABLE IF NOT EXISTS submission_version_map (
  submission_id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id),
  FOREIGN KEY (version_id) REFERENCES questionnaire_versions(id)
);

CREATE TABLE IF NOT EXISTS publish_state (
  questionnaire_id INTEGER PRIMARY KEY,
  is_published INTEGER NOT NULL DEFAULT 0,
  public_link_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id)
);

INSERT OR IGNORE INTO questionnaire_versions
  (questionnaire_id, version_number, title, is_published)
SELECT id, version, title, is_active FROM questionnaires;

INSERT OR IGNORE INTO submission_version_map(submission_id, version_id)
SELECT s.id, v.id
FROM submissions s
JOIN questionnaire_versions v
  ON v.questionnaire_id = s.questionnaire_id
 AND v.version_number = 1;

INSERT OR IGNORE INTO publish_state(questionnaire_id, is_published, public_link_enabled)
SELECT id, is_active, is_active FROM questionnaires;
