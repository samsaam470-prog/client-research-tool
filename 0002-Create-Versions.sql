-- 0002: Immutable versioning layer + submission linkage
-- All CREATE IF NOT EXISTS, no DROP, no DELETE

CREATE TABLE IF NOT EXISTS questionnaire_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  snapshot_json TEXT, -- immutable copy of pages/questions/options at version time
  is_published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
  UNIQUE(questionnaire_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_qv_qid ON questionnaire_versions(questionnaire_id);

-- Link each submission to exact version it completed
CREATE TABLE IF NOT EXISTS submission_version_map (
  submission_id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES questionnaire_versions(id)
);

-- Backfill: Create version 1 for every existing questionnaire if not exists
-- Preserves INT-001 and any other existing code
INSERT OR IGNORE INTO questionnaire_versions (questionnaire_id, version_number, title, is_published)
SELECT id, version, title, is_active FROM questionnaires;

-- Backfill: Link existing submissions to version 1 where not linked
INSERT OR IGNORE INTO submission_version_map (submission_id, version_id)
SELECT s.id, qv.id
FROM submissions s
JOIN questionnaire_versions qv ON qv.questionnaire_id = s.questionnaire_id AND qv.version_number = 1
LEFT JOIN submission_version_map svm ON svm.submission_id = s.id
WHERE svm.submission_id IS NULL;

-- Publishing control separate from link validity (per your spec)
-- is_active remains, is_published in versions controls dashboard sharing UI
-- No change to existing questionnaires.is_active column to avoid destructive ALTER
CREATE TABLE IF NOT EXISTS publish_state (
  questionnaire_id INTEGER PRIMARY KEY,
  is_published INTEGER NOT NULL DEFAULT 0,
  public_link_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO publish_state (questionnaire_id, is_published, public_link_enabled)
SELECT id, is_active, is_active FROM questionnaires;
