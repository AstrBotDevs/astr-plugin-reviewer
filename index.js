import { validateEnvironment } from "./reviewer/config.js";
import {
  findLastReviewComment,
  postOrUpdateComment,
  postSystemErrorComment,
} from "./reviewer/comments.js";
import { SUPPORTED_REPOSITORY_FULL_NAME } from "./reviewer/constants.js";
import {
  cleanupDedupMappingForClosedIssue,
  shouldContinueAfterDedupCheck,
} from "./reviewer/issue-dedup.js";
import { handlePluginReview } from "./reviewer/review-flow.js";

/**
 * Probot 应用的主函数。
 * @param {import('probot').Probot} app Probot 应用实例。
 */
export default (app) => {
  validateEnvironment();

  app.log.info("Plugin reviewer app loaded");

  function hasPluginPublishLabel(issue) {
    return issue.labels?.some((label) => label.name === "plugin-publish");
  }

  async function ensureSupportedRepository(context) {
    const repositoryFullName = context.payload.repository?.full_name;
    if (repositoryFullName === SUPPORTED_REPOSITORY_FULL_NAME) {
      return true;
    }

    app.log.warn(
      { issueNumber: context.payload.issue?.number, repositoryFullName },
      "App is installed on an unsupported repository"
    );

    const lastReviewComment = await findLastReviewComment(context);
    if (lastReviewComment?.body?.includes("当前仓库不受支持")) {
      return false;
    }

    await postOrUpdateComment(
      context,
      "unsupported_repository",
      {
        repositoryFullName: repositoryFullName || "未知仓库",
        supportedRepositoryFullName: SUPPORTED_REPOSITORY_FULL_NAME,
      },
      false,
      null
    );
    return false;
  }

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const { issue, action } = context.payload;
    app.log.debug({ issueNumber: issue.number, action }, `Received issue event ${issue.number} with action ${action}`);

    if (!(await ensureSupportedRepository(context))) {
      return;
    }

    if (!hasPluginPublishLabel(issue)) {
      return;
    }

    if (action === "opened") {
      try {
        const shouldContinue = await shouldContinueAfterDedupCheck(
          context,
          app.log
        );
        if (shouldContinue) {
          app.log.info({ issueNumber: issue.number, action }, "Processing plugin-publish issue event");
          await handlePluginReview(context, false, null);
        }
      } catch (error) {
        app.log.error({ err: error, issueNumber: issue.number }, "Error handling opened issue duplicate check");
        await postSystemErrorComment(context, error);
      }
      return;
    }

    let isUpdate = false;
    let commentToUpdateId = null;

    if (action === "edited") {
      const lastReviewComment = await findLastReviewComment(context);

      if (
        !lastReviewComment ||
        lastReviewComment?.body.includes("## 🤖 AI代码审核报告") ||
        lastReviewComment?.body.includes("## ⏳ 正在审核中...") ||
        !issue.body?.match(/[-*]\s*\[[xX]\]\s*重新提交审核/)
      ) {
        app.log.debug({ issueNumber: issue.number }, "Skipping edited issue, re-review conditions not met");
        return;
      }

      isUpdate = true;
      commentToUpdateId = lastReviewComment.id;

      const updatedBody = issue.body.replace(
        /([-*]\s*\[)[xX](\]\s*重新提交审核)/g,
        "$1 $2"
      );
      await context.octokit.issues.update({
        ...context.issue(),
        body: updatedBody,
      });
    }

    app.log.info({ issueNumber: issue.number, action }, "Processing plugin-publish issue event");

    try {
      await handlePluginReview(context, isUpdate, commentToUpdateId);
    } catch (error) {
      app.log.error({ err: error, issueNumber: issue.number }, "Error handling plugin review");
      await postSystemErrorComment(context, error);
    }
  });

  app.on(["issue_comment.created"], async (context) => {
    const { issue, comment } = context.payload;

    if (!(await ensureSupportedRepository(context))) {
      return;
    }

    if (!hasPluginPublishLabel(issue)) {
      return;
    }

    const lastReviewComment = await findLastReviewComment(context);
    if (lastReviewComment?.body.includes("## ⏳ 正在审核中...")) {
      return;
    }

    if (comment.user?.type === "Bot") return;

    try {
      const body = comment.body || "";
      if (!/@astrpluginreviewer\s+review/i.test(body)) return;

      app.log.info({ issueNumber: issue.number, commentId: comment.id }, "Review requested via comment command");
      await handlePluginReview(context, false, null);
    } catch (error) {
      app.log.error({ err: error, issueNumber: issue.number }, "Error handling comment review request");
      await postSystemErrorComment(context, error);
    }
  });

  app.on("issues.closed", async (context) => {
    const { issue } = context.payload;

    if (!hasPluginPublishLabel(issue)) {
      return;
    }
    cleanupDedupMappingForClosedIssue(issue, app.log);
  });
};
