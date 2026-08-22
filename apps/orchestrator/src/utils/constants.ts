export const DEFAULT_MAX_RETRIES = 3;
export const RESEARCH_MAX_RETRIES = DEFAULT_MAX_RETRIES;
export const SCRIPT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
export const PROMPT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
// QA revision budgets (pipeline continuation policy). A revision re-runs the
// producer; minor issues get one revision before the best result is accepted,
// major/fail get two before the run fails. These bound every QA loop so a
// router can never regenerate indefinitely.
export const MINOR_REVISION_MAX = 1;
export const MAJOR_REVISION_MAX = 2;
// QA nodes are cheap (small prompt, low temperature). When a QA's own LLM
// call fails, retrying the QA node itself costs far less than regenerating
// the producer's output, so QA gets its own (smaller) budget.
export const RESEARCH_QA_MAX_RETRIES = 2;
export const SCRIPT_QA_MAX_RETRIES = 2;
export const PROMPT_QA_MAX_RETRIES = 2;
// Non-retryable provider rejections go through ImagePromptRepair. This is the
// maximum number of LLM repair calls per scene; EVERY repaired prompt is then
// attempted by the generator, and a rejection past the ceiling fails the scene
// closed so the pipeline cannot loop indefinitely on an irreconcilable prompt.
export const MAX_PROMPT_REPAIRS = 2;
// Transient provider failures (rate_limit/timeout/server_error) back off with
// these delays, then fail. Policy/prompt rejections never consume this budget.
// 1 initial attempt + 3 retries = 4 total attempts, all three delays used.
export const IMAGE_TRANSIENT_RETRY_DELAYS_MS = [2000, 5000, 15000] as const;
export const IMAGE_TRANSIENT_MAX_ATTEMPTS =
  IMAGE_TRANSIENT_RETRY_DELAYS_MS.length + 1;
// WAV/ffprobe duration precision varies slightly between codecs and headers.
export const AUDIO_DURATION_TOLERANCE_MS = 50;
