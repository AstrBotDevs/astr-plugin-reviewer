import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockDb = {
  get: jest.fn(),
  putSync: jest.fn(),
  transactionSync: jest.fn((fn) => fn()),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule("lmdb", () => ({
  open: jest.fn(() => mockDb),
}));

const {
  initializeTriggerCountDb,
  getReviewTriggerQuotaForIssue,
  markReviewTriggerSuccessForRepo,
} = await import("../reviewer/quota.js");

// Initialize once so triggerCountDb is set for all tests
initializeTriggerCountDb();

describe("quota", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockReturnValue(undefined);
    mockDb.transactionSync.mockImplementation((fn) => fn());
    process.env = { ...originalEnv };
    delete process.env.MAX_REVIEW_TRIGGERS_PER_REPO;
  });

  describe("getReviewTriggerQuotaForIssue", () => {
    it("returns quota info for valid GitHub repo URL", () => {
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({
        allowed: true,
        repoKey: "owner/repo",
        max: 5,
        used: 0,
        remaining: 5,
      });
    });

    it("returns null when issue body has no JSON block", () => {
      const issue = { body: "no json here" };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toBeNull();
    });

    it("returns null when JSON has no repo field", () => {
      const issue = {
        body: '```json\n{"name": "test"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toBeNull();
    });

    it("returns null for non-GitHub repo URL", () => {
      const issue = {
        body: '```json\n{"repo": "https://gitlab.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toBeNull();
    });

    it("returns null for empty body", () => {
      const result = getReviewTriggerQuotaForIssue({ body: "" });
      expect(result).toBeNull();
    });

    it("returns null for null issue", () => {
      const result = getReviewTriggerQuotaForIssue(null);
      expect(result).toBeNull();
    });

    it("handles repo URL with trailing .git", () => {
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo.git"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ repoKey: "owner/repo" });
    });

    it("handles repo URL with trailing slash", () => {
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo/"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ repoKey: "owner/repo" });
    });

    it("handles git@ SSH URL format", () => {
      const issue = {
        body: '```json\n{"repo": "git@github.com:owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ repoKey: "owner/repo" });
    });

    it("handles git+ prefix URL format", () => {
      const issue = {
        body: '```json\n{"repo": "git+https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ repoKey: "owner/repo" });
    });

    it("reflects used count from database", () => {
      mockDb.get.mockReturnValue(3);
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({
        allowed: true,
        used: 3,
        remaining: 2,
      });
    });

    it("disallows when quota is exhausted", () => {
      mockDb.get.mockReturnValue(5);
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({
        allowed: false,
        used: 5,
        remaining: 0,
      });
    });

    it("respects MAX_REVIEW_TRIGGERS_PER_REPO env var", () => {
      process.env.MAX_REVIEW_TRIGGERS_PER_REPO = "10";
      const issue = {
        body: '```json\n{"repo": "https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ max: 10, remaining: 10 });
    });

    it("falls back to malformed JSON regex extraction", () => {
      const issue = {
        body: '```json\n{bad json, "repo": "https://github.com/owner/repo"}\n```',
      };
      const result = getReviewTriggerQuotaForIssue(issue);
      expect(result).toMatchObject({ repoKey: "owner/repo" });
    });
  });

  describe("markReviewTriggerSuccessForRepo", () => {
    it("increments count and returns updated quota", () => {
      mockDb.get.mockReturnValue(0);
      const result = markReviewTriggerSuccessForRepo("owner/repo");
      expect(result).toMatchObject({
        incremented: true,
        allowed: true,
        repoKey: "owner/repo",
        used: 1,
        remaining: 4,
      });
      expect(mockDb.putSync).toHaveBeenCalledWith("owner/repo", 1);
    });

    it("returns not allowed when reaching max", () => {
      mockDb.get.mockReturnValue(4);
      const result = markReviewTriggerSuccessForRepo("owner/repo");
      expect(result).toMatchObject({
        incremented: true,
        allowed: false,
        used: 5,
        remaining: 0,
      });
    });

    it("does not increment when already at max", () => {
      mockDb.get.mockReturnValue(5);
      const result = markReviewTriggerSuccessForRepo("owner/repo");
      expect(result).toMatchObject({
        incremented: false,
        allowed: false,
        used: 5,
        remaining: 0,
      });
      expect(mockDb.putSync).not.toHaveBeenCalled();
    });

    it("returns null for null repoKey", () => {
      const result = markReviewTriggerSuccessForRepo(null);
      expect(result).toBeNull();
    });

    it("returns null for empty repoKey", () => {
      const result = markReviewTriggerSuccessForRepo("");
      expect(result).toBeNull();
    });
  });
});
