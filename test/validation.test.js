import { jest, describe, it, expect } from "@jest/globals";
import {
  validateIssueFormat,
  validateMetadataYaml,
} from "../reviewer/validation.js";

function makeValidBody(overrides = {}) {
  const data = {
    name: "TestPlugin",
    desc: "A test plugin",
    author: "testauthor",
    repo: "https://github.com/owner/repo",
    ...overrides,
  };
  return [
    "- [x] 我的插件经过完整的测试",
    "- [x] 我的插件不包含恶意代码",
    "- [x] 我已阅读并同意遵守该项目的 [行为准则](https://docs.github.com/zh/site-policy/github-terms/github-community-code-of-conduct)。",
    "",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
  ].join("\n");
}

function makeValidIssue(overrides = {}) {
  return {
    title: "[Plugin] TestPlugin",
    body: makeValidBody(),
    ...overrides,
  };
}

describe("validateIssueFormat", () => {
  it("succeeds for a valid issue", async () => {
    const result = await validateIssueFormat(makeValidIssue());
    expect(result.success).toBe(true);
    expect(result.pluginData).toEqual({
      name: "TestPlugin",
      desc: "A test plugin",
      author: "testauthor",
      repo: "https://github.com/owner/repo",
    });
  });

  it("fails when title is missing [Plugin] prefix", async () => {
    const result = await validateIssueFormat(
      makeValidIssue({ title: "My Plugin" })
    );
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Issue标题格式不正确")])
    );
  });

  it("fails when title uses placeholder name", async () => {
    const result = await validateIssueFormat(
      makeValidIssue({ title: "[Plugin] 插件名" })
    );
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Issue标题格式不正确")])
    );
  });

  it("accepts case-insensitive [Plugin] prefix", async () => {
    const result = await validateIssueFormat(
      makeValidIssue({ title: "[plugin] MyPlugin" })
    );
    expect(result.success).toBe(true);
  });

  it("fails when required checkboxes are not checked", async () => {
    const body = makeValidBody().replace(/\[x\]/g, "[ ]");
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(3);
    expect(result.errors[0]).toContain("必需的声明未勾选");
  });

  it("fails when a single checkbox is missing", async () => {
    const body = makeValidBody().replace(
      "- [x] 我的插件经过完整的测试",
      "- [ ] 我的插件经过完整的测试"
    );
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("fails when JSON block is missing", async () => {
    const body = [
      "- [x] 我的插件经过完整的测试",
      "- [x] 我的插件不包含恶意代码",
      "- [x] 我已阅读并同意遵守该项目的 [行为准则](https://docs.github.com/zh/site-policy/github-terms/github-community-code-of-conduct)。",
      "No JSON here",
    ].join("\n");
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("未找到JSON代码块")])
    );
  });

  it("fails on invalid JSON syntax", async () => {
    const body = [
      "- [x] 我的插件经过完整的测试",
      "- [x] 我的插件不包含恶意代码",
      "- [x] 我已阅读并同意遵守该项目的 [行为准则](https://docs.github.com/zh/site-policy/github-terms/github-community-code-of-conduct)。",
      "```json",
      "{ invalid json }",
      "```",
    ].join("\n");
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("JSON格式错误")])
    );
  });

  it("fails when name is missing", async () => {
    const body = makeValidBody({ name: "" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("`name`")])
    );
  });

  it("fails when name is placeholder value", async () => {
    const body = makeValidBody({ name: "插件名" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("`name`")])
    );
  });

  it("fails when desc is missing", async () => {
    const body = makeValidBody({ desc: "" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("`desc`")])
    );
  });

  it("fails when desc is placeholder value", async () => {
    const body = makeValidBody({ desc: "插件介绍" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
  });

  it("fails when author is missing", async () => {
    const body = makeValidBody({ author: "" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("`author`")])
    );
  });

  it("fails when author is placeholder value", async () => {
    const body = makeValidBody({ author: "作者名" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
  });

  it("fails when repo is missing", async () => {
    const body = makeValidBody({ repo: "" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("`repo`")])
    );
  });

  it("fails when repo is not on github.com", async () => {
    const body = makeValidBody({ repo: "https://gitlab.com/owner/repo" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("github.com")])
    );
  });

  it("fails when repo is not a valid URL", async () => {
    const body = makeValidBody({ repo: "not-a-url" });
    const result = await validateIssueFormat(makeValidIssue({ body }));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("无效")])
    );
  });

  it("handles empty body gracefully", async () => {
    const result = await validateIssueFormat({ title: "[Plugin] Test", body: "" });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles null body gracefully", async () => {
    const result = await validateIssueFormat({
      title: "[Plugin] Test",
      body: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("validateMetadataYaml", () => {
  const pluginData = {
    name: "TestPlugin",
    desc: "A test plugin",
    author: "testauthor",
    repo: "https://github.com/owner/repo",
  };

  const repoInfo = { owner: "owner", repo: "repo" };

  function makeYaml(fields) {
    return Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }

  function createMockOctokit(yamlContent, overrides = {}) {
    return {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      rest: {
        repos: {
          get: jest.fn().mockResolvedValue({
            data: { default_branch: "main" },
          }),
          getContent:
            overrides.getContent ||
            jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(yamlContent).toString("base64"),
              },
            }),
        },
      },
    };
  }

  it("succeeds when metadata matches plugin data with desc field", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      version: "1.0.0",
      desc: "A test plugin",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("succeeds when metadata uses description instead of desc", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      version: "1.0.0",
      description: "A test plugin",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(true);
  });

  it("fails when metadata.yaml is not found (404)", async () => {
    const error = new Error("Not Found");
    error.status = 404;
    const octokit = createMockOctokit("", {
      getContent: jest.fn().mockRejectedValue(error),
    });
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("未在仓库中找到")])
    );
  });

  it("fails when metadata.yaml content is empty", async () => {
    const octokit = createMockOctokit("", {
      getContent: jest.fn().mockResolvedValue({
        data: { content: null },
      }),
    });
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("内容为空")])
    );
  });

  it("fails when name does not match", async () => {
    const yaml = makeYaml({
      name: "WrongName",
      author: "testauthor",
      version: "1.0.0",
      desc: "A test plugin",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("name字段")])
    );
  });

  it("fails when author does not match", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "wrongauthor",
      version: "1.0.0",
      desc: "A test plugin",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("author字段")])
    );
  });

  it("fails when version is missing", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      desc: "A test plugin",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("version字段")])
    );
  });

  it("fails when both description and desc are present", async () => {
    const yaml = [
      "name: TestPlugin",
      "author: testauthor",
      "version: 1.0.0",
      "desc: A test plugin",
      "description: A test plugin",
      "repo: https://github.com/owner/repo",
    ].join("\n");
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("不能同时存在description和desc"),
      ])
    );
  });

  it("fails when neither description nor desc is present", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      version: "1.0.0",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("缺少必需的description或desc字段"),
      ])
    );
  });

  it("fails when desc value does not match", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      version: "1.0.0",
      desc: "Wrong description",
      repo: "https://github.com/owner/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("desc字段")])
    );
  });

  it("fails when repo does not match", async () => {
    const yaml = makeYaml({
      name: "TestPlugin",
      author: "testauthor",
      version: "1.0.0",
      desc: "A test plugin",
      repo: "https://github.com/other/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("repo字段")])
    );
  });

  it("handles API errors gracefully", async () => {
    const error = new Error("Server error");
    error.status = 500;
    const octokit = createMockOctokit("", {
      getContent: jest.fn().mockRejectedValue(error),
    });
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("无法读取")])
    );
  });

  it("collects multiple errors at once", async () => {
    const yaml = makeYaml({
      name: "WrongName",
      author: "wrongauthor",
      desc: "Wrong desc",
      repo: "https://github.com/wrong/repo",
    });
    const octokit = createMockOctokit(yaml);
    const result = await validateMetadataYaml(octokit, repoInfo, pluginData);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});
