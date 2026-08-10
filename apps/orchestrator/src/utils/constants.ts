export const DEFAULT_MAX_RETRIES = 3;
export const RESEARCH_MAX_RETRIES = DEFAULT_MAX_RETRIES;
export const SCRIPT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
export const PROMPT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
// QA nodes are cheap (small prompt, low temperature). When a QA's own LLM
// call fails, retrying the QA node itself costs far less than regenerating
// the producer's output, so QA gets its own (smaller) budget.
export const RESEARCH_QA_MAX_RETRIES = 2;
export const SCRIPT_QA_MAX_RETRIES = 2;
export const PROMPT_QA_MAX_RETRIES = 2;
