import { afterAll, describe, it, expect } from "@jest/globals";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateClaims,
  assertClaimsConfirmed,
  buildClaimsChecklist,
  claimNeedsSource,
  claimsChecklistProgress,
  ensureClaimsChecklist,
  suggestClaimQuery,
} from "../src/story/claims.js";
import { jobPaths } from "../src/story/paths.js";
import type { StoryClaim } from "../src/story/types.js";
import { isPipelineError } from "../src/utils/errors.js";

/**
 * The human claim checklist (episode-review follow-up): every claim gets one
 * unchecked box, a status, a suggested query, and `needsSource` for claims
 * about what a named person later did. `--confirm-claims` refuses to render
 * until every box is ticked.
 */

const ROOT = mkdtempSync(join(tmpdir(), "story-claims-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function claim(
  text: string,
  status: StoryClaim["status"] = "established",
): StoryClaim {
  return { claim: text, status, hedgeInNarration: false };
}

describe("claimNeedsSource", () => {
  it("flags what a named person did later", () => {
    expect(
      claimNeedsSource("Bligh later became governor of New South Wales."),
    ).toBe(true);
    expect(
      claimNeedsSource("Fletcher Christian later sailed to Pitcairn."),
    ).toBe(true);
  });

  it("does not flag a pronoun or an unnamed group", () => {
    expect(
      claimNeedsSource("He later returned to the Pacific with another ship."),
    ).toBe(false);
    expect(
      claimNeedsSource("The mutineers later burned the Bounty."),
    ).toBe(false);
  });

  it("does not flag an earlier event or a non-later sentence", () => {
    expect(claimNeedsSource("Bligh became governor in eighteen oh-six.")).toBe(
      false,
    );
    // A named person who later became something still needs a source.
    expect(
      claimNeedsSource("Bligh, later governor, faced a rebellion."),
    ).toBe(true);
  });
});

describe("suggestClaimQuery", () => {
  it("normalizes whitespace, quotes and the final stop", () => {
    expect(suggestClaimQuery('  “Bligh   later became governor.”  ')).toBe(
      "Bligh later became governor",
    );
  });

  it("truncates a long claim at a word boundary", () => {
    const query = suggestClaimQuery(`${"word ".repeat(60)}end.`);
    expect(query.length).toBeLessThanOrEqual(141);
    expect(query.endsWith("…")).toBe(true);
    expect(query).not.toContain("wor…");
  });
});

describe("annotateClaims", () => {
  it("derives needsSource and searchQuery for every claim", () => {
    const [derived] = annotateClaims([
      claim("Bligh later became governor.", "disputed"),
    ]);
    expect(derived.needsSource).toBe(true);
    expect(derived.searchQuery).toBe("Bligh later became governor");
    expect(derived.status).toBe("disputed");
  });

  it("overrides a model-provided annotation instead of trusting it", () => {
    const [derived] = annotateClaims([
      {
        ...claim("He later returned to the Pacific."),
        needsSource: true,
        searchQuery: "trust me",
      },
    ]);
    expect(derived.needsSource).toBe(false);
    expect(derived.searchQuery).toBe("He later returned to the Pacific");
  });
});

describe("buildClaimsChecklist", () => {
  it("writes one unchecked box per claim with status and query", () => {
    const markdown = buildClaimsChecklist([
      claim("Bligh later became governor.", "disputed"),
      claim("The Bounty carried breadfruit.", "established"),
    ]);

    expect(markdown).toContain("# Claims checklist");
    expect(markdown.match(/- \[ \] Checked/g)).toHaveLength(2);
    expect(markdown).toContain("- Status: `disputed`");
    expect(markdown).toContain("- Status: `established`");
    expect(markdown).toContain("- needsSource: true");
    expect(markdown).toContain("- needsSource: false");
    expect(markdown).toContain(
      "- Suggested search: `Bligh later became governor`",
    );
    expect(claimsChecklistProgress(markdown)).toEqual({
      total: 2,
      checked: 0,
      unchecked: 2,
    });
  });

  it("handles an empty ledger without inventing a box", () => {
    const markdown = buildClaimsChecklist([]);
    expect(markdown).toContain("returned no claims");
    expect(claimsChecklistProgress(markdown).total).toBe(0);
  });
});

describe("claimsChecklistProgress", () => {
  it("counts ticked and unticked boxes", () => {
    const markdown = [
      "- [ ] Checked",
      "- [x] Checked",
      "- [X] Checked",
      "- not a box",
    ].join("\n");
    expect(claimsChecklistProgress(markdown)).toEqual({
      total: 3,
      checked: 2,
      unchecked: 1,
    });
  });
});

describe("ensureClaimsChecklist", () => {
  it("writes a missing checklist and never overwrites existing ticks", async () => {
    const paths = jobPaths(join(ROOT, "ensure"));
    const claims = [claim("Bligh later became governor.")];

    await ensureClaimsChecklist(paths, claims);
    const first = readFileSync(paths.claimsChecklist, "utf8");
    expect(claimsChecklistProgress(first).unchecked).toBe(1);

    writeFileSync(paths.claimsChecklist, first.replace("- [ ]", "- [x]"));
    await ensureClaimsChecklist(paths, claims);
    const second = readFileSync(paths.claimsChecklist, "utf8");
    expect(claimsChecklistProgress(second).checked).toBe(1);
  });
});

describe("assertClaimsConfirmed", () => {
  async function errorFor(paths: ReturnType<typeof jobPaths>) {
    try {
      await assertClaimsConfirmed(paths);
    } catch (error) {
      return error;
    }
    throw new Error("expected assertClaimsConfirmed to throw");
  }

  it("refuses when the checklist is missing", async () => {
    const paths = jobPaths(join(ROOT, "missing"));
    const error = await errorFor(paths);
    expect(isPipelineError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("STORY_CLAIMS_UNCONFIRMED");
    expect((error as Error).message).toContain("missing");
  });

  it("refuses when the checklist has no claim boxes", async () => {
    const paths = jobPaths(join(ROOT, "empty"));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.claimsChecklist, "# Claims checklist\n\nnothing\n");
    const error = await errorFor(paths);
    expect((error as Error).message).toContain("no claim checkboxes");
  });

  it("refuses while any box is unticked and names the count", async () => {
    const paths = jobPaths(join(ROOT, "unchecked"));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.claimsChecklist,
      buildClaimsChecklist([
        claim("One."),
        claim("Two."),
        claim("Three."),
      ]).replace("- [ ]", "- [x]"),
    );
    const error = await errorFor(paths);
    expect((error as Error).message).toContain("2 of 3 claim(s)");
  });

  it("passes once every box is ticked", async () => {
    const paths = jobPaths(join(ROOT, "checked"));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.claimsChecklist,
      buildClaimsChecklist([claim("One."), claim("Two.")]).replaceAll(
        "- [ ]",
        "- [x]",
      ),
    );
    await expect(assertClaimsConfirmed(paths)).resolves.toBeUndefined();
  });
});
