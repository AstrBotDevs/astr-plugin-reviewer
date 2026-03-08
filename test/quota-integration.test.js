import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create a temp directory for the test database BEFORE importing quota.js,
// so the module-level TRIGGER_COUNT_DB_PATH picks up the env var.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-integ-"));
process.env.TRIGGER_COUNT_DB_DIR = tmpDir;

const {
  initializeTriggerCountDb,
  getReviewTriggerQuotaForIssue,
  markReviewTriggerSuccessForRepo,
} = await import("../reviewer/quota.js");

function makeIssueWithRepo(repoUrl) {
  return {
    body: `\`\`\`json\n{"repo": "${repoUrl}"}\n\`\`\``,
  };
}

describe("quota integration (real LMDB)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MAX_REVIEW_TRIGGERS_PER_REPO;
  });

  afterEach(() => {
    process.env.MAX_REVIEW_TRIGGERS_PER_REPO =
      originalEnv.MAX_REVIEW_TRIGGERS_PER_REPO;
  });

  // Initialize the real database once
  initializeTriggerCountDb();

  it("returns 0 used for a repo with no prior reviews", () => {
    const issue = makeIssueWithRepo("https://github.com/integ-test/fresh-repo");
    const quota = getReviewTriggerQuotaForIssue(issue);

    expect(quota).toMatchObject({
      allowed: true,
      repoKey: "integ-test/fresh-repo",
      max: 5,
      used: 0,
      remaining: 5,
    });
  });

  it("persists a single write and reads it back correctly", () => {
    const repoKey = "integ-test/write-read";
    const issue = makeIssueWithRepo(`https://github.com/${repoKey}`);

    // Before write
    const before = getReviewTriggerQuotaForIssue(issue);
    expect(before.used).toBe(0);

    // Write
    const writeResult = markReviewTriggerSuccessForRepo(repoKey);
    expect(writeResult.incremented).toBe(true);
    expect(writeResult.used).toBe(1);

    // Read back
    const after = getReviewTriggerQuotaForIssue(issue);
    expect(after.used).toBe(1);
    expect(after.remaining).toBe(4);
    expect(after.allowed).toBe(true);
  });

  it("accumulates multiple increments correctly", () => {
    const repoKey = "integ-test/multi-incr";
    const issue = makeIssueWithRepo(`https://github.com/${repoKey}`);

    markReviewTriggerSuccessForRepo(repoKey);
    markReviewTriggerSuccessForRepo(repoKey);
    markReviewTriggerSuccessForRepo(repoKey);

    const quota = getReviewTriggerQuotaForIssue(issue);
    expect(quota.used).toBe(3);
    expect(quota.remaining).toBe(2);
    expect(quota.allowed).toBe(true);
  });

  it("blocks reviews when quota is exhausted", () => {
    const repoKey = "integ-test/exhaust";
    const issue = makeIssueWithRepo(`https://github.com/${repoKey}`);

    for (let i = 0; i < 5; i++) {
      markReviewTriggerSuccessForRepo(repoKey);
    }

    const quota = getReviewTriggerQuotaForIssue(issue);
    expect(quota.used).toBe(5);
    expect(quota.remaining).toBe(0);
    expect(quota.allowed).toBe(false);
  });

  it("refuses to increment beyond the max limit", () => {
    const repoKey = "integ-test/over-limit";

    for (let i = 0; i < 5; i++) {
      markReviewTriggerSuccessForRepo(repoKey);
    }

    // 6th attempt
    const result = markReviewTriggerSuccessForRepo(repoKey);
    expect(result.incremented).toBe(false);
    expect(result.used).toBe(5);
    expect(result.remaining).toBe(0);

    // Count should still be 5, not 6
    const issue = makeIssueWithRepo(`https://github.com/${repoKey}`);
    const quota = getReviewTriggerQuotaForIssue(issue);
    expect(quota.used).toBe(5);
  });

  it("keeps independent quotas per repo", () => {
    const repoA = "integ-test/repo-a";
    const repoB = "integ-test/repo-b";

    markReviewTriggerSuccessForRepo(repoA);
    markReviewTriggerSuccessForRepo(repoA);
    markReviewTriggerSuccessForRepo(repoB);

    const quotaA = getReviewTriggerQuotaForIssue(
      makeIssueWithRepo(`https://github.com/${repoA}`)
    );
    const quotaB = getReviewTriggerQuotaForIssue(
      makeIssueWithRepo(`https://github.com/${repoB}`)
    );

    expect(quotaA.used).toBe(2);
    expect(quotaB.used).toBe(1);
  });

  it("respects custom MAX_REVIEW_TRIGGERS_PER_REPO", () => {
    process.env.MAX_REVIEW_TRIGGERS_PER_REPO = "3";
    const repoKey = "integ-test/custom-max";
    const issue = makeIssueWithRepo(`https://github.com/${repoKey}`);

    markReviewTriggerSuccessForRepo(repoKey);
    markReviewTriggerSuccessForRepo(repoKey);
    markReviewTriggerSuccessForRepo(repoKey);

    const quota = getReviewTriggerQuotaForIssue(issue);
    expect(quota.max).toBe(3);
    expect(quota.used).toBe(3);
    expect(quota.remaining).toBe(0);
    expect(quota.allowed).toBe(false);
  });

  it("correctly normalizes various URL formats and reads back the same key", () => {
    const repoKey = "integ-test/url-formats";
    markReviewTriggerSuccessForRepo(repoKey);

    // All these URL formats should resolve to the same repo key
    const urls = [
      "https://github.com/integ-test/url-formats",
      "https://github.com/integ-test/url-formats.git",
      "https://github.com/integ-test/url-formats/",
      "git+https://github.com/integ-test/url-formats",
      "git@github.com:integ-test/url-formats",
    ];

    for (const url of urls) {
      const quota = getReviewTriggerQuotaForIssue(makeIssueWithRepo(url));
      expect(quota).not.toBeNull();
      expect(quota.repoKey).toBe(repoKey);
      expect(quota.used).toBe(1);
    }
  });

  it("markReviewTriggerSuccessForRepo returns correct allowed flag at boundary", () => {
    const repoKey = "integ-test/boundary";

    // Increment to max-1 (4th)
    for (let i = 0; i < 4; i++) {
      const r = markReviewTriggerSuccessForRepo(repoKey);
      expect(r.incremented).toBe(true);
      expect(r.allowed).toBe(true); // still have room
    }

    // 5th increment: incremented but no longer allowed
    const fifth = markReviewTriggerSuccessForRepo(repoKey);
    expect(fifth.incremented).toBe(true);
    expect(fifth.used).toBe(5);
    expect(fifth.allowed).toBe(false);
    expect(fifth.remaining).toBe(0);
  });
});
