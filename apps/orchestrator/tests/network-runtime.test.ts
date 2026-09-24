import dns from "node:dns";
import net from "node:net";

import {
  configureNetworkRuntime,
  getNetworkRuntimeState,
} from "../src/runtime/network.js";

describe("network runtime", () => {
  it("forces IPv4-first DNS and disables Happy Eyeballs auto-select", () => {
    configureNetworkRuntime();

    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
  });

  it("reports runtime state without secrets", () => {
    configureNetworkRuntime();
    const state = getNetworkRuntimeState();

    expect(state.dnsResultOrder).toBe("ipv4first");
    expect(state.autoSelectFamily).toBe(false);
    expect(typeof state.autoSelectFamilyAttemptTimeout).toBe("number");
  });

  it("is idempotent when called twice", () => {
    configureNetworkRuntime();
    configureNetworkRuntime();

    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
  });
});
