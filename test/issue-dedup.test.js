import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../reviewer/quota.js", () => ({
  getPluginRepoKeyFromIssue: jest.fn(),
}));

const mockDb = {
  getIssueIdForRepo: jest.fn(),
  markIssueForRepo: jest.fn(),
  removeIssueForRepoIfMatch: jest.fn(),
};

jest.unstable_mockModule("lmdb", () => ({
  open: jest.fn(() => ({
    get: mockDb.getIssueIdForRepo,
    putSync: mockDb.markIssueForRepo,
    removeSync: mockDb.removeIssueForRepoIfMatch,
    transactionSync: jest.fn((fn) => fn()),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

const {
  shouldContinueAfterDedupCheck,
  cleanupDedupMappingForClosedIssue,
  initializeImdb,
} = await import("../reviewer/issue-dedup.js");
const { getPluginRepoKeyFromIssue } = await import("../reviewer/quota.js");

function createMockContext(issueOverrides = {}) {
  return {
    payload: {
      issue: {
        number: 1,
        body: "some body",
        ...issueOverrides,
      },
    },
    octokit: {
      issues: {
        get: jest.fn().mockResolvedValue({ data: { state: "open" } }),
        createComment: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    },
    issue: jest.fn((params = {}) => ({
      owner: "repoowner",
      repo: "reponame",
      issue_number: issueOverrides.number || 1,
      ...params,
    })),
  };
}

function createMockLog() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  };
}

describe("issue dedup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    initializeImdb();
    getPluginRepoKeyFromIssue.mockReturnValue("owner/repo");
    mockDb.getIssueIdForRepo.mockReturnValue(null);
    mockDb.removeIssueForRepoIfMatch.mockReturnValue(true);
  });

  it("continues when repo key cannot be parsed", async () => {
    getPluginRepoKeyFromIssue.mockReturnValue(null);
    const context = createMockContext();
    const log = createMockLog();

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(mockDb.markIssueForRepo).not.toHaveBeenCalled();
  });

  it("records mapping and continues when no existing issue", async () => {
    const context = createMockContext({ number: 8 });
    const log = createMockLog();

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(mockDb.markIssueForRepo).toHaveBeenCalledWith("owner/repo", 8);
  });

  it("continues when existing issue id equals current issue", async () => {
    mockDb.getIssueIdForRepo.mockReturnValue(8);
    const context = createMockContext({ number: 8 });
    const log = createMockLog();

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(context.octokit.issues.get).not.toHaveBeenCalled();
  });

  it("closes as duplicate when existing issue is still open", async () => {
    mockDb.getIssueIdForRepo.mockReturnValue(7);
    const context = createMockContext({ number: 10 });
    const log = createMockLog();

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(false);
    expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Duplicate of #7" })
    );
    expect(context.octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed", state_reason: "not_planned" })
    );
  });

  it("replaces stale mapping when existing issue is closed", async () => {
    mockDb.getIssueIdForRepo.mockReturnValue(3);
    const context = createMockContext({ number: 9 });
    const log = createMockLog();
    context.octokit.issues.get.mockResolvedValue({ data: { state: "closed" } });

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(mockDb.removeIssueForRepoIfMatch).toHaveBeenCalledWith("owner/repo");
    expect(mockDb.markIssueForRepo).toHaveBeenCalledWith("owner/repo", 9);
  });

  it("replaces stale mapping when existing issue is missing", async () => {
    mockDb.getIssueIdForRepo.mockReturnValue(3);
    const context = createMockContext({ number: 9 });
    const log = createMockLog();
    const notFoundError = new Error("Not Found");
    notFoundError.status = 404;
    context.octokit.issues.get.mockRejectedValue(notFoundError);

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(mockDb.removeIssueForRepoIfMatch).toHaveBeenCalledWith("owner/repo");
    expect(mockDb.markIssueForRepo).toHaveBeenCalledWith("owner/repo", 9);
  });

  it("continues when existing issue lookup fails with non-404", async () => {
    mockDb.getIssueIdForRepo.mockReturnValue(3);
    const context = createMockContext({ number: 9 });
    const log = createMockLog();
    context.octokit.issues.get.mockRejectedValue(new Error("API down"));

    const shouldContinue = await shouldContinueAfterDedupCheck(context, log);

    expect(shouldContinue).toBe(true);
    expect(mockDb.markIssueForRepo).not.toHaveBeenCalled();
  });

  it("cleans up mapping for closed issue", () => {
    mockDb.getIssueIdForRepo.mockReturnValue(12);
    const log = createMockLog();

    cleanupDedupMappingForClosedIssue({ number: 12, body: "some body" }, log);

    expect(mockDb.removeIssueForRepoIfMatch).toHaveBeenCalledWith("owner/repo");
  });

  it("skips cleanup when repo key is missing", () => {
    getPluginRepoKeyFromIssue.mockReturnValue(null);
    const log = createMockLog();

    cleanupDedupMappingForClosedIssue({ number: 12, body: "some body" }, log);

    expect(mockDb.removeIssueForRepoIfMatch).not.toHaveBeenCalled();
  });
});
