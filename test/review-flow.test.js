import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../reviewer/quota.js", () => ({
  getReviewTriggerQuotaForIssue: jest.fn(),
  markReviewTriggerSuccessForRepo: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/comments.js", () => ({
  postOrUpdateComment: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/validation.js", () => ({
  validateIssueFormat: jest.fn(),
}));

jest.unstable_mockModule("../reviewer/ai-review.js", () => ({
  reviewPlugin: jest.fn(),
}));

const { handlePluginReview } = await import("../reviewer/review-flow.js");

const { getReviewTriggerQuotaForIssue, markReviewTriggerSuccessForRepo } =
  await import("../reviewer/quota.js");
const { postOrUpdateComment } = await import("../reviewer/comments.js");
const { validateIssueFormat } = await import("../reviewer/validation.js");
const { reviewPlugin } = await import("../reviewer/ai-review.js");

function createMockContext(issueOverrides = {}) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
    payload: {
      issue: {
        number: 1,
        title: "[Plugin] Test",
        body: '```json\n{"name":"Test","desc":"d","author":"a","repo":"https://github.com/o/r"}\n```',
        ...issueOverrides,
      },
    },
  };
}

describe("handlePluginReview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    postOrUpdateComment.mockResolvedValue(100);
  });

  it("posts review_limit_reached when quota is exhausted", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: false,
      repoKey: "o/r",
      max: 5,
      used: 5,
      remaining: 0,
    });

    await handlePluginReview(context, false, null);

    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "review_limit_reached",
      expect.objectContaining({ quotaInfo: expect.objectContaining({ allowed: false }) }),
      false,
      null
    );
    expect(validateIssueFormat).not.toHaveBeenCalled();
  });

  it("proceeds when quota is null (no repo parsed)", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue(null);
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({ success: true, review: "OK" });

    await handlePluginReview(context, false, null);

    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "review_started",
      expect.objectContaining({ quotaInfo: null }),
      false,
      null
    );
    expect(validateIssueFormat).toHaveBeenCalled();
  });

  it("posts format_error when validation fails", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 0,
      remaining: 5,
    });
    validateIssueFormat.mockResolvedValue({
      success: false,
      errors: ["Missing name", "Missing desc"],
    });

    await handlePluginReview(context, false, null);

    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "format_error",
      expect.objectContaining({
        errors: ["Missing name", "Missing desc"],
      }),
      true,
      100
    );
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it("posts review_success and increments quota on successful review", async () => {
    const context = createMockContext();
    const quotaInfo = {
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 2,
      remaining: 3,
    };
    getReviewTriggerQuotaForIssue.mockReturnValue(quotaInfo);
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({
      success: true,
      review: "Great code!",
    });
    postOrUpdateComment.mockResolvedValue(200);

    await handlePluginReview(context, false, null);

    // Verify review_success posted with updated quota
    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "review_success",
      expect.objectContaining({
        review: "Great code!",
        quotaInfo: expect.objectContaining({ used: 3, remaining: 2 }),
      }),
      true,
      expect.any(Number)
    );

    // Verify quota incremented
    expect(markReviewTriggerSuccessForRepo).toHaveBeenCalledWith("o/r");
  });

  it("posts review_failure when review fails", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 0,
      remaining: 5,
    });
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({
      success: false,
      error: "AI service unavailable",
    });

    await handlePluginReview(context, false, null);

    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "review_failure",
      expect.objectContaining({ error: "AI service unavailable" }),
      true,
      expect.any(Number)
    );
    expect(markReviewTriggerSuccessForRepo).not.toHaveBeenCalled();
  });

  it("does not increment quota when review_success comment fails to post", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 0,
      remaining: 5,
    });
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({ success: true, review: "OK" });

    // First call for review_started returns ID, second for review_success returns null
    postOrUpdateComment
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(null);

    await handlePluginReview(context, false, null);

    expect(markReviewTriggerSuccessForRepo).not.toHaveBeenCalled();
  });

  it("passes isUpdate and commentId correctly", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 0,
      remaining: 5,
    });
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({ success: true, review: "OK" });

    await handlePluginReview(context, true, 55);

    // review_started should use isUpdate=true and commentId=55
    expect(postOrUpdateComment).toHaveBeenCalledWith(
      context,
      "review_started",
      expect.any(Object),
      true,
      55
    );
  });

  it("catches markReviewTriggerSuccessForRepo errors gracefully", async () => {
    const context = createMockContext();
    getReviewTriggerQuotaForIssue.mockReturnValue({
      allowed: true,
      repoKey: "o/r",
      max: 5,
      used: 0,
      remaining: 5,
    });
    validateIssueFormat.mockResolvedValue({
      success: true,
      pluginData: { name: "Test", desc: "d", author: "a", repo: "https://github.com/o/r" },
    });
    reviewPlugin.mockResolvedValue({ success: true, review: "OK" });
    postOrUpdateComment.mockResolvedValue(200);
    markReviewTriggerSuccessForRepo.mockImplementation(() => {
      throw new Error("DB error");
    });

    // Should not throw
    await expect(
      handlePluginReview(context, false, null)
    ).resolves.toBeUndefined();
  });
});
