-- No token is generated in SQL: tokens must come from Web Crypto in the Worker.
INSERT OR IGNORE INTO publish_state(questionnaire_id, is_published, public_link_enabled)
SELECT id, is_active, is_active
FROM questionnaires
WHERE questionnaire_code = 'INT-001';
