import OpenAI from "openai";
import { MAIN_FILE_PROMPT, REGULAR_FILE_PROMPT } from "./prompts.js";

// 常量定义
const MAX_FILES_TO_REVIEW = 15;
const TOKEN_ESTIMATION_RATIO = 0.25;
const REQUIRED_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_MAX_INPUT_TOKENS",
  "OPENAI_MAX_OUTPUT_TOKENS",
];

/**
 * Probot 应用的主函数。
 * @param {import('probot').Probot} app Probot 应用实例。
 */
export default (app) => {
  validateEnvironment();

  // 监听GitHub issue的创建和编辑事件
  app.on(["issues.opened", "issues.edited"], async (context) => {
    const { issue, action } = context.payload;

    // 只处理带有plugin-publish标签的issue
    if (!issue.labels?.some((label) => label.name === "plugin-publish")) {
      return;
    }

    let isUpdate = false;
    let commentToUpdateId = null;

    if (action === "edited") {
      const lastReviewComment = await findLastReviewComment(context);

      // 检查是否需要重新审核（用户勾选了重新提交审核）
      if (
        !lastReviewComment ||
        lastReviewComment?.body.includes("## 🤖 AI代码审核报告") ||
        lastReviewComment?.body.includes("## ⏳ 正在审核中...") ||
        !issue.body?.match(/[-*]\s*\[[xX]\]\s*重新提交审核/)
      ) {
        return;
      }

      isUpdate = true;
      commentToUpdateId = lastReviewComment.id;

      // 更新issue正文，取消勾选重新提交审核选项
      const updatedBody = issue.body.replace(
        /([-*]\s*\[)[xX](\]\s*重新提交审核)/g,
        "$1 $2"
      );
      await context.octokit.issues.update({
        ...context.issue(),
        body: updatedBody,
      });
    }

    try {
      await handlePluginReview(context, isUpdate, commentToUpdateId);
    } catch (error) {
      await postSystemErrorComment(context, error);
    }
  });
};

/**
 * 处理插件审核流程的核心逻辑。
 * @param {import('probot').Context} context 事件上下文。
 * @param {boolean} isUpdate 是否要更新一个已有的评论。
 * @param {number|null} commentId 要更新的评论的 ID。
 */
async function handlePluginReview(context, isUpdate, commentId) {
  const { issue } = context.payload;
  let currentCommentId = commentId;

  // 发布审核开始通知
  currentCommentId = await postOrUpdateComment(
    context,
    "review_started",
    {},
    isUpdate,
    currentCommentId
  );

  // 验证issue格式
  const formatResult = await validateIssueFormat(issue);
  if (!formatResult.success) {
    await postOrUpdateComment(
      context,
      "format_error",
      { errors: formatResult.errors || [] },
      true,
      currentCommentId
    );
    return;
  }

  // 执行代码审核
  const { pluginData } = formatResult;
  const reviewResult = await reviewPlugin(context, pluginData);

  // 根据审核结果发布不同通知
  if (reviewResult.success) {
    await postOrUpdateComment(
      context,
      "review_success",
      { pluginData, review: reviewResult.review },
      true,
      currentCommentId
    );
  } else {
    await postOrUpdateComment(
      context,
      "review_failure",
      { error: reviewResult.error },
      true,
      currentCommentId
    );
  }
}

/**
 * 协调插件审核的各个阶段。
 * @param {import('probot').Context} context 事件上下文。
 * @param {object} pluginData 从 Issue 中解析出的插件数据。
 * @returns {Promise<{success: boolean, review?: string, error?: string}>} 审核结果。
 */
async function reviewPlugin(context, pluginData) {
  try {
    // 从仓库URL解析owner和repo
    const { pathname } = new URL(pluginData.repo);
    const [owner, repo] = pathname.split("/").filter(Boolean);

    if (!owner || !repo) {
      return {
        success: false,
        error: "Invalid repository URL. Could not parse owner and repo.",
      };
    }

    const repoInfo = { owner, repo };

    // 执行AI代码审核
    return await performAIReview(context.octokit, repoInfo);
  } catch (error) {
    return {
      success: false,
      error: `An error occurred while fetching or analyzing code: ${error.message}`,
    };
  }
}

/**
 * 获取仓库中所有 Python 文件的元数据（路径和SHA）
 * @param {import('@octokit/core').Octokit} octokit Octokit 实例。
 * @param {{owner: string, repo: string}} repoInfo 仓库信息。
 * @returns {Promise<Array<{path: string, sha: string}>>} 文件元数据数组。
 */
async function fetchPythonFileTree(octokit, repoInfo) {
  try {
    // 获取仓库默认分支信息
    const { data: repo } = await octokit.rest.repos.get(repoInfo);
    // 获取仓库文件树
    const { data: tree } = await octokit.rest.git.getTree({
      ...repoInfo,
      tree_sha: repo.default_branch,
      recursive: true,
    });

    if (!tree.tree?.length) {
      console.error("Repository tree is invalid or empty.");
      return [];
    }

    // 过滤出Python文件
    return tree.tree.filter(
      (item) => item.type === "blob" && item.path?.endsWith(".py") && item.sha
    );
  } catch (error) {
    throw error;
  }
}

/**
 * 查找机器人发布的最后一条与审核相关的评论。
 * @param {import('probot').Context} context 事件上下文。
 * @returns {Promise<object|null>} 评论对象或 null。
 */
async function findLastReviewComment(context) {
  try {
    // 获取issue所有评论
    const { data: comments } = await context.octokit.issues.listComments(
      context.issue()
    );
    // 查找最新的审核相关评论（由机器人发布）
    return (
      comments
        .reverse()
        .find(
          (comment) =>
            comment.user?.type === "Bot" &&
            /##\s*(⏳|⚠️|❌|🤖)/.test(comment.body)
        ) || null
    );
  } catch (error) {
    console.error("Failed to find last review comment:", error);
    return null;
  }
}

/**
 * 执行AI代码审核的核心流程。
 * 包含获取文件清单、选择文件、按需获取内容、调用AI和组合结果。
 * @param {import('@octokit/core').Octokit} octokit Octokit 实例。
 * @param {{owner: string, repo: string}} repoInfo 仓库信息。
 * @returns {Promise<{success: boolean, review?: string, error?: string}>}
 */
async function performAIReview(octokit, repoInfo) {
  const config = getConfig();
  const openai = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL && { baseURL: config.baseURL }),
  });

  // 获取所有Python文件
  const allPythonFiles = await fetchPythonFileTree(octokit, repoInfo);
  if (allPythonFiles.length === 0) {
    return {
      success: false,
      error: "No Python (.py) files found in the repository.",
    };
  }

  // 按优先级排序文件
  const sortedFiles = sortFilesByPriority(allPythonFiles);
  // 根据token限制选择要审核的文件
  const selectedFiles = await selectAndFetchFilesForReview(
    octokit,
    repoInfo,
    sortedFiles,
    config.maxInputTokens
  );

  if (selectedFiles.length === 0) {
    return {
      success: false,
      error:
        "No files were selected for review due to token limits or an empty repository.",
    };
  }

  // 批量审核文件
  const reviewResult = await reviewFileBatch(openai, selectedFiles, config);

  // 组合审核结果和摘要
  return combineReviewResults(
    reviewResult,
    allPythonFiles.length,
    selectedFiles
  );
}

/**
 * 对文件元数据进行排序。
 * @param {Array<{path: string}>} files 要排序的文件元数据。
 * @returns {Array<{path: string}>} 排序后的文件元数据。
 */
function sortFilesByPriority(files) {
  return [...files].sort((a, b) => {
    // 优先处理main.py文件
    const isAMain = a.path.toLowerCase().includes("main.py");
    const isBMain = b.path.toLowerCase().includes("main.py");
    if (isAMain !== isBMain) return isAMain ? -1 : 1;

    // 其次按目录深度排序（浅层目录优先）
    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;

    // 最后按路径字母顺序排序
    return a.path.localeCompare(b.path);
  });
}

/**
 * 根据Token限制选择文件，并仅为选中的文件获取内容。
 * @param {import('@octokit/core').Octokit} octokit Octokit 实例。
 * @param {{owner: string, repo: string}} repoInfo 仓库信息。
 * @param {Array<{path: string, sha: string}>} files 排序后的文件元数据。
 * @param {number} maxInputTokens AI模型的最大输入Token。
 * @returns {Promise<Array<{path: string, content: string}>>} 包含文件内容的对象数组。
 */
async function selectAndFetchFilesForReview(
  octokit,
  repoInfo,
  files,
  maxInputTokens
) {
  const selected = [];
  let totalEstimatedTokens = 0;
  // 设置token限制为最大输入的70%
  const tokenLimit = maxInputTokens * 0.7;

  // 估算每个模板的token数量
  const mainPromptTokens = Math.ceil(MAIN_FILE_PROMPT.length * TOKEN_ESTIMATION_RATIO);
  const regularPromptTokens = Math.ceil(REGULAR_FILE_PROMPT.length * TOKEN_ESTIMATION_RATIO);

  // 获取文件内容
  for (const fileMeta of files) {
    if (selected.length >= MAX_FILES_TO_REVIEW) break;

    try {
      const { data: blob } = await octokit.rest.git.getBlob({
        ...repoInfo,
        file_sha: fileMeta.sha,
      });

      // 解码base64内容并移除注释和空行
      let content = Buffer.from(blob.content, "base64").toString("utf-8");
      content = content
        .split("\n")
        .map(removeCommentsFromLine)
        .filter((line) => line.trim() !== "")
        .join("\n");

      // 估算token使用量，包括文件内容、路径和对应的prompt模板
      const promptTokens = fileMeta.path.toLowerCase().includes("main.py")
        ? mainPromptTokens
        : regularPromptTokens;
      const estimatedTokens = Math.ceil(
        (content.length + fileMeta.path.length) * TOKEN_ESTIMATION_RATIO + promptTokens
      );

      // 检查token限制
      if (totalEstimatedTokens + estimatedTokens > tokenLimit) break;

      totalEstimatedTokens += estimatedTokens;
      selected.push({ path: fileMeta.path, content });
    } catch (error) {
      console.error(`Failed to fetch content for ${fileMeta.path}:`, error);
      continue;
    }
  }
  return selected;
}

/**
 * 从Python代码中移除注释。
 * @param {string} line - 一行代码。
 * @returns {string} - 移除了注释的代码。
 */
function removeCommentsFromLine(line) {
  let in_single_quote = false;
  let in_double_quote = false;

  // 遍历每个字符，跟踪字符串状态
  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    // 处理单引号字符串
    if (char === "'" && !in_double_quote) {
      if (i === 0 || line[i - 1] !== "\\") {
        in_single_quote = !in_single_quote;
      }
      // 处理双引号字符串
    } else if (char === '"' && !in_single_quote) {
      if (i === 0 || line[i - 1] !== "\\") {
        in_double_quote = !in_double_quote;
      }
    }

    // 发现注释符号且不在字符串中时，截断该行
    if (char === "#" && !in_single_quote && !in_double_quote) {
      return line.substring(0, i).trimEnd();
    }
  }

  return line;
}

/**
 * 使用单次AI API调用审核一批文件。
 * @param {OpenAI} openai OpenAI客户端实例。
 * @param {Array<{path: string, content: string}>} files 需要审核的文件（已包含内容）。
 * @param {object} config 应用配置。
 * @returns {Promise<{success: boolean, review?: string, error?: string, tokensUsed?: number}>}
 */
async function reviewFileBatch(openai, files, config) {
  if (files.length === 0) {
    return { success: false, error: "No files were selected for review." };
  }

  const prompt = buildBatchPrompt(files);

  try {
    // 构建基础参数
    const completionParams = {
      model: config.model,
      messages: [{ role: "user", content: prompt }],
    };

    // 根据模型名称决定是否添加特殊参数
    if (config.model.includes("qwen3-235b-a22b-fp8")) {
      completionParams.response_format = { type: "text" };
    } else {
      completionParams.temperature = 0.2;
      completionParams.max_tokens = config.maxOutputTokens;
    }

    const completion = await openai.chat.completions.create(completionParams);

    const responseContent = completion.choices[0].message.content || "";
    if (!responseContent) {
      return { success: false, error: "AI returned an empty response." };
    }

    return {
      success: true,
      review: responseContent,
    };
  } catch (error) {
    console.error(`Batch file review API call failed:`, error);
    return {
      success: false,
      error: "An internal error occurred while calling the AI review service.",
    };
  }
}

/**
 * 为一批文件构建组合的Prompt。
 * @param {Array<{path: string, content: string}>} files 文件数组。
 * @returns {string} 完整的Prompt字符串。
 */
function buildBatchPrompt(files) {
  return files
    .map((file) => {
      const promptTemplate = file.path.toLowerCase().includes("main.py")
        ? MAIN_FILE_PROMPT
        : REGULAR_FILE_PROMPT;
      return `### ${file.path}\n\n\`\`\`python\n${file.content}\n\`\`\`\n\n${promptTemplate}`;
    })
    .join("\n\n---\n\n");
}

/**
 * 将AI的原始审核报告与一个摘要部分组合起来。
 * @param {object} reviewResult 来自AI调用的结果对象。
 * @param {number} totalFileCount 仓库中Python文件的总数。
 * @param {Array<{path: string}>} selectedFiles 已发送至AI审核的文件。
 * @returns {{success: boolean, review?: string, error?: string}}
 */
function combineReviewResults(reviewResult, totalFileCount, selectedFiles) {
  if (!reviewResult.success) {
    return {
      success: false,
      error:
        reviewResult.error ||
        "Code review failed and no specific error was provided.",
    };
  }

  const rawReviewText = reviewResult.review;
  const selectedFileCount = selectedFiles.length;

  let summary = `\n\n---\n\n### 🔍 审核摘要\n\n`;
  summary += `**统计信息**\n`;
  summary += `* **仓库文件总数**: ${totalFileCount} 个 Python 文件\n`;
  summary += `* **已选择审核文件**: ${selectedFileCount} / ${totalFileCount}\n`;
  summary += `**已发送至 AI 审核的文件清单**\n\`\`\`\n${selectedFiles
    .map((f) => f.path)
    .join("\n")}\n\`\`\`\n`;

  if (totalFileCount > selectedFileCount) {
    summary += `\n*注意：由于项目规模或Token限制，本次仅审核了部分优先文件。以上报告内容由 AI 直接生成。*`;
  }

  return { success: true, review: rawReviewText + summary };
}

/**
 * 验证插件提交Issue的格式。
 * @param {object} issue Issue对象。
 * @returns {Promise<{success: boolean, errors?: string[], pluginData?: object}>} 验证结果。
 */
async function validateIssueFormat(issue) {
  const errors = [];
  const body = issue.body || "";

  if (
    !/^\[Plugin\]\s+.+$/i.test(issue.title) ||
    /^\[Plugin\]\s+插件名$/i.test(issue.title)
  ) {
    errors.push("Issue标题格式不正确，应为: `[Plugin] 您的插件名`");
  }

  const requiredChecks = [
    "我的插件经过完整的测试",
    "我的插件不包含恶意代码",
    "我已阅读并同意遵守该项目的 [行为准则](https://docs.github.com/zh/site-policy/github-terms/github-community-code-of-conduct)。",
  ];
  requiredChecks.forEach((check) => {
    const patternText = check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`-\\s*\\[[xX]\\]\\s+${patternText}`).test(body)) {
      errors.push(`必需的声明未勾选: "${check.split("](")[0]}"`);
    }
  });

  const jsonMatch = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!jsonMatch?.[1]) {
    errors.push(
      "在Issue内容中未找到JSON代码块。请使用 ```json ... ``` 将插件信息包裹起来。"
    );
    return { success: false, errors };
  }

  let pluginData;
  try {
    pluginData = JSON.parse(jsonMatch[1]);
  } catch (e) {
    errors.push(
      `JSON格式错误: ${e.message}。请检查语法，如逗号、引号是否正确。`
    );
    return { success: false, errors };
  }

  if (!pluginData.name || pluginData.name === "插件名")
    errors.push("请在JSON中提供一个有效的 `name`。");
  if (!pluginData.desc || pluginData.desc === "插件介绍")
    errors.push("请在JSON中提供一个有效的 `desc`。");
  if (!pluginData.repo) {
    errors.push("请在JSON中提供 `repo` 仓库地址。");
  } else {
    try {
      const url = new URL(pluginData.repo);
      if (url.hostname !== "github.com") {
        errors.push("目前仅支持托管在 `github.com` 上的仓库。");
      }
    } catch {
      errors.push(`提供的仓库URL \`${pluginData.repo}\` 无效。`);
    }
  }

  return errors.length > 0
    ? { success: false, errors }
    : { success: true, pluginData };
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
async function postOrUpdateComment(context, type, data, isUpdate, commentId) {
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
      body: `您好！在对您的插件进行审核时遇到了技术问题：\n\n\`\`\`\n${
        data.error || "未知错误"
      }\n\`\`\``,
      footer:
        '*请根据上述问题进行修改。修改完成后，请在 **Issue 正文** 中勾选"重新提交审核"复选框以再次触发审核。*\n\n*此消息由系统自动生成*',
    },
    review_success: {
      title: `## 🤖 AI代码审核报告 for ${
        data.pluginData?.name || "Unknown Plugin"
      }`,
      body: `你好！我已经对你提交的插件代码进行了初步自动化审核：\n\n${
        data.review || "无审核内容"
      }`,
      footer:
        "*此报告由AI自动生成，旨在提供初步反馈和改进建议，不能完全替代人工审核。最终决策以社区维护者的人工审核为准。*",
    },
  };

  const template = templates[type];
  if (!template) {
    console.error(`Unknown comment type: ${type}`);
    return null;
  }

  const commentBody = `${template.title}\n\n${template.body}\n\n---\n\n${template.footer}`;
  let postedCommentId = commentId;

  try {
    if (isUpdate && commentId) {
      await context.octokit.issues.updateComment({
        ...context.issue(),
        comment_id: commentId,
        body: commentBody,
      });
    } else {
      const { data: newComment } = await context.octokit.issues.createComment({
        ...context.issue(),
        body: commentBody,
      });
      postedCommentId = newComment.id;
    }
  } catch (error) {
    console.error("Failed to post or update comment:", error);
  }

  await updateIssueBodyForReviewOptions(context, type);

  return postedCommentId;
}

/**
 * 根据审核结果，在Issue正文中添加或移除“重新审核”复选框。
 * @param {import('probot').Context} context 事件上下文。
 * @param {string} reviewOutcome 审核结果类型 (例如, 'format_error', 'review_success')。
 */
async function updateIssueBodyForReviewOptions(context, reviewOutcome) {
  const { issue } = context.payload;
  let issueBody = issue.body || "";

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
        console.error(`Failed to add re-review checkbox:`, error);
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
        console.error(`Failed to remove review options section:`, error);
      }
    }
  }
}

/**
 * 发布一个通用的系统错误评论。
 * @param {import('probot').Context} context 事件上下文。
 * @param {Error} error 发生的错误。
 */
async function postSystemErrorComment(context, error) {
  const commentBody = `## ❌ 系统错误\n\n在处理您的插件提交时发生了意外的系统错误：\n\n\`\`\`\n${
    error.message || "Unknown error"
  }\n\`\`\`\n\n请稍后重试，或联系维护者以获取帮助。\n\n*此消息由系统自动生成*`;
  try {
    await context.octokit.issues.createComment(
      context.issue({ body: commentBody })
    );
  } catch (e) {
    console.error("Failed to post system error comment:", e);
  }
}

/**
 * 验证所有必需的环境变量是否都已设置。
 */
function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

/**
 * 从环境变量中获取并解析应用配置。
 * @returns {object} 配置对象。
 */
function getConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || null,
    model: process.env.OPENAI_MODEL,
    maxInputTokens: parseInt(process.env.OPENAI_MAX_INPUT_TOKENS, 10) || 4000,
    maxOutputTokens: parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS, 10) || 1500,
  };
}
