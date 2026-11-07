/* A separate closed selection contract for recurring reviews. No model prose,
   amounts, formulas, settings changes, URLs or executable actions are accepted. */
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const list = (item, minItems, maxItems) => ({ type: 'array', items: item, minItems, maxItems });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const AGENT_REVIEW_OUTPUT_VERSION = 'agent-review-selection-v1';
export const AGENT_REVIEW_OUTPUT_SCHEMA = object({
  thesis: { type: 'string', enum: ['risk_first', 'range_review', 'preserve_cash', 'review_choices'] },
  choices: list(object({ candidateId: text(80), reasonIds: list(text(64), 1, 2),
    watchIds: list(text(64), 0, 2), lessonIds: list(text(80), 0, 2) }), 1, 3),
});
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
freeze(AGENT_REVIEW_OUTPUT_SCHEMA);
