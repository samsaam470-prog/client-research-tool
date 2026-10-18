import test from "node:test";
import assert from "node:assert/strict";
import { validateQuestionnaire, validateAnswers, conditionMatches, csvCell, toCsv, isOriginAllowed, slugify } from "../src/index.js";

test("validates supported questionnaire and normalizes question IDs", () => {
  const q = validateQuestionnaire({ title: "  Interview  ", questions: [{ label: "Name", type: "text", required: true }] });
  assert.equal(q.title, "Interview");
  assert.equal(q.questions[0].id, "q_1");
});

test("rejects duplicate question IDs and unsupported question types", () => {
  assert.throws(() => validateQuestionnaire({ title: "X", questions: [
    { id: "same", label: "One", type: "text" }, { id: "same", label: "Two", type: "text" }
  ] }), /unique/);
  assert.throws(() => validateQuestionnaire({ title: "X", questions: [{ label: "X", type: "script" }] }), /Unsupported/);
});

test("validates choice answers and required answers", () => {
  const schema = validateQuestionnaire({ title: "X", questions: [
    { id: "choice", label: "Choose", type: "single_choice", required: true, options: ["A", "B"] }
  ] });
  assert.deepEqual(validateAnswers(schema, { choice: "B" }), { choice: "B" });
  assert.throws(() => validateAnswers(schema, { choice: "C" }), /Invalid answer/);
  assert.throws(() => validateAnswers(schema, {}), /Required answer/);
});

test("conditional question is skipped when condition is false", () => {
  const schema = validateQuestionnaire({ title: "X", questions: [
    { id: "first", label: "Interested?", type: "single_choice", required: true, options: ["yes", "no"] },
    { id: "followup", label: "Tell us more", type: "long_text", required: true, condition: { questionId: "first", operator: "equals", value: "yes" } }
  ] });
  assert.deepEqual(validateAnswers(schema, { first: "no" }), { first: "no" });
  assert.throws(() => validateAnswers(schema, { first: "yes" }), /Required answer/);
});

test("rejects conditions referencing questions that do not precede them", () => {
  assert.throws(() => validateQuestionnaire({ title: "X", questions: [
    { id: "later", label: "Later", type: "text", condition: { questionId: "missing", operator: "equals", value: "x" } }
  ] }), /earlier question/);
});

test("CSV quoting and spreadsheet formula injection protection", () => {
  assert.equal(csvCell('hello,"world"'), '"hello,""world"""');
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.match(toCsv([["a", "b"], ["x", "y"]]), /\r\n/);
});

test("CORS only allows explicitly configured origins", () => {
  const env = { ALLOWED_ORIGINS: "https://research.example, https://preview.example" };
  assert.equal(isOriginAllowed(new Request("https://api.example/api", { headers: { Origin: "https://research.example" } }), env), true);
  assert.equal(isOriginAllowed(new Request("https://api.example/api", { headers: { Origin: "https://evil.example" } }), env), false);
  assert.equal(isOriginAllowed(new Request("https://api.example/api"), env), true);
});

test("slugify creates URL-safe slugs", () => {
  assert.equal(slugify("Client Research / Round 1"), "client-research-round-1");
});
