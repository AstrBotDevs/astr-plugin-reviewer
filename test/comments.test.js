import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  findLastReviewComment,
  postOrUpdateComment,
  postSystemErrorComment,
} from "../reviewer/comments.js";

function createMockContext(payloadOverrides = {}, octokitOverrides = {}) {
  const mockOctokit = {
    issues: {
      listComments: jest.fn().mockResolvedValue({ data: [] }),
      createComment: jest
        .fn()
        .mockResolvedValue({ data: { id: 42 } }),
      updateComment: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      ...octokitOverrides,
    },
  };

  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
    payload: {
      issue: {
        number: 1,
        body: "issue body",
        ...payloadOverrides.issue,
      },
      repository: {
        owner: { login: "repoowner" },
        name: "reponame",
      },
      ...payloadOverrides,
    },
    octokit: mockOctokit,
    issue: jest.fn((params = {}) => ({
      owner: "repoowner",
      repo: "reponame",
      issue_number: 1,
      ...params,
    })),
  };
}

describe("findLastReviewComment", () => {
  it("returns the last bot review comment", async () => {
    const reviewComment = {
      id: 10,
      user: { type: "Bot" },
      body: "## ⚠️ 插件提交格式错误\n...",
    };
    const context = createMockContext({}, {
      listComments: jest.fn().mockResolvedValue({
        data: [
          { id: 1, user: { type: "User" }, body: "some comment" },
          reviewComment,
        ],
      }),
    });
    const result = await findLastReviewComment(context);
    expect(result).toEqual(reviewComment);
  });

  it("returns null when no comments exist", async () => {
    const context = createMockContext();
    const result = await findLastReviewComment(context);
    expect(result).toBeNull();
  });

  it("returns null when no bot review comments exist", async () => {
    const context = createMockContext({}, {
      listComments: jest.fn().mockResolvedValue({
        data: [
          { id: 1, user: { type: "User" }, body: "user comment" },
          { id: 2, user: { type: "Bot" }, body: "unrelated bot comment" },
        ],
      }),
    });
    const result = await findLastReviewComment(context);
    expect(result).toBeNull();
  });

  it("matches review started comment (⏳)", async () => {
    const comment = {
      id: 5,
      user: { type: "Bot" },
      body: "## ⏳ 正在审核中...",
    };
    const context = createMockContext({}, {
      listComments: jest.fn().mockResolvedValue({ data: [comment] }),
    });
    const result = await findLastReviewComment(context);
    expect(result).toEqual(comment);
  });

  it("matches review success comment (🤖)", async () => {
    const comment = {
      id: 6,
      user: { type: "Bot" },
      body: "## 🤖 AI代码审核报告 for TestPlugin\n...",
    };
    const context = createMockContext({}, {
      listComments: jest.fn().mockResolvedValue({ data: [comment] }),
    });
    const result = await findLastReviewComment(context);
    expect(result).toEqual(comment);
  });

  it("matches review failure comment (❌)", async () => {
    const comment = {
      id: 7,
      user: { type: "Bot" },
      body: "## ❌ 插件审核失败\n...",
    };
    const context = createMockContext({}, {
      listComments: jest.fn().mockResolvedValue({ data: [comment] }),
    });
    const result = await findLastReviewComment(context);
    expect(result).toEqual(comment);
  });

  it("returns null on API error", async () => {
    const context = createMockContext({}, {
      listComments: jest.fn().mockRejectedValue(new Error("API error")),
    });
    const result = await findLastReviewComment(context);
    expect(result).toBeNull();
  });
});

describe("postOrUpdateComment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a new comment for review_started", async () => {
    const context = createMockContext();
    const id = await postOrUpdateComment(
      context,
      "review_started",
      {},
      false,
      null
    );
    expect(id).toBe(42);
    expect(context.octokit.issues.createComment).toHaveBeenCalledTimes(1);
    const call = context.octokit.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("⏳ 正在审核中");
  });

  it("updates an existing comment when isUpdate is true", async () => {
    const context = createMockContext();
    const id = await postOrUpdateComment(
      context,
      "review_started",
      {},
      true,
      99
    );
    expect(id).toBe(99);
    expect(context.octokit.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 })
    );
    expect(context.octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("includes errors in format_error comment", async () => {
    const context = createMockContext();
    const id = await postOrUpdateComment(
      context,
      "format_error",
      { errors: ["Error 1", "Error 2"] },
      false,
      null
    );
    expect(id).toBe(42);
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("⚠️ 插件提交格式错误");
    expect(body).toContain("- Error 1");
    expect(body).toContain("- Error 2");
  });

  it("includes error message in review_failure comment", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "review_failure",
      { error: "Something went wrong" },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("❌ 插件审核失败");
    expect(body).toContain("Something went wrong");
  });

  it("includes plugin name and review in review_success comment", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "review_success",
      {
        pluginData: { name: "MyPlugin" },
        review: "Code looks good overall.",
      },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("🤖 AI代码审核报告 for MyPlugin");
    expect(body).toContain("Code looks good overall.");
  });

  it("includes quota info in review_limit_reached comment", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "review_limit_reached",
      {
        quotaInfo: { repoKey: "owner/repo", max: 5, remaining: 0 },
      },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("⚠️ 仓库触发次数已达上限");
    expect(body).toContain("owner/repo");
    expect(body).toContain("5 次");
  });

  it("includes uninstall notice in unsupported_repository comment", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "unsupported_repository",
      {
        repositoryFullName: "foo/bar",
        supportedRepositoryFullName: "AstrBotDevs/AstrBot",
      },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("当前仓库不受支持");
    expect(body).toContain("foo/bar");
    expect(body).toContain("AstrBotDevs/AstrBot");
    expect(body).toContain("卸载此 GitHub App");
  });

  it("appends quota hint to footer", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "review_started",
      { quotaInfo: { repoKey: "owner/repo", remaining: 3 } },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("当前仓库：`owner/repo`");
    expect(body).toContain("剩余触发次数：**3**");
  });

  it("does not append quota hint when quotaInfo is null", async () => {
    const context = createMockContext();
    await postOrUpdateComment(
      context,
      "review_started",
      { quotaInfo: null },
      false,
      null
    );
    const body = context.octokit.issues.createComment.mock.calls[0][0].body;
    expect(body).not.toContain("剩余触发次数");
  });

  it("returns null for unknown comment type", async () => {
    const context = createMockContext();
    const id = await postOrUpdateComment(
      context,
      "unknown_type",
      {},
      false,
      null
    );
    expect(id).toBeNull();
    expect(context.octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("returns null on API error", async () => {
    const context = createMockContext({}, {
      createComment: jest.fn().mockRejectedValue(new Error("API error")),
    });
    const id = await postOrUpdateComment(
      context,
      "review_started",
      {},
      false,
      null
    );
    expect(id).toBeNull();
  });

  it("adds re-review checkbox on format_error", async () => {
    const context = createMockContext({
      issue: { number: 1, body: "original body" },
    });
    await postOrUpdateComment(
      context,
      "format_error",
      { errors: ["err"] },
      false,
      null
    );
    expect(context.octokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("重新提交审核"),
      })
    );
  });

  it("removes re-review section on review_success", async () => {
    const bodyWithSection =
      "original body\n\n## 审核选项\n\n- [ ] 重新提交审核";
    const context = createMockContext({
      issue: { number: 1, body: bodyWithSection },
    });
    await postOrUpdateComment(
      context,
      "review_success",
      { pluginData: { name: "Test" }, review: "ok" },
      false,
      null
    );
    const updateCall = context.octokit.issues.update.mock.calls[0][0];
    expect(updateCall.body).not.toContain("审核选项");
    expect(updateCall.body).not.toContain("重新提交审核");
  });
});

describe("postSystemErrorComment", () => {
  it("posts a system error comment", async () => {
    const context = createMockContext();
    await postSystemErrorComment(context, new Error("Unexpected failure"));
    expect(context.octokit.issues.createComment).toHaveBeenCalledTimes(1);
    const call = context.octokit.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("❌ 系统错误");
    expect(call.body).toContain("Unexpected failure");
  });

  it("handles missing error message", async () => {
    const context = createMockContext();
    await postSystemErrorComment(context, {});
    const call = context.octokit.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("Unknown error");
  });

  it("does not throw on API failure", async () => {
    const context = createMockContext({}, {
      createComment: jest.fn().mockRejectedValue(new Error("API down")),
    });
    await expect(
      postSystemErrorComment(context, new Error("test"))
    ).resolves.toBeUndefined();
  });
});
