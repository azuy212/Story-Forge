import { configureNetworkRuntime } from "./network.js";

// Side-effect bootstrap: configuring on import so the first consumer import
// locks socket-family selection before any later googleapis / gaxios request.
configureNetworkRuntime();

export { configureNetworkRuntime, getNetworkRuntimeState } from "./network.js";
