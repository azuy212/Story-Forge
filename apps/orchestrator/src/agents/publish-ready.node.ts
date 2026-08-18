import type { ProjectState, Diagnostics, Execution } from "../types/index.js";

export const PUBLISH_READY = "PublishReady";

// PublishReady is the explicit join/barrier before Publisher. LangGraph
// triggers a fan-in node when ANY incoming edge fires — not when all of them
// do — so this node may run several times as branches complete (once after
// Metadata/Thumbnail, again after the spine). It therefore must not record
// errors for a partial package: that is the expected intermediate state while
// the slower spine is still running. Its conditional edge gates Publisher on
// hasPublishablePackage, so premature runs fall through to __end__ and the
// graph keeps running until every branch has had its turn. If the spine dies,
// the real error was already recorded by the failing upstream node.
export async function publishReadyNode(_state: ProjectState): Promise<{
  execution: Partial<Execution>;
  diagnostics: Partial<Diagnostics>;
}> {
  return {
    execution: { currentNode: PUBLISH_READY },
    diagnostics: {},
  };
}
