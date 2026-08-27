import fs from "node:fs";
import path from "node:path";
import type { Branding, VideoProfile } from "../types/index.js";

const FALLBACK_BRANDING = {
  channel: "Universe Decoded by Zain",
  creator: "Ali Zain",
  cta: "Follow for more mysteries of the universe.",
  handle: "@UniverseDecodedByZain",
  enabled: true,
  outroAsset: "assets/branding/outro.mp4",
  outroLongAsset: "assets/branding/outro-long.mp4",
  ctaEnabled: true,
  outroCta: "Follow for more mysteries of the universe.",
  outroContainsCta: false,
} satisfies Branding;

function loadBrandingFile(): Partial<Branding> {
  let directory = path.resolve(process.cwd());
  for (;;) {
    const configPaths = [
      path.join(directory, "branding", "brand.json"),
      path.join(directory, "apps", "orchestrator", "branding", "brand.json"),
    ];
    const configPath = configPaths.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (configPath) {
      return JSON.parse(
        fs.readFileSync(configPath, "utf8"),
      ) as Partial<Branding>;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return {};
}

export const DEFAULT_BRANDING = {
  ...FALLBACK_BRANDING,
  ...loadBrandingFile(),
} satisfies Branding;

export type ResolvedBranding = Branding &
  Required<
    Pick<
      Branding,
      | "handle"
      | "enabled"
      | "outroAsset"
      | "outroLongAsset"
      | "ctaEnabled"
      | "outroCta"
      | "outroContainsCta"
    >
  >;

export function resolveBranding(
  branding?: Partial<Branding>,
): ResolvedBranding {
  const configuredCta =
    branding?.outroCta && branding.outroCta !== DEFAULT_BRANDING.outroCta
      ? branding.outroCta
      : branding?.cta || branding?.outroCta || DEFAULT_BRANDING.outroCta;
  const outroContainsCta =
    branding?.outroContainsCta ?? DEFAULT_BRANDING.outroContainsCta;
  return {
    ...DEFAULT_BRANDING,
    ...branding,
    channel: branding?.channel ?? DEFAULT_BRANDING.channel,
    creator: branding?.creator ?? DEFAULT_BRANDING.creator,
    cta: configuredCta,
    handle: branding?.handle ?? DEFAULT_BRANDING.handle,
    enabled: branding?.enabled ?? DEFAULT_BRANDING.enabled,
    outroAsset: branding?.outroAsset ?? DEFAULT_BRANDING.outroAsset,
    outroLongAsset: branding?.outroLongAsset ?? DEFAULT_BRANDING.outroLongAsset,
    ctaEnabled: branding?.ctaEnabled ?? DEFAULT_BRANDING.ctaEnabled,
    outroCta: configuredCta,
    outroContainsCta,
  };
}

/**
 * Pick the outro asset path appropriate for the given video profile. Long-form
 * (16:9) videos get the dedicated outro when one is configured; everything else
 * uses the short outro. Falls back to the short asset when the long variant is
 * unset so partial config never breaks compilation.
 */
export function selectOutroAssetForProfile(
  branding: Pick<ResolvedBranding, "outroAsset" | "outroLongAsset">,
  profile: VideoProfile,
): string {
  if (profile === "long" && branding.outroLongAsset) {
    return branding.outroLongAsset;
  }
  return branding.outroAsset;
}

/**
 * Resolve repository assets from configured relative paths. Search starts at
 * process cwd and walks parents, so package-owned config works from both the
 * orchestrator package and workspace root without embedding machine paths.
 */
export function resolveBrandingAssetPath(asset: string): string {
  if (path.isAbsolute(asset)) {
    throw new Error(
      `Branding asset must use a relative repository path, received: ${asset}`,
    );
  }

  let directory = path.resolve(process.cwd());
  for (;;) {
    const candidate = path.resolve(directory, asset);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    `Branding outro asset not found: ${asset}. Resolve relative to repository/package config root.`,
  );
}
