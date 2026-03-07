import { REQUIRED_ENV_VARS } from "./constants.js";

/**
 * 验证所有必需的环境变量是否都已设置。
 */
export function validateEnvironment() {
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
export function getConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || null,
    model: process.env.OPENAI_MODEL,
    maxInputTokens: parseInt(process.env.OPENAI_MAX_INPUT_TOKENS, 10) || 4000,
  };
}
