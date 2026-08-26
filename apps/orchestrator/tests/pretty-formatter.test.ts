import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PrettyConsoleFormatter } from "../src/utils/pretty-formatter.js";

// Mock config
jest.unstable_mockModule("../src/utils/config.js", () => ({
  config: {
    logFormat: () => "pretty",
    isDebug: () => false,
  },
}));

describe("PrettyConsoleFormatter", () => {
  let formatter: PrettyConsoleFormatter;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    formatter = new PrettyConsoleFormatter();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "clear").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getOutputLines(): string[] {
    return consoleLogSpy.mock.calls
      .map((call) => call[0])
      .filter((line) => typeof line === "string" && line.length > 0);
  }

  function getLastProgressLine(): string | undefined {
    const lines = getOutputLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("Progress")) return lines[i];
    }
    return undefined;
  }

  function getLinesContaining(substring: string): string[] {
    return getOutputLines().filter((l) => l.includes(substring));
  }

  it("prints header on first nodeStart", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Research", "researching sources");

    const lines = getOutputLines();
    const runLine = lines.find((l) => l.includes("Run test-run"));
    expect(runLine).toBeDefined();
    expect(runLine).toContain("test-run");
    expect(runLine).toContain("Attempt 1");
    const topicLine = lines.find((l) => l.includes("Test Topic"));
    expect(topicLine).toBeDefined();
  });

  it("prints node start with phase", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Script", "generating script");

    const nodeLine = getLinesContaining("generating")[0];
    expect(nodeLine).toBeDefined();
  });

  it("prints node done with duration", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Script", "generating script");
    formatter.nodeDone("Script", 10800);

    // Just check that some line contains Script and 10.8s
    const lines = getLinesContaining("Script");
    const doneLine = lines.find((l) => l.includes("10.8s"));
    expect(doneLine).toBeDefined();
  });

  it("prints retry with attempt info", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Script QA", "checking script");
    formatter.nodeRetry("Script QA", 2, 3, "revision requested");

    const retryLine = getLinesContaining("retry")[0];
    expect(retryLine).toBeDefined();
    expect(retryLine).toContain("2/3");
  });

  it("prints progress bar with correct counts", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Research", "researching sources");
    formatter.nodeDone("Research", 10000);
    formatter.nodeStart("Research QA", "reviewing research quality");
    formatter.nodeDone("Research QA", 91000);

    // Get the LAST progress line (after second nodeDone)
    const progressLine = getLastProgressLine();
    expect(progressLine).toBeDefined();
    expect(progressLine).toContain("2/20");
  });

  it("prints complete footer on finalize", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Research", "researching sources");
    formatter.nodeDone("Research", 10000);
    formatter.finalize("complete", "10 scenes · 66.2s · 9 assets");

    const lines = getOutputLines();
    const footerLine = lines.find((l) => l.includes("VIDEO COMPLETE"));
    expect(footerLine).toBeDefined();
    const summaryLine = lines.find((l) => l.includes("Total time:"));
    expect(summaryLine).toBeDefined();
    const statsLine = lines.find((l) => l.includes("10 scenes"));
    expect(statsLine).toBeDefined();
  });

  it("prints failed footer on finalize with error", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Scene Direction", "planning visual direction");
    formatter.finalize(
      "failed",
      "Failed to produce valid scenes after 3 attempts",
    );

    const lines = getOutputLines();
    const footerLine = lines.find((l) => l.includes("VIDEO FAILED"));
    expect(footerLine).toBeDefined();
    const timeLine = lines.find((l) => l.includes("Time:"));
    expect(timeLine).toBeDefined();
    const nodeLine = lines.find((l) => l.includes("Scene Direction"));
    expect(nodeLine).toBeDefined();
    const reasonLine = lines.find((l) =>
      l.includes("Failed to produce valid scenes"),
    );
    expect(reasonLine).toBeDefined();
  });

  it("formats duration correctly", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });

    formatter.nodeStart("Test1", "test");
    formatter.nodeDone("Test1", 500);
    formatter.nodeStart("Test2", "test");
    formatter.nodeDone("Test2", 5000);
    formatter.nodeStart("Test3", "test");
    formatter.nodeDone("Test3", 65000);
    formatter.nodeStart("Test4", "test");
    formatter.nodeDone("Test4", 125000);

    const lines = getOutputLines();
    // Check for duration strings anywhere in output
    expect(lines.some((l) => l.includes("500ms"))).toBe(true);
    expect(lines.some((l) => l.includes("5.0s"))).toBe(true);
    expect(lines.some((l) => l.includes("1m 05s"))).toBe(true);
    expect(lines.some((l) => l.includes("2m 05s"))).toBe(true);
  });

  it("does not print header twice", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Research", "researching sources");
    formatter.nodeStart("Script", "generating script");

    const headerLines = getOutputLines().filter((l) =>
      l.includes("AI VIDEO PIPELINE"),
    );
    expect(headerLines.length).toBe(1);
  });

  it("updates phase for running node", () => {
    formatter.setRunContext({
      runId: "test-run",
      topic: "Test Topic",
      attempt: 1,
    });
    formatter.nodeStart("Script", "generating script");
    formatter.nodePhase("Script", "revising script");

    const lines = getLinesContaining("Script");
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
