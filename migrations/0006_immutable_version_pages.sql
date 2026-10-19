CREATE TABLE IF NOT EXISTS version_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  UNIQUE(version_id, page_number),
  FOREIGN KEY(version_id) REFERENCES questionnaire_versions(id)
);
INSERT OR IGNORE INTO version_pages(version_id,page_number,title)
SELECT v.id,p.page_number,COALESCE(p.title,'Page ' || p.page_number)
FROM questionnaire_versions v
JOIN interview_pages p ON p.questionnaire_id=v.questionnaire_id;
