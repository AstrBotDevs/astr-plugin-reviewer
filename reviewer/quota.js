import fs from "node:fs";
import path from "node:path";
import { open } from "lmdb";
import { DEFAULT_MAX_REVIEW_TRIGGERS_PER_REPO } from "./constants.js";

const TRIGGER_COUNT_DB_PATH = path.join(
  process.cwd(),
  "data",
  "repo-trigger-counts.lmdb"
);

let triggerCountDb = null;
let hasRegisteredCloseHook = false;

/**
 * 初始化审核触发计数的 LMDB 数据库。
 * 如果数据库已初始化，则直接返回。
 */
export function initializeTriggerCountDb() {
  if (triggerCountDb) return;

  fs.mkdirSync(path.dirname(TRIGGER_COUNT_DB_PATH), { recursive: true });
  triggerCountDb = open({
    path: TRIGGER_COUNT_DB_PATH,
  });
  registerDbCloseHook();
  console.debug("Trigger count DB initialized at %s", TRIGGER_COUNT_DB_PATH);
}

/**
 * 根据 Issue 内容获取对应仓库的审核触发配额信息。
 * @param {object} issue GitHub Issue 对象。
 * @returns {object|null} 配额信息对象，若无法解析仓库地址则返回 null。
 */
export function getReviewTriggerQuotaForIssue(issue) {
  const repoKey = getPluginRepoKeyFromIssue(issue);

  if (!repoKey) {
    return null;
  }

  const quota = getReviewTriggerQuotaForRepo(repoKey);
  console.debug("Quota check for %s: used=%d, remaining=%d, allowed=%s", repoKey, quota.used, quota.remaining, quota.allowed);
  return quota;
}

/**
 * 根据 Issue 正文提取并标准化插件仓库标识。
 * @param {object|null|undefined} issue GitHub Issue 对象。
 * @returns {string|null} 标准化仓库标识（格式为 "owner/repo"），若无法解析则返回 null。
 */
export function getPluginRepoKeyFromIssue(issue) {
  const repoUrl = extractRepoUrlFromIssueBody(issue?.body || "");
  return normalizePluginRepoKey(repoUrl);
}

/**
 * 将指定仓库的审核触发计数加一并返回更新后的配额信息。
 * @param {string} repoKey 标准化的仓库标识（格式为 "owner/repo"）。
 * @returns {object|null} 更新后的配额信息对象，若 repoKey 无效则返回 null。
 */
export function markReviewTriggerSuccessForRepo(repoKey) {
  if (!repoKey) {
    return null;
  }

  initializeTriggerCountDb();
  const maxTriggers = getMaxReviewTriggersPerRepo();

  return triggerCountDb.transactionSync(() => {
    const currentCount = getCurrentTriggerCount(repoKey);

    if (currentCount >= maxTriggers) {
      console.debug("Quota already at max for %s (%d/%d), not incrementing", repoKey, currentCount, maxTriggers);
      return {
        incremented: false,
        allowed: false,
        repoKey,
        max: maxTriggers,
        used: currentCount,
        remaining: 0,
      };
    }

    const nextCount = currentCount + 1;
    triggerCountDb.putSync(repoKey, nextCount);

    console.debug("Trigger count incremented for %s: %d/%d", repoKey, nextCount, maxTriggers);
    return {
      incremented: true,
      allowed: nextCount < maxTriggers,
      repoKey,
      max: maxTriggers,
      used: nextCount,
      remaining: Math.max(0, maxTriggers - nextCount),
    };
  });
}

/**
 * 从 Issue 正文中提取插件仓库 URL。
 * 解析 Issue 正文中的 JSON 代码块并提取 repo 字段。
 * @param {string} body Issue 正文内容。
 * @returns {string|null} 仓库 URL 字符串，若无法提取则返回 null。
 */
function extractRepoUrlFromIssueBody(body) {
  const jsonMatch = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!jsonMatch?.[1]) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return typeof parsed.repo === "string" ? parsed.repo : null;
  } catch {
    const repoMatch = jsonMatch[1].match(/"repo"\s*:\s*"([^"]+)"/i);
    return repoMatch?.[1] || null;
  }
}

/**
 * 将各种格式的仓库 URL 标准化为 "owner/repo" 形式。
 * 支持 HTTPS URL、SSH URL、以及 owner/repo 简写格式。
 * @param {string|null|undefined} repoUrl 原始仓库 URL 或路径。
 * @returns {string|null} 标准化的仓库标识，若无法解析则返回 null。
 */
function normalizePluginRepoKey(repoUrl) {
  if (typeof repoUrl !== "string") return null;

  let input = repoUrl.trim().replace(/^git\+/, "");
  if (!input) return null;

  if (input.startsWith("git@github.com:")) {
    input = `https://github.com/${input.slice("git@github.com:".length)}`;
  }

  let owner;
  let repo;

  try {
    const candidate = /^https?:\/\//i.test(input)
      ? input
      : `https://github.com/${input.replace(/^\/+/, "")}`;
    const parsedUrl = new URL(candidate);

    if (parsedUrl.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) return null;

    [owner, repo] = pathParts;
  } catch {
    const parts = input.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    [owner, repo] = parts;
  }

  if (!owner || !repo) return null;

  repo = repo.replace(/\.git$/i, "");
  if (!repo) return null;

  return `${owner}/${repo}`;
}

/**
 * 获取指定仓库的审核触发配额信息。
 * @param {string} repoKey 标准化的仓库标识（格式为 "owner/repo"）。
 * @returns {{allowed: boolean, repoKey: string, max: number, used: number, remaining: number}} 配额信息对象。
 */
function getReviewTriggerQuotaForRepo(repoKey) {
  initializeTriggerCountDb();
  const maxTriggers = getMaxReviewTriggersPerRepo();
  const currentCount = getCurrentTriggerCount(repoKey);

  return {
    allowed: currentCount < maxTriggers,
    repoKey,
    max: maxTriggers,
    used: currentCount,
    remaining: Math.max(0, maxTriggers - currentCount),
  };
}

/**
 * 从数据库中获取指定仓库当前的触发计数。
 * @param {string} repoKey 标准化的仓库标识。
 * @returns {number} 当前触发次数，若无记录则返回 0。
 */
function getCurrentTriggerCount(repoKey) {
  const currentCount = triggerCountDb.get(repoKey);
  return Number.isFinite(currentCount) ? Number(currentCount) : 0;
}

/**
 * 注册进程退出时关闭数据库的钩子。
 * 确保钩子只注册一次。
 */
function registerDbCloseHook() {
  if (hasRegisteredCloseHook) {
    return;
  }
  hasRegisteredCloseHook = true;

  process.once("beforeExit", () => {
    void closeTriggerCountDb();
  });
}

/**
 * 关闭触发计数数据库连接。
 * @returns {Promise<void>}
 */
async function closeTriggerCountDb() {
  if (!triggerCountDb) {
    return;
  }

  const db = triggerCountDb;
  triggerCountDb = null;

  try {
    await db.close();
    console.debug("Trigger count DB closed");
  } catch (error) {
    console.error("Failed to close trigger count DB:", error);
  }
}

/**
 * 获取每个仓库允许的最大审核触发次数。
 * 优先使用环境变量 MAX_REVIEW_TRIGGERS_PER_REPO 的值，否则使用默认值。
 * @returns {number} 最大审核触发次数。
 */
function getMaxReviewTriggersPerRepo() {
  const parsed = Number.parseInt(
    process.env.MAX_REVIEW_TRIGGERS_PER_REPO || "",
    10
  );

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_REVIEW_TRIGGERS_PER_REPO;
  }

  return parsed;
}
