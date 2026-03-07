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

export function initializeTriggerCountDb() {
  if (triggerCountDb) return;

  fs.mkdirSync(path.dirname(TRIGGER_COUNT_DB_PATH), { recursive: true });
  triggerCountDb = open({
    path: TRIGGER_COUNT_DB_PATH,
  });
  registerDbCloseHook();
}

export function getReviewTriggerQuotaForIssue(issue) {
  const repoUrl = extractRepoUrlFromIssueBody(issue?.body || "");
  const repoKey = normalizePluginRepoKey(repoUrl);

  if (!repoKey) {
    return null;
  }

  return getReviewTriggerQuotaForRepo(repoKey);
}

export function markReviewTriggerSuccessForRepo(repoKey) {
  if (!repoKey) {
    return null;
  }

  initializeTriggerCountDb();
  const maxTriggers = getMaxReviewTriggersPerRepo();

  return triggerCountDb.transactionSync(() => {
    const currentCount = getCurrentTriggerCount(repoKey);

    if (currentCount >= maxTriggers) {
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

function getCurrentTriggerCount(repoKey) {
  const currentCount = triggerCountDb.get(repoKey);
  return Number.isFinite(currentCount) ? Number(currentCount) : 0;
}

function registerDbCloseHook() {
  if (hasRegisteredCloseHook) {
    return;
  }
  hasRegisteredCloseHook = true;

  process.once("beforeExit", () => {
    void closeTriggerCountDb();
  });
}

async function closeTriggerCountDb() {
  if (!triggerCountDb) {
    return;
  }

  const db = triggerCountDb;
  triggerCountDb = null;

  try {
    await db.close();
  } catch (error) {
    console.error("Failed to close trigger count DB:", error);
  }
}

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
