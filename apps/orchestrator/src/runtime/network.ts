import dns from "node:dns";
import net from "node:net";

/**
 * Centralized network-runtime configuration for the orchestrator.
 *
 * This machine has no working IPv6 route. Node's default dual-stack
 * Happy Eyeballs auto-selection (`autoSelectFamily`) can still race an
 * IPv6 connect and surface a bare ETIMEDOUT against Google OAuth
 * (`oauth2.googleapis.com` has a single A + AAAA). DNS ordering alone
 * (`ipv4first`) is not enough — the failure is in the connect race.
 *
 * Force IPv4-only socket selection + IPv4-first DNS here, once, before
 * any googleapis / google-auth-library client issues a request.
 * Do not hard-code Google IPs; do not set NODE_OPTIONS as the only fix.
 */
export function configureNetworkRuntime(): void {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

export interface NetworkRuntimeState {
  dnsResultOrder: string;
  autoSelectFamily: boolean | undefined;
  autoSelectFamilyAttemptTimeout: number | undefined;
}

export function getNetworkRuntimeState(): NetworkRuntimeState {
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
