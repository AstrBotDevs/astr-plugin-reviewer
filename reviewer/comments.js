/**
 * 查找机器人发布的最后一条与审核相关的评论。
 * @param {import('probot').Context} context 事件上下文。
 * @returns {Promise<object|null>} 评论对象或 null。
 */
export async function findLastReviewComment(context) {
  try {
    const { data: comments } = await context.octokit.issues.listComments(
      context.issue(),
    );
    return (
      comments
        .reverse()
        .find(
          (comment) =>
            comment.user?.type === "Bot" &&
            /##\s*(⏳|⚠️|❌|🤖)/.test(comment.body),
        ) || null
    );
  } catch (error) {
    context.log.error(error, "Failed to find last review comment");
    return null;
  }
}

/**
 * 在Issue上发布或更新评论，并处理Issue正文的更新。
 * @param {import('probot').Context} context 事件上下文。
 * @param {string} type 要发布的评论类型。
 * @param {object} data 评论模板所需的数据。
 * @param {boolean} isUpdate 是否要更新一个已有的评论。
 * @param {number|null} commentId 要更新的评论的 ID。
 * @returns {Promise<number|null>} 发布/更新后的评论ID。
 */
export async function postOrUpdateComment(
  context,
  type,
  data,
  isUpdate,
  commentId,
) {
  const templates = {
    review_started: {
      title: "## ⏳ 正在审核中...",
      body: "机器人正在努力审核您的插件代码，这可能需要几分钟时间。请稍候...",
      footer: "*此消息由系统自动生成*",
    },
    format_error: {
      title: "## ⚠️ 插件提交格式错误",
      body: `您好！您的插件提交格式存在问题，无法进行自动审核。请根据以下指南修正：\n\n${(
        data.errors || []
      )
        .map((e) => `- ${e}`)
        .join("\n")}`,
      footer:
        '*请根据上述问题进行修改。修改完成后，请在 **Issue 正文** 中勾选"重新提交审核"复选框以再次触发审核。*\n\n*此消息由系统自动生成*',
    },
    review_failure: {
      title: "## ❌ 插件审核失败",
      body: `您好！在对您的插件进行审核时遇到了问题：\n\n\`\`\`\n${
        data.error || "未知错误"
      }\n\`\`\``,
      footer:
        '*请根据上述问题进行修改。修改完成后，请在 **Issue 正文** 中勾选"重新提交审核"复选框以再次触发审核。*\n\n*此消息由系统自动生成*',
    },
    review_success: {
      title: `## 🤖 AI代码审核报告 for ${
        data.pluginData?.name || "Unknown Plugin"
      }`,
      body: `您好！我已经对你提交的插件代码进行了初步自动化审核，作为初步参考:\n\n${
        data.review || "无审核内容"
      }`,
      footer:
        "*此报告由AI自动生成，旨在提供初步反馈和改进建议，不能完全替代人工审核。最终决策以社区维护者的人工审核为准。目前自动审核（[仓库地址](https://github.com/AstrBotDevs/astr-plugin-reviewer)）处于试验阶段，如遇问题请向维护者反馈。*",
    },
    review_limit_reached: {
      title: "## ⚠️ 仓库触发次数已达上限",
      body: `当前仓库 \`${data.quotaInfo?.repoKey || "未知仓库"}\` 的审核触发次数已达到上限（${
        data.quotaInfo?.max ?? "未知"
      } 次），本次请求已拒绝。`,
      footer:
        "*如需继续自动审核，请联系维护者调整上限配置。*\n\n*此消息由系统自动生成*",
    },
    unsupported_repository: {
      title: "## ⚠️ 当前仓库不受支持",
      body: `检测到本应用当前安装在 \`${data.repositoryFullName || "未知仓库"}\`。\n\n请尽快卸载此 GitHub App，避免继续触发无效审核。`,
      footer: "*此消息由系统自动生成*",
    },
  };

  const template = templates[type];
  if (!template) {
    context.log.error("Unknown comment type: %s", type);
    return null;
  }

  const footerWithQuota = appendQuotaHintToFooter(
    template.footer,
    data.quotaInfo,
  );
  const commentBody = `${template.title}\n\n${template.body}\n\n---\n\n${footerWithQuota}`;
  let postedCommentId = commentId;
  let isCommentPublished = false;

  try {
    if (isUpdate && commentId) {
      await context.octokit.issues.updateComment({
        ...context.issue(),
        comment_id: commentId,
        body: commentBody,
      });
      isCommentPublished = true;
    } else {
      const { data: newComment } = await context.octokit.issues.createComment({
        ...context.issue(),
        body: commentBody,
      });
      postedCommentId = newComment.id;
      isCommentPublished = true;
    }
  } catch (error) {
    context.log.error(error, "Failed to post or update comment");
    return null;
  }

  if (isCommentPublished) {
    await updateIssueBodyForReviewOptions(context, type);
  }

  return isCommentPublished ? postedCommentId : null;
}

/**
 * 发布一个通用的系统错误评论。
 * @param {import('probot').Context} context 事件上下文。
 * @param {Error} error 发生的错误。
 */
export async function postSystemErrorComment(context, error) {
  const commentBody = `## ❌ 系统错误\n\n在处理您的插件提交时发生了意外的系统错误：\n\n\`\`\`\n${
    error.message || "Unknown error"
  }\n\`\`\`\n\n请稍后重试，或联系维护者以获取帮助。\n\n*此消息由系统自动生成*`;
  try {
    await context.octokit.issues.createComment(
      context.issue({ body: commentBody }),
    );
  } catch (e) {
    context.log.error(e, "Failed to post system error comment");
  }
}

/**
 * 根据审核结果，在Issue正文中添加或移除"重新审核"复选框。
 * @param {import('probot').Context} context 事件上下文。
 * @param {string} reviewOutcome 审核结果类型 (例如, 'format_error', 'review_success')。
 */
async function updateIssueBodyForReviewOptions(context, reviewOutcome) {
  const { issue } = context.payload;
  const issueBody = issue.body || "";

  const reReviewSectionRegex =
    /\n*##\s*审核选项\s*(\n*-\s*\[[ xX]\]\s*重新提交审核\s*)?/g;
  const hasReReviewSection = reReviewSectionRegex.test(issueBody);

  if (["format_error", "review_failure"].includes(reviewOutcome)) {
    if (!hasReReviewSection) {
      const newBody = `${issueBody.trim()}\n\n## 审核选项\n\n- [ ] 重新提交审核`;
      try {
        await context.octokit.issues.update({
          ...context.issue(),
          body: newBody,
        });
      } catch (error) {
        context.log.warn(error, "Failed to add re-review checkbox");
      }
    }
  } else if (reviewOutcome === "review_success") {
    if (hasReReviewSection) {
      const newBody = issueBody.replace(reReviewSectionRegex, "").trim();
      try {
        await context.octokit.issues.update({
          ...context.issue(),
          body: newBody,
        });
      } catch (error) {
        context.log.warn(error, "Failed to remove review options section");
      }
    }
  }
}

/**
 * 在评论页脚追加配额提示信息。
 * @param {string} footer 原始页脚文本。
 * @param {object|null|undefined} quotaInfo 配额信息对象。
 * @returns {string} 追加了配额提示的页脚文本。
 */
function appendQuotaHintToFooter(footer, quotaInfo) {
  if (!quotaInfo?.repoKey || typeof quotaInfo.remaining !== "number") {
    return footer;
  }

  return `${footer}\n\n当前仓库：\`${quotaInfo.repoKey}\`\n剩余触发次数：**${quotaInfo.remaining}**`;
}
