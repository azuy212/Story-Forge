import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_BRANDING,
  resolveBranding,
  resolveBrandingAssetPath,
} from "../src/utils/branding.js";

describe("branding configuration", () => {
  it("defaults to official channel identity and canonical outro", () => {
    const branding = resolveBranding();

    expect(branding.channel).toBe("Universe Decoded by Zain");
    expect(branding.handle).toBe("@UniverseDecodedByZain");
    expect(branding.creator).toBe("Ali Zain");
    expect(branding.enabled).toBe(true);
    expect(branding.outroAsset).toBe("assets/branding/outro.mp4");
    expect(branding.ctaEnabled).toBe(true);
    expect(branding.outroContainsCta).toBe(false);
  });

  it("allows branding to be disabled without changing CTA text", () => {
    const branding = resolveBranding({ enabled: false, cta: "Follow now." });

    expect(branding.enabled).toBe(false);
    expect(branding.outroCta).toBe("Follow now.");
  });

  it("does not assume custom outro assets contain a CTA", () => {
    expect(
      resolveBranding({ outroAsset: "assets/custom/outro.mp4" })
        .outroContainsCta,
    ).toBe(false);
    expect(
      resolveBranding({
        outroAsset: "assets/custom/outro.mp4",
        outroContainsCta: true,
      }).outroContainsCta,
    ).toBe(true);
  });

  it("resolves configured outro without absolute developer paths", () => {
    const resolved = resolveBrandingAssetPath(DEFAULT_BRANDING.outroAsset);

    expect(resolved).toContain("assets/branding/outro.mp4");
    expect(resolved).toMatch(/^\//);
    expect(() =>
      resolveBrandingAssetPath("/Users/developer/outro.mp4"),
    ).toThrow("relative repository path");
  });
});
