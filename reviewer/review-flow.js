import {
  getReviewTriggerQuotaForIssue,
  markReviewTriggerSuccessForRepo,
} from "./quota.js";
import { postOrUpdateComment } from "./comments.js";
import { validateIssueFormat } from "./validation.js";
import { reviewPlugin } from "./ai-review.js";

/**
 * 处理插件审核流程的核心逻辑。
 * @param {import('probot').Context} context 事件上下文。
 * @param {boolean} isUpdate 是否要更新一个已有的评论。
 * @param {number|null} commentId 要更新的评论的 ID。
 */
export async function handlePluginReview(context, isUpdate, commentId) {
  const { issue } = context.payload;
  let currentCommentId = commentId;
  const quotaInfo = getReviewTriggerQuotaForIssue(issue);

  if (quotaInfo && !quotaInfo.allowed) {
    await postOrUpdateComment(
      context,
      "review_limit_reached",
      { quotaInfo },
      isUpdate,
      currentCommentId
    );
    return;
  }

  currentCommentId = await postOrUpdateComment(
    context,
    "review_started",
    { quotaInfo },
    isUpdate,
    currentCommentId
  );

  const formatResult = await validateIssueFormat(issue);
  if (!formatResult.success) {
    await postOrUpdateComment(
      context,
      "format_error",
      { errors: formatResult.errors || [], quotaInfo },
      true,
      currentCommentId
    );
    return;
  }

  const { pluginData } = formatResult;
  const reviewResult = await reviewPlugin(context, pluginData);

  if (reviewResult.success) {
    const successQuotaInfo = quotaInfo
      ? {
          ...quotaInfo,
          used: quotaInfo.used + 1,
          remaining: Math.max(0, quotaInfo.remaining - 1),
        }
      : null;
    const reviewSuccessCommentId = await postOrUpdateComment(
      context,
      "review_success",
      { pluginData, review: reviewResult.review, quotaInfo: successQuotaInfo },
      true,
      currentCommentId
    );

    if (reviewSuccessCommentId && quotaInfo?.repoKey) {
      try {
        markReviewTriggerSuccessForRepo(quotaInfo.repoKey);
      } catch (error) {
        console.error("Failed to persist successful review trigger count:", error);
      }
    }
  } else {
    await postOrUpdateComment(
      context,
      "review_failure",
      { error: reviewResult.error, quotaInfo },
      true,
      currentCommentId
    );
  }
}
