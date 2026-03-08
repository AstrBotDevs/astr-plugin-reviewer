import OpenAI from "openai";
import { MAIN_FILE_PROMPT, REGULAR_FILE_PROMPT } from "../prompts.js";
import {
  MAX_FILES_TO_REVIEW,
  TOKEN_ESTIMATION_RATIO,
} from "./constants.js";
import { getConfig } from "./config.js";
import { validateMetadataYaml } from "./validation.js";

/**
 * 协调插件审核的各个阶段。
 * @param {import('probot').Context} context 事件上下文。
 * @param {object} pluginData 从 Issue 中解析出的插件数据。
 * @returns {Promise<{success: boolean, review?: string, error?: string}>} 审核结果。
 */
export async function reviewPlugin(context, pluginData) {
  try {
    const { pathname } = new URL(pluginData.repo);
    const [owner, repo] = pathname.split("/").filter(Boolean);

    if (!owner || !repo) {
      return {
        success: false,
        error: "无效的仓库URL。无法解析所有者和仓库名。",
      };
    }

    const repoInfo = { owner, repo };

    const metadataResult = await validateMetadataYaml(
      context.octokit,
      repoInfo,
      pluginData
    );
    if (!metadataResult.success) {
      return {
        success: false,
        error: `验证metadata.yaml失败:\n${metadataResult.errors
          .map((e) => `- ${e}`)
          .join("\n")}`,
      };
    }

    return await performAIReview(context.octokit, repoInfo);
  } catch (error) {
    return {
      success: false,
      error: `获取或分析代码时发生错误: ${error.message}`,
    };
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
    timeout: 8 * 60 * 1000,
    ...(config.baseURL && { baseURL: config.baseURL }),
  });

  const allPythonFiles = await fetchPythonFileTree(octokit, repoInfo);
  if (allPythonFiles.length === 0) {
    return {
      success: false,
      error: "在代码仓库中未找到任何Python（.py）文件。",
    };
  }

  const sortedFiles = sortFilesByPriority(allPythonFiles);
  const selectedFiles = await selectAndFetchFilesForReview(
    octokit,
    repoInfo,
    sortedFiles,
    config.maxInputTokens
  );

  if (selectedFiles.length === 0) {
    return {
      success: false,
      error: "由于token限制或空仓库，未选择任何文件进行审核。",
    };
  }

  octokit.log.info("Files selected for AI review", { fileCount: selectedFiles.length, totalPythonFiles: allPythonFiles.length });

  const reviewResult = await reviewFileBatch(openai, selectedFiles, config, octokit.log);

  return combineReviewResults(reviewResult, allPythonFiles.length, selectedFiles);
}

/**
 * 获取仓库中所有 Python 文件的元数据（路径和SHA）
 * @param {import('@octokit/core').Octokit} octokit Octokit 实例。
 * @param {{owner: string, repo: string}} repoInfo 仓库信息。
 * @returns {Promise<Array<{path: string, sha: string}>>} 文件元数据数组。
 */
async function fetchPythonFileTree(octokit, repoInfo) {
  const { data: repo } = await octokit.rest.repos.get(repoInfo);
  const { data: tree } = await octokit.rest.git.getTree({
    ...repoInfo,
    tree_sha: repo.default_branch,
    recursive: true,
  });

  if (!tree.tree?.length) {
    octokit.log.warn("Repository tree is invalid or empty", { owner: repoInfo.owner, repo: repoInfo.repo });
    return [];
  }

  return tree.tree.filter(
    (item) => item.type === "blob" && item.path?.endsWith(".py") && item.sha
  );
}

/**
 * 对文件元数据进行排序。
 * @param {Array<{path: string}>} files 要排序的文件元数据。
 * @returns {Array<{path: string}>} 排序后的文件元数据。
 */
function sortFilesByPriority(files) {
  return [...files].sort((a, b) => {
    const isAMain = a.path.toLowerCase().includes("main.py");
    const isBMain = b.path.toLowerCase().includes("main.py");
    if (isAMain !== isBMain) return isAMain ? -1 : 1;

    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;

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
  const tokenLimit = maxInputTokens * 0.7;

  const mainPromptTokens = Math.ceil(
    MAIN_FILE_PROMPT.length * TOKEN_ESTIMATION_RATIO
  );
  const regularPromptTokens = Math.ceil(
    REGULAR_FILE_PROMPT.length * TOKEN_ESTIMATION_RATIO
  );

  for (const fileMeta of files) {
    if (selected.length >= MAX_FILES_TO_REVIEW) break;

    try {
      const { data: blob } = await octokit.rest.git.getBlob({
        ...repoInfo,
        file_sha: fileMeta.sha,
      });

      let content = Buffer.from(blob.content, "base64").toString("utf-8");
      content = content
        .split("\n")
        .map(removeCommentsFromLine)
        .filter((line) => line.trim() !== "")
        .join("\n");

      const promptTokens = fileMeta.path.toLowerCase().includes("main.py")
        ? mainPromptTokens
        : regularPromptTokens;
      const estimatedTokens = Math.ceil(
        (content.length + fileMeta.path.length) * TOKEN_ESTIMATION_RATIO +
          promptTokens
      );

      if (totalEstimatedTokens + estimatedTokens > tokenLimit) break;

      totalEstimatedTokens += estimatedTokens;
      selected.push({ path: fileMeta.path, content });
    } catch (error) {
      octokit.log.warn("Failed to fetch file content, skipping", { filePath: fileMeta.path });
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
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === "'" && !inDoubleQuote) {
      if (i === 0 || line[i - 1] !== "\\") {
        inSingleQuote = !inSingleQuote;
      }
    } else if (char === '"' && !inSingleQuote) {
      if (i === 0 || line[i - 1] !== "\\") {
        inDoubleQuote = !inDoubleQuote;
      }
    }

    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
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
 * @param {object} log 日志器实例。
 * @returns {Promise<{success: boolean, review?: string, error?: string, tokensUsed?: number}>}
 */
async function reviewFileBatch(openai, files, config, log) {
  if (files.length === 0) {
    return { success: false, error: "未选择任何文件进行审查。" };
  }

  const prompt = buildBatchPrompt(files);

  try {
    const completionParams = {
      model: config.model,
      messages: [{ role: "user", content: prompt }],
    };

    if (config.model.includes("qwen3-235b-a22b-fp8")) {
      completionParams.response_format = { type: "text" };
    }

    const completion = await openai.chat.completions.create(completionParams);

    const responseContent = completion.choices[0].message.content || "";
    if (!responseContent) {
      return { success: false, error: "AI返回了空响应。" };
    }

    return {
      success: true,
      review: responseContent,
    };
  } catch (error) {
    log.error("AI batch review API call failed", { err: error });
    return {
      success: false,
      error: "调用AI审核服务时发生内部错误。",
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
      error: reviewResult.error || "代码审核失败，无具体错误信息。",
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
