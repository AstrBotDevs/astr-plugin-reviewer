import { jest, describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const {
  shouldContinueAfterDedupCheck,
  cleanupDedupMappingForClosedIssue,
} = await import("../reviewer/issue-dedup.js");

function createMockContext(issueNumber, repoUrl, existedIssueState = "open") {
  return {
    payload: {
      issue: {
        number: issueNumber,
        body: `\`\`\`json\n{"repo":"${repoUrl}"}\n\`\`\``,
      },
    },
    octokit: {
      issues: {
        get: jest.fn().mockResolvedValue({ data: { state: existedIssueState } }),
        createComment: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    },
    issue: jest.fn((params = {}) => ({
      owner: "repoowner",
      repo: "reponame",
      issue_number: issueNumber,
      ...params,
    })),
  };
}

function createMockLog() {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
  };
}

describe("issue-dedup integration (real LMDB via dedup entry)", () => {
  const log = createMockLog();
  const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const repoUrl = `https://github.com/integ-owner/integ-repo-${uniqueSuffix}`;
  const dataDir = path.join(process.cwd(), "data");

  it("creates lmdb files and records mapping on first issue", async () => {
    const context = createMockContext(101, repoUrl);
    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, "plugin-publish-imdb.lmdb"))
    ).toBe(true);
  });

  it("detects duplicate and closes as duplicate through dedup flow", async () => {
    const context = createMockContext(102, repoUrl, "open");
    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(false);
    expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Duplicate of #101" })
    );
    expect(context.octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed", state_reason: "not_planned" })
    );
  });

  it("allows new issue after closing the mapped issue", async () => {
    cleanupDedupMappingForClosedIssue(
      {
        number: 101,
        body: `\`\`\`json\n{"repo":"${repoUrl}"}\n\`\`\``,
      },
      log
    );

    const context = createMockContext(103, repoUrl);
    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(context.octokit.issues.createComment).not.toHaveBeenCalled();
  });
});
