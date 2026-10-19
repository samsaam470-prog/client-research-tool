-- Immutable question snapshots per questionnaire version; existing tables/data remain intact.
CREATE TABLE IF NOT EXISTS version_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  question_code TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'shared',
  display_order INTEGER NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 1,
  options_json TEXT,
  page_number INTEGER NOT NULL DEFAULT 1,
  UNIQUE(version_id, question_code),
  FOREIGN KEY(version_id) REFERENCES questionnaire_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_version_questions_version
  ON version_questions(version_id, display_order);

CREATE TABLE IF NOT EXISTS versioned_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  version_question_id INTEGER NOT NULL,
  selected_options_json TEXT,
  other_text TEXT,
  text_answer TEXT,
  UNIQUE(submission_id, version_question_id),
  FOREIGN KEY(submission_id) REFERENCES submissions(id),
  FOREIGN KEY(version_question_id) REFERENCES version_questions(id)
);
CREATE INDEX IF NOT EXISTS idx_versioned_answers_submission
  ON versioned_answers(submission_id);

-- Backfill question snapshots from the current questionnaire structure.
INSERT OR IGNORE INTO version_questions
  (version_id, question_code, question_text, question_type, branch, display_order, is_required, options_json, page_number)
SELECT v.id, q.question_code, q.question_text, q.question_type, q.branch,
       q.display_order, q.is_required, q.options_json, COALESCE(p.page_number, 1)
FROM questionnaire_versions v
JOIN questions q ON q.questionnaire_id = v.questionnaire_id
LEFT JOIN question_meta qm ON qm.question_id = q.id
LEFT JOIN interview_pages p ON p.id = qm.page_id
WHERE v.version_number = 1;

-- Backfill answer values into the versioned model for existing submissions.
INSERT OR IGNORE INTO versioned_answers
  (submission_id, version_question_id, selected_options_json, other_text, text_answer)
SELECT a.submission_id, vq.id, a.selected_options_json, a.other_text, a.text_answer
FROM answers a
JOIN questions q ON q.id = a.question_id
JOIN submissions s ON s.id = a.submission_id
JOIN submission_version_map svm ON svm.submission_id = s.id
JOIN version_questions vq ON vq.version_id = svm.version_id
                          AND vq.question_code = q.question_code;
