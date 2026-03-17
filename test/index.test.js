import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../reviewer/config.js", () => ({
  validateEnvironment: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/issue-dedup.js", () => ({
  shouldContinueAfterDedupCheck: jest.fn(),
  cleanupDedupMappingForClosedIssue: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/comments.js", () => ({
  findLastReviewComment: jest.fn(),
  postOrUpdateComment: jest.fn(),
  postSystemErrorComment: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/review-flow.js", () => ({
  handlePluginReview: jest.fn(),
}));

const app = (await import("../index.js")).default;

const { validateEnvironment } = await import("../reviewer/config.js");
const {
  shouldContinueAfterDedupCheck,
  cleanupDedupMappingForClosedIssue,
} = await import("../reviewer/issue-dedup.js");
const { findLastReviewComment, postOrUpdateComment, postSystemErrorComment } = await import(
  "../reviewer/comments.js"
);
const { handlePluginReview } = await import("../reviewer/review-flow.js");

function createMockApp() {
  const handlers = {};
  const mockApp = {
    on: jest.fn((events, handler) => {
      const eventList = Array.isArray(events) ? events : [events];
      for (const event of eventList) {
        handlers[event] = handler;
      }
    }),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
  };
  return { mockApp, handlers };
}

function createMockContext(payload) {
  return {
    payload: {
      repository: { full_name: "AstrBotDevs/AstrBot" },
      ...payload,
    },
    octokit: {
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({ data: { state: "open" } }),
        update: jest.fn().mockResolvedValue({}),
      },
    },
    issue: jest.fn((params = {}) => ({
      owner: "repoowner",
      repo: "reponame",
      issue_number: payload.issue?.number || 1,
      ...params,
    })),
  };
}

describe("index (app entry point)", () => {
  let handlers;

  beforeEach(() => {
    jest.clearAllMocks();
    shouldContinueAfterDedupCheck.mockResolvedValue(true);
    const result = createMockApp();
    handlers = result.handlers;
    app(result.mockApp);
  });

  it("calls validateEnvironment on setup", () => {
    expect(validateEnvironment).toHaveBeenCalledTimes(1);
  });

  it("registers handlers for correct events", () => {
    expect(handlers["issues.opened"]).toBeDefined();
    expect(handlers["issues.edited"]).toBeDefined();
    expect(handlers["issues.closed"]).toBeDefined();
    expect(handlers["issue_comment.created"]).toBeDefined();
  });

  describe("issues.opened handler", () => {
    it("calls handlePluginReview for issue with plugin-publish label", async () => {
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).toHaveBeenCalledWith(context, false, null);
    });

    it("runs dedup check for opened plugin-publish issues", async () => {
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(shouldContinueAfterDedupCheck).toHaveBeenCalledWith(
        context,
        expect.any(Object)
      );
    });

    it("skips review when dedup check returns false", async () => {
      shouldContinueAfterDedupCheck.mockResolvedValue(false);
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 10,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips issues without plugin-publish label", async () => {
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "bug" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips issues with no labels", async () => {
      const context = createMockContext({
        action: "opened",
        issue: { number: 1, labels: [], body: "some body" },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("calls postSystemErrorComment when handlePluginReview throws", async () => {
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });
      const error = new Error("Unexpected error");
      handlePluginReview.mockRejectedValue(error);

      await handlers["issues.opened"](context);

      expect(postSystemErrorComment).toHaveBeenCalledWith(context, error);
    });

    it("calls postSystemErrorComment when dedup check throws", async () => {
      const context = createMockContext({
        action: "opened",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });
      const error = new Error("Dedup check failed");
      shouldContinueAfterDedupCheck.mockRejectedValue(error);

      await handlers["issues.opened"](context);

      expect(postSystemErrorComment).toHaveBeenCalledWith(context, error);
      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("posts uninstall notice and skips review on unsupported repository", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "opened",
        repository: { full_name: "someone/other" },
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
      expect(postOrUpdateComment).toHaveBeenCalledWith(
        context,
        "unsupported_repository",
        expect.objectContaining({
          repositoryFullName: "someone/other",
          supportedRepositoryFullName: "AstrBotDevs/AstrBot",
        }),
        false,
        null
      );
    });

    it("posts uninstall notice on unsupported repository even without plugin-publish label", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "opened",
        repository: { full_name: "someone/other" },
        issue: {
          number: 1,
          labels: [{ name: "bug" }],
          body: "some body",
        },
      });

      await handlers["issues.opened"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
      expect(postOrUpdateComment).toHaveBeenCalledWith(
        context,
        "unsupported_repository",
        expect.objectContaining({
          repositoryFullName: "someone/other",
          supportedRepositoryFullName: "AstrBotDevs/AstrBot",
        }),
        false,
        null
      );
    });
  });

  describe("issues.edited handler", () => {
    it("skips when no last review comment exists", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "- [x] 重新提交审核",
        },
      });

      await handlers["issues.edited"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips when last comment is a success report", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## 🤖 AI代码审核报告 for Test\n...",
      });
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "- [x] 重新提交审核",
        },
      });

      await handlers["issues.edited"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips when review is in progress", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## ⏳ 正在审核中...",
      });
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "- [x] 重新提交审核",
        },
      });

      await handlers["issues.edited"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips when re-review checkbox is not checked", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## ⚠️ 格式错误\n...",
      });
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "- [ ] 重新提交审核",
        },
      });

      await handlers["issues.edited"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("calls handlePluginReview when re-review checkbox is checked", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## ⚠️ 格式错误\n...",
      });
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "- [x] 重新提交审核",
        },
      });

      await handlers["issues.edited"](context);

      expect(context.octokit.issues.update).toHaveBeenCalled();
      expect(handlePluginReview).toHaveBeenCalledWith(context, true, 10);
    });

    it("unchecks re-review checkbox before calling handlePluginReview", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## ⚠️ 格式错误\n...",
      });
      const context = createMockContext({
        action: "edited",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
          body: "some content\n- [x] 重新提交审核\nmore content",
        },
      });

      await handlers["issues.edited"](context);

      const updateCall = context.octokit.issues.update.mock.calls[0][0];
      expect(updateCall.body).toContain("- [ ] 重新提交审核");
      expect(updateCall.body).not.toMatch(/\[x\]\s*重新提交审核/);
    });
  });

  describe("issues.closed handler", () => {
    it("calls dedup cleanup for plugin-publish issues", async () => {
      const context = createMockContext({
        action: "closed",
        issue: {
          number: 12,
          labels: [{ name: "plugin-publish" }],
          body: "some body",
        },
      });

      await handlers["issues.closed"](context);

      expect(cleanupDedupMappingForClosedIssue).toHaveBeenCalledWith(
        context.payload.issue,
        expect.any(Object)
      );
    });

    it("skips cleanup without plugin-publish label", async () => {
      const context = createMockContext({
        action: "closed",
        issue: {
          number: 12,
          labels: [{ name: "bug" }],
          body: "some body",
        },
      });

      await handlers["issues.closed"](context);

      expect(cleanupDedupMappingForClosedIssue).not.toHaveBeenCalled();
    });
  });

  describe("issue_comment.created handler", () => {
    it("calls handlePluginReview for @astrpluginreviewer review command", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).toHaveBeenCalledWith(context, false, null);
    });

    it("skips issues without plugin-publish label", async () => {
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "bug" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips when review is already in progress", async () => {
      findLastReviewComment.mockResolvedValue({
        id: 10,
        body: "## ⏳ 正在审核中...",
      });
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips comments from bots", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "bot", type: "Bot" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("skips comments without review command", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "Just a regular comment",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
    });

    it("is case-insensitive for review command", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@AstrPluginReviewer Review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).toHaveBeenCalled();
    });

    it("calls postSystemErrorComment on handlePluginReview error", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const error = new Error("Review crashed");
      handlePluginReview.mockRejectedValue(error);
      const context = createMockContext({
        action: "created",
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(postSystemErrorComment).toHaveBeenCalledWith(context, error);
    });

    it("posts uninstall notice and skips review command on unsupported repository", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        repository: { full_name: "someone/other" },
        issue: {
          number: 1,
          labels: [{ name: "plugin-publish" }],
        },
        comment: {
          id: 50,
          body: "@astrpluginreviewer review",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
      expect(postOrUpdateComment).toHaveBeenCalledWith(
        context,
        "unsupported_repository",
        expect.objectContaining({
          repositoryFullName: "someone/other",
          supportedRepositoryFullName: "AstrBotDevs/AstrBot",
        }),
        false,
        null
      );
    });

    it("posts uninstall notice on unsupported repository even without plugin-publish label", async () => {
      findLastReviewComment.mockResolvedValue(null);
      const context = createMockContext({
        action: "created",
        repository: { full_name: "someone/other" },
        issue: {
          number: 1,
          labels: [{ name: "bug" }],
        },
        comment: {
          id: 50,
          body: "just a normal comment",
          user: { login: "testuser", type: "User" },
        },
      });

      await handlers["issue_comment.created"](context);

      expect(handlePluginReview).not.toHaveBeenCalled();
      expect(postOrUpdateComment).toHaveBeenCalledWith(
        context,
        "unsupported_repository",
        expect.objectContaining({
          repositoryFullName: "someone/other",
          supportedRepositoryFullName: "AstrBotDevs/AstrBot",
        }),
        false,
        null
      );
    });
  });
});
