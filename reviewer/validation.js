import yaml from "js-yaml";

/**
 * 验证插件提交Issue的格式。
 * @param {object} issue Issue对象。
 * @returns {Promise<{success: boolean, errors?: string[], pluginData?: object}>} 验证结果。
 */
export async function validateIssueFormat(issue) {
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
  if (!pluginData.author || pluginData.author === "作者名")
    errors.push("请在JSON中提供一个有效的 `author`。");
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
 * 验证仓库中的metadata.yaml文件并与提交的JSON数据进行比较。
 * @param {import('@octokit/core').Octokit} octokit Octokit实例。
 * @param {{owner: string, repo: string}} repoInfo 仓库信息。
 * @param {object} pluginData 从Issue中解析出的插件数据。
 * @returns {Promise<{success: boolean, errors: string[]}>} 验证结果。
 */
export async function validateMetadataYaml(octokit, repoInfo, pluginData) {
  const errors = [];

  try {
    const { data: repo } = await octokit.rest.repos.get(repoInfo);
    const defaultBranch = repo.default_branch;

    let yamlContent;
    try {
      const { data } = await octokit.rest.repos.getContent({
        ...repoInfo,
        path: "metadata.yaml",
        ref: defaultBranch,
      });

      if (!data || !data.content) {
        errors.push("metadata.yaml文件内容为空");
        return { success: false, errors };
      }

      const content = Buffer.from(data.content, "base64").toString("utf8");
      yamlContent = yaml.load(content);
    } catch (error) {
      if (error.status === 404) {
        errors.push("未在仓库中找到必需的metadata.yaml文件");
      } else {
        errors.push(`无法读取metadata.yaml文件: ${error.message}`);
      }
      return { success: false, errors };
    }

    if (!yamlContent) {
      errors.push("无法解析metadata.yaml文件内容");
      return { success: false, errors };
    }

    if (yamlContent.name !== pluginData.name) {
      errors.push(
        `metadata.yaml中的name字段 "${yamlContent.name}" 与JSON中提交的 "${pluginData.name}" 不一致`
      );
    }

    if (yamlContent.author !== pluginData.author) {
      errors.push(
        `metadata.yaml中的author字段 "${yamlContent.author}" 与JSON中提交的 "${pluginData.author}" 不一致`
      );
    }

    if (!yamlContent.version) {
      errors.push("metadata.yaml中缺少必需的version字段");
    }

    const hasDescription = "description" in yamlContent;
    const hasDesc = "desc" in yamlContent;

    if (!hasDescription && !hasDesc) {
      errors.push("metadata.yaml中缺少必需的description或desc字段");
    } else if (hasDescription && hasDesc) {
      errors.push(
        "metadata.yaml中不能同时存在description和desc字段，请只保留其中一个"
      );
    } else {
      const yamlDesc = hasDescription
        ? yamlContent.description
        : yamlContent.desc;
      if (yamlDesc !== pluginData.desc) {
        const fieldName = hasDescription ? "description" : "desc";
        errors.push(
          `metadata.yaml中的${fieldName}字段 "${yamlDesc}" 与JSON中提交的desc "${pluginData.desc}" 不一致`
        );
      }
    }

    if (yamlContent.repo !== pluginData.repo) {
      errors.push(
        `metadata.yaml中的repo字段 "${yamlContent.repo}" 与JSON中提交的 "${pluginData.repo}" 不一致`
      );
    }

    return { success: errors.length === 0, errors };
  } catch (error) {
    octokit.log.error("Unexpected error validating metadata.yaml", { err: error });
    errors.push(`验证metadata.yaml时出现系统错误: ${error.message}`);
    return { success: false, errors };
  }
}
