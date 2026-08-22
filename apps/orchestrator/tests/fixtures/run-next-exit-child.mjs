// Spawned by tests/run-next-exit.int.test.ts. Runs the real resume.mjs
// streaming path against a stub LangGraph server that holds the SSE
// connection open after the terminal event, then ends — proving the process
// exits naturally once the specific graph run completes, without waiting for
// server shutdown.
import { getAssistantId, resumeRun } from "../../scripts/resume.mjs";

const assistantId = await getAssistantId();
await resumeRun(
  "exit-test-run",
  { pillar: "Psychology", topic: "Exit Test Topic" },
  { assistantId, projectId: "video-exit-1" },
);
console.log("CHILD_DONE");
