import fs from "node:fs";
import path from "node:path";
import { open } from "lmdb";
import { getPluginRepoKeyFromIssue } from "./quota.js";

const IMDB_PATH = path.join(process.cwd(), "data", "plugin-publish-imdb.lmdb");

let imdb = null;
let hasRegisteredCloseHook = false;

/**
 * 初始化 issue 映射数据库（repoKey -> issueId）。
 */
export function initializeImdb() {
  if (imdb) return;

  fs.mkdirSync(path.dirname(IMDB_PATH), { recursive: true });
  imdb = open({
    path: IMDB_PATH,
  });
  registerDbCloseHook();
  console.debug("IMDB initialized at %s", IMDB_PATH);
}

/**
 * 读取仓库对应的 issueId（Issue Number）。
 * @param {string|null|undefined} repoKey 标准化仓库标识，格式 owner/repo。
 * @returns {number|null}
 */
export function getIssueIdForRepo(repoKey) {
  if (!repoKey) return null;
  initializeImdb();

  const issueId = imdb.get(repoKey);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return null;
  }
  return issueId;
}

/**
 * 写入仓库对应的 issueId（Issue Number）。
 * @param {string|null|undefined} repoKey 标准化仓库标识，格式 owner/repo。
 * @param {number|null|undefined} issueId Issue Number。
 * @returns {number|null}
 */
export function markIssueForRepo(repoKey, issueId) {
  if (!repoKey || !Number.isInteger(issueId) || issueId <= 0) {
    return null;
  }

  initializeImdb();
  imdb.putSync(repoKey, issueId);
  return issueId;
}

/**
 * 仅当当前记录与 issueId 匹配时移除映射。
 * @param {string|null|undefined} repoKey 标准化仓库标识，格式 owner/repo。
 * @param {number|null|undefined} issueId Issue Number。
 * @returns {boolean}
 */
export function removeIssueForRepoIfMatch(repoKey, issueId) {
  if (!repoKey || !Number.isInteger(issueId) || issueId <= 0) {
    return false;
  }

  initializeImdb();
  return imdb.transactionSync(() => {
    const currentIssueId = imdb.get(repoKey);
    if (currentIssueId !== issueId) {
      return false;
    }
    imdb.removeSync(repoKey);
    return true;
  });
}

/**
 * 检查 opened issue 是否为重复提交。
 * @param {import('probot').Context} context 事件上下文。
 * @param {object} log 日志对象。
 * @returns {Promise<boolean>} true 表示继续流程；false 表示已按重复关闭。
 */
export async function shouldContinueAfterDedupCheck(context, log) {
  const { issue } = context.payload;
  const repoKey = getPluginRepoKeyFromIssue(issue);
  if (!repoKey) {
    return true;
  }

  const existedIssueId = getIssueIdForRepo(repoKey);
  if (!existedIssueId) {
    markIssueForRepo(repoKey, issue.number);
    return true;
  }

  if (existedIssueId === issue.number) {
    return true;
  }

  try {
    const { data: existedIssue } = await context.octokit.issues.get(
      context.issue({ issue_number: existedIssueId })
    );

    if (existedIssue.state === "closed") {
      removeIssueForRepoIfMatch(repoKey, existedIssueId);
      markIssueForRepo(repoKey, issue.number);
      log.info(
        { issueNumber: issue.number, repoKey, existedIssueId },
        "Removed stale duplicate mapping from closed issue"
      );
      return true;
    }
  } catch (error) {
    if (error?.status === 404) {
      removeIssueForRepoIfMatch(repoKey, existedIssueId);
      markIssueForRepo(repoKey, issue.number);
      log.info(
        { issueNumber: issue.number, repoKey, existedIssueId },
        "Removed stale duplicate mapping from missing issue"
      );
      return true;
    }

    log.warn(
      { err: error, issueNumber: issue.number, repoKey, existedIssueId },
      "Failed to verify existing issue mapping, continuing with review"
    );
    return true;
  }

  await closeAsDuplicate(context, existedIssueId);
  log.info(
    { issueNumber: issue.number, repoKey, duplicateOfIssueId: existedIssueId },
    "Closed duplicate plugin-publish issue"
  );
  return false;
}

/**
 * 在 issue 关闭后清理去重映射。
 * @param {object} issue GitHub Issue 对象。
 * @param {object} log 日志对象。
 */
export function cleanupDedupMappingForClosedIssue(issue, log) {
  const repoKey = getPluginRepoKeyFromIssue(issue);
  if (!repoKey) {
    return;
  }

  const removed = removeIssueForRepoIfMatch(repoKey, issue.number);
  if (removed) {
    log.info(
      { issueNumber: issue.number, repoKey },
      "Removed issue mapping for closed plugin-publish issue"
    );
  }
}

async function closeAsDuplicate(context, duplicateOfIssueId) {
  await context.octokit.issues.createComment({
    ...context.issue(),
    body: `Duplicate of #${duplicateOfIssueId}`,
  });

  await context.octokit.issues.update({
    ...context.issue(),
    state: "closed",
    state_reason: "not_planned",
  });
}

function registerDbCloseHook() {
  if (hasRegisteredCloseHook) {
    return;
  }
  hasRegisteredCloseHook = true;

  process.once("beforeExit", () => {
    void closeImdb();
  });
}

async function closeImdb() {
  if (!imdb) {
    return;
  }

  const db = imdb;
  imdb = null;

  try {
    await db.close();
    console.debug("IMDB closed");
  } catch (error) {
    console.error("Failed to close IMDB:", error);
  }
}
