import dns from "node:dns";
import net from "node:net";

/**
 * Network runtime for plain-JS entrypoints (.mjs scripts under scripts/).
 * Single source of truth with src/runtime/network.ts — same configuration,
 * no Google IP hard-coding. Import this before creating googleapis clients.
 */
export function configureNetworkRuntime() {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

export function getNetworkRuntimeState() {
  return {
    dnsResultOrder: dns.getDefaultResultOrder(),
    autoSelectFamily:
      typeof net.getDefaultAutoSelectFamily === "function"
        ? net.getDefaultAutoSelectFamily()
        : undefined,
    autoSelectFamilyAttemptTimeout:
      typeof net.getDefaultAutoSelectFamilyAttemptTimeout === "function"
        ? net.getDefaultAutoSelectFamilyAttemptTimeout()
        : undefined,
  };
}

// Configure on import so a bare `import "../src/runtime/network.mjs"`
// is sufficient for script entrypoints.
configureNetworkRuntime();
