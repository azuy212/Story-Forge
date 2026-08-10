export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export class LLMError extends PipelineError {
  constructor(message: string) {
    super(message, "LLM_ERROR");
    this.name = "LLMError";
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "LLMTimeoutError";
  }
}

export function isPipelineError(err: unknown): err is PipelineError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as PipelineError).code === "string"
  );
}

export function getErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
