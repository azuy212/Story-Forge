export const SCRIPT_COMPLEXITY_THRESHOLDS = {
  maxAverageSentenceWords: 15,
  maxSentenceWords: 25,
  maxReadingGrade: 8,
  targetSentenceMinWords: 8,
  targetSentenceMaxWords: 15,
} as const;

export type ScriptComplexityIssueCode =
  | "empty_narration"
  | "average_sentence_length"
  | "maximum_sentence_length"
  | "complex_language"
  | "idiom_or_slang"
  | "unexplained_technical_term";

export type ScriptComplexityIssue = {
  code: ScriptComplexityIssueCode;
  message: string;
};

export type ScriptComplexityReport = {
  passed: boolean;
  sentenceCount: number;
  wordCount: number;
  averageSentenceWords: number;
  maximumSentenceWords: number;
  targetSentenceRate: number;
  readingGrade: number;
  issues: ScriptComplexityIssue[];
  warnings: string[];
};

type TechnicalTerm = {
  term: string;
  sameSentenceExplanation: RegExp;
  nextSentenceExplanation: RegExp;
};

const COMPLEX_LANGUAGE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "perplexed", pattern: /\bperplexed\b/i },
  { label: "peculiar", pattern: /\bpeculiar\b/i },
  { label: "celestial object", pattern: /\bcelestial object\b/i },
  {
    label: "defy conventional explanations",
    pattern: /\bdef(?:y|ies) conventional explanations?\b/i,
  },
  { label: "unusual trajectory", pattern: /\bunusual trajectory\b/i },
  { label: "utilize", pattern: /\butili[sz]e\b/i },
  { label: "commence", pattern: /\bcommence\b/i },
  { label: "therein", pattern: /\btherein\b/i },
  { label: "notwithstanding", pattern: /\bnotwithstanding\b/i },
];

const IDIOM_OR_SLANG_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "break a leg", pattern: /\bbreak a leg\b/i },
  { label: "piece of cake", pattern: /\bpiece of cake\b/i },
  { label: "under the weather", pattern: /\bunder the weather\b/i },
  { label: "once in a blue moon", pattern: /\bonce in a blue moon\b/i },
  { label: "spill the beans", pattern: /\bspill the beans\b/i },
  { label: "raining cats and dogs", pattern: /\braining cats and dogs\b/i },
  { label: "in a nutshell", pattern: /\bin a nutshell\b/i },
  { label: "gonna", pattern: /\bgonna\b/i },
  { label: "wanna", pattern: /\bwanna\b/i },
  { label: "gotta", pattern: /\bgotta\b/i },
  { label: "kinda", pattern: /\bkinda\b/i },
  { label: "sorta", pattern: /\bsorta\b/i },
];

// This list stays deliberately small. Unknown terms are left for LLM QA rather
// than rejected by an unreliable dictionary.
const TECHNICAL_TERMS: TechnicalTerm[] = [
  {
    term: "event horizon",
    sameSentenceExplanation:
      /\bevent horizon\b[^.!?]{0,100}\b(is|means|refers to|describes|boundary|edge)\b/i,
    nextSentenceExplanation:
      /\bonce .{0,100}\bcross(?:es|ing)? it\b.{0,100}\b(cannot|can't|no way to) escape\b/i,
  },
  {
    term: "ecosystem",
    sameSentenceExplanation:
      /\becosystem\b[^.!?]{0,100}\b(community of|plants? and animals?|living things|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this ecosystem)\b[^.!?]{0,100}\b(community of|plants? and animals?|living things)\b/i,
  },
  {
    term: "photosynthesis",
    sameSentenceExplanation:
      /\bphotosynthesis\b[^.!?]{0,100}\b(plants? .*sunlight|use sunlight|make food|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this process)\b[^.!?]{0,100}\b(plants? .*sunlight|use sunlight|make food)\b/i,
  },
  {
    term: "orbit",
    sameSentenceExplanation:
      /\borbit\b[^.!?]{0,100}\b(path .*around|moves? around|travels? around|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this path)\b[^.!?]{0,100}\b(moves? around|travels? around)\b/i,
  },
  {
    term: "quantum",
    sameSentenceExplanation:
      /\bquantum\b[^.!?]{0,100}\b(tiny particles?|smallest particles?|very small|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this term)\b[^.!?]{0,100}\b(tiny particles?|smallest particles?|very small)\b/i,
  },
  {
    term: "tectonic plates",
    sameSentenceExplanation:
      /\btectonic plates\b[^.!?]{0,100}\b(large pieces?|pieces? of .*crust|earth'?s crust|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:they|these plates)\b[^.!?]{0,100}\b(pieces? of .*crust|earth'?s crust)\b/i,
  },
  {
    term: "algorithm",
    sameSentenceExplanation:
      /\balgorithm\b[^.!?]{0,100}\b(step-by-step instructions?|set of steps?|instructions?|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this program)\b[^.!?]{0,100}\b(step-by-step instructions?|set of steps?|instructions?)\b/i,
  },
  {
    term: "inflation",
    sameSentenceExplanation:
      /\binflation\b[^.!?]{0,100}\b(prices? rise|costs? more|increase in prices?|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this change)\b[^.!?]{0,100}\b(prices? rise|costs? more|increase in prices?)\b/i,
  },
  {
    term: "DNA",
    sameSentenceExplanation:
      /\bDNA\b[^.!?]{0,100}\b(genetic|instructions? for the body|molecule|means|refers to)\b/i,
    nextSentenceExplanation:
      /\b(?:it|this molecule)\b[^.!?]{0,100}\b(genetic|instructions? for the body|molecule)\b/i,
  },
];

function wordsIn(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function isSentenceBoundary(text: string, index: number): boolean {
  const character = text[index];
  if (!character || !".!?".includes(character)) return false;
  if (text[index + 1] && ".!?".includes(text[index + 1])) return false;
  if (character === "." && /[A-Za-z]/.test(text[index + 1] ?? "")) {
    return false;
  }
  if (
    character === "." &&
    /\d/.test(text[index - 1] ?? "") &&
    /\d/.test(text[index + 1] ?? "")
  ) {
    return false;
  }

  const before = text.slice(Math.max(0, index - 12), index + 1);
  if (/(?:\b[A-Za-z]\.){2,}$/.test(before)) return false;

  const word = before.match(/[A-Za-z]+\.?$/)?.[0]?.toLowerCase();
  return !new Set(["dr.", "mr.", "mrs.", "ms.", "prof.", "sr.", "jr."]).has(
    word ?? "",
  );
}

type Sentence = { text: string; start: number; end: number };

function splitSentences(text: string): Sentence[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences: Sentence[] = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    if (!isSentenceBoundary(normalized, index)) continue;
    const end = index + 1;
    const sentence = normalized.slice(start, end).trim();
    if (sentence) sentences.push({ text: sentence, start, end });
    start = end;
    while (/\s/.test(normalized[start] ?? "")) start += 1;
    index = start - 1;
  }

  const finalSentence = normalized.slice(start).trim();
  if (finalSentence) {
    sentences.push({ text: finalSentence, start, end: normalized.length });
  }
  return sentences;
}

function syllableCount(word: string): number {
  const normalized = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized) return 0;
  if (normalized.length <= 3) return 1;

  const withoutSilentE = normalized.replace(/e$/, "");
  const groups = withoutSilentE.match(/[aeiouy]+/g)?.length ?? 1;
  const silentLe = /[^aeiou]le$/.test(normalized) ? 1 : 0;
  return Math.max(1, groups + silentLe);
}

function calculateReadingGrade(sentences: string[], words: string[]): number {
  if (sentences.length === 0 || words.length === 0) return 0;
  const syllables = words.reduce(
    (total, word) => total + syllableCount(word),
    0,
  );
  const grade =
    0.39 * (words.length / sentences.length) +
    11.8 * (syllables / words.length) -
    15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findLanguageIssues(
  text: string,
  sentences: Sentence[],
): ScriptComplexityIssue[] {
  const issues: ScriptComplexityIssue[] = [];

  for (const { label, pattern } of COMPLEX_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        code: "complex_language",
        message: `Avoid unnecessarily sophisticated wording: "${label}".`,
      });
    }
  }

  for (const { label, pattern } of IDIOM_OR_SLANG_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        code: "idiom_or_slang",
        message: `Avoid idiom or slang: "${label}".`,
      });
    }
  }

  for (const {
    term,
    sameSentenceExplanation,
    nextSentenceExplanation,
  } of TECHNICAL_TERMS) {
    const termPattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    const match = termPattern.exec(text);
    if (!match) continue;

    const sentenceIndex = sentences.findIndex(
      (sentence) => match.index >= sentence.start && match.index < sentence.end,
    );
    const sentence = sentences[sentenceIndex];
    const nextSentence = sentences[sentenceIndex + 1];
    if (
      !sentence ||
      (!sameSentenceExplanation.test(sentence.text) &&
        !nextSentenceExplanation.test(nextSentence?.text ?? ""))
    ) {
      issues.push({
        code: "unexplained_technical_term",
        message: `Explain technical term "${term}" immediately in simple language.`,
      });
    }
  }

  return issues;
}

export function validateScriptComplexity(
  narration: string,
): ScriptComplexityReport {
  const sentences = splitSentences(narration);
  const words = wordsIn(narration);
  const sentenceLengths = sentences.map(
    (sentence) => wordsIn(sentence.text).length,
  );
  const sentenceCount = sentences.length;
  const wordCount = words.length;
  const averageSentenceWords =
    sentenceCount > 0 ? wordCount / sentenceCount : 0;
  const maximumSentenceWords = Math.max(0, ...sentenceLengths);
  const targetSentenceCount = sentenceLengths.filter(
    (length) =>
      length >= SCRIPT_COMPLEXITY_THRESHOLDS.targetSentenceMinWords &&
      length <= SCRIPT_COMPLEXITY_THRESHOLDS.targetSentenceMaxWords,
  ).length;
  const targetSentenceRate =
    sentenceCount > 0 ? targetSentenceCount / sentenceCount : 0;
  const readingGrade = calculateReadingGrade(
    sentences.map((sentence) => sentence.text),
    words,
  );
  const issues: ScriptComplexityIssue[] = [];
  const warnings: string[] = [];

  if (wordCount === 0 || sentenceCount === 0) {
    issues.push({
      code: "empty_narration",
      message: "Narration must contain spoken words.",
    });
  }
  if (
    averageSentenceWords > SCRIPT_COMPLEXITY_THRESHOLDS.maxAverageSentenceWords
  ) {
    issues.push({
      code: "average_sentence_length",
      message: `Average sentence length is ${averageSentenceWords.toFixed(1)} words; target is at most ${SCRIPT_COMPLEXITY_THRESHOLDS.maxAverageSentenceWords}.`,
    });
  }
  if (maximumSentenceWords > SCRIPT_COMPLEXITY_THRESHOLDS.maxSentenceWords) {
    issues.push({
      code: "maximum_sentence_length",
      message: `Longest sentence is ${maximumSentenceWords} words; limit is ${SCRIPT_COMPLEXITY_THRESHOLDS.maxSentenceWords}.`,
    });
  }

  issues.push(...findLanguageIssues(narration, sentences));

  // Average and maximum sentence length are hard gates. Target-range coverage
  // and reading grade are advisory signals because hooks, proper nouns, and
  // necessary technical terms can make those measures noisy.
  if (targetSentenceRate < 0.5 && sentenceCount > 1) {
    warnings.push(
      `Only ${Math.round(targetSentenceRate * 100)}% of sentences are within the ${SCRIPT_COMPLEXITY_THRESHOLDS.targetSentenceMinWords}-${SCRIPT_COMPLEXITY_THRESHOLDS.targetSentenceMaxWords}-word target.`,
    );
  }
  if (readingGrade > SCRIPT_COMPLEXITY_THRESHOLDS.maxReadingGrade) {
    warnings.push(
      `Approximate reading grade is ${readingGrade}; target range is grade 6-8.`,
    );
  }

  return {
    passed: issues.length === 0,
    sentenceCount,
    wordCount,
    averageSentenceWords: Math.round(averageSentenceWords * 10) / 10,
    maximumSentenceWords,
    targetSentenceRate: Math.round(targetSentenceRate * 100) / 100,
    readingGrade,
    issues,
    warnings,
  };
}

export function formatScriptComplexityReport(
  report: ScriptComplexityReport,
): string {
  const metrics = [
    `Average sentence length: ${report.averageSentenceWords} words (target <= 15)`,
    `Maximum sentence length: ${report.maximumSentenceWords} words (target <= 25)`,
    `Approximate reading grade: ${report.readingGrade} (diagnostic target 6-8)`,
  ];
  return [
    ...metrics,
    ...report.issues.map((issue) => issue.message),
    ...report.warnings,
  ].join("\n");
}
