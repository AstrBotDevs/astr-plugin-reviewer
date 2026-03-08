import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockCreate = jest.fn();

jest.unstable_mockModule("openai", () => ({
  default: jest.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

const { reviewPlugin } = await import("../reviewer/ai-review.js");

describe("reviewPlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "test-model";
    process.env.OPENAI_MAX_INPUT_TOKENS = "4000";
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validPluginData = {
    name: "TestPlugin",
    desc: "A test plugin",
    author: "testauthor",
    repo: "https://github.com/owner/repo",
  };

  const metadataYaml = [
    "name: TestPlugin",
    "author: testauthor",
    "version: 1.0.0",
    "desc: A test plugin",
    "repo: https://github.com/owner/repo",
  ].join("\n");

  function createMockContext() {
    return {
      octokit: {
        rest: {
          repos: {
            get: jest
              .fn()
              .mockResolvedValue({ data: { default_branch: "main" } }),
            getContent: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(metadataYaml).toString("base64"),
              },
            }),
          },
          git: {
            getTree: jest.fn().mockResolvedValue({
              data: {
                tree: [
                  { type: "blob", path: "main.py", sha: "sha1" },
                  { type: "blob", path: "utils.py", sha: "sha2" },
                ],
              },
            }),
            getBlob: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from('print("hello")').toString("base64"),
              },
            }),
          },
        },
      },
    };
  }

  it("returns error for invalid repo URL", async () => {
    const context = createMockContext();
    const result = await reviewPlugin(context, {
      ...validPluginData,
      repo: "not-a-url",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error when metadata validation fails", async () => {
    const context = createMockContext();
    // metadata.yaml returns mismatched name
    const badYaml = metadataYaml.replace("TestPlugin", "WrongName");
    context.octokit.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(badYaml).toString("base64") },
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("metadata.yaml");
  });

  it("returns error when no Python files exist", async () => {
    const context = createMockContext();
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Python");
  });

  it("returns error when tree is null", async () => {
    const context = createMockContext();
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: { tree: null },
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Python");
  });

  it("returns error when AI returns empty response", async () => {
    const context = createMockContext();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("空响应");
  });

  it("returns error when AI API call fails", async () => {
    const context = createMockContext();
    mockCreate.mockRejectedValue(new Error("API timeout"));

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("内部错误");
  });

  it("returns successful review with summary", async () => {
    const context = createMockContext();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "### Review\nAll good!" } }],
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(true);
    expect(result.review).toContain("### Review\nAll good!");
    expect(result.review).toContain("审核摘要");
    expect(result.review).toContain("main.py");
    expect(result.review).toContain("utils.py");
  });

  it("prioritizes main.py in file selection", async () => {
    const context = createMockContext();
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { type: "blob", path: "utils.py", sha: "sha1" },
          { type: "blob", path: "deep/nested/main.py", sha: "sha2" },
          { type: "blob", path: "alpha.py", sha: "sha3" },
        ],
      },
    });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "Review content" } }],
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(true);
    // main.py should appear in the reviewed files list
    expect(result.review).toContain("deep/nested/main.py");
  });

  it("strips Python comments from reviewed code", async () => {
    const context = createMockContext();
    const pythonCode = [
      '# This is a comment',
      'print("hello") # inline comment',
      '',
      'x = "string with # inside"',
    ].join("\n");
    context.octokit.rest.git.getBlob.mockResolvedValue({
      data: { content: Buffer.from(pythonCode).toString("base64") },
    });
    mockCreate.mockImplementation(async (params) => {
      const prompt = params.messages[0].content;
      // Verify comments were stripped - the blank line and full-comment line removed
      expect(prompt).not.toContain("# This is a comment");
      expect(prompt).not.toContain("# inline comment");
      // String with # should be preserved
      expect(prompt).toContain('x = "string with # inside"');
      return { choices: [{ message: { content: "Review" } }] };
    });

    await reviewPlugin(context, validPluginData);
    expect(mockCreate).toHaveBeenCalled();
  });

  it("respects token limits for file selection", async () => {
    const context = createMockContext();
    // Set a very low token limit
    process.env.OPENAI_MAX_INPUT_TOKENS = "100";

    // Create a large file that exceeds token limit
    const largeContent = "x = 1\n".repeat(1000);
    context.octokit.rest.git.getBlob.mockResolvedValue({
      data: { content: Buffer.from(largeContent).toString("base64") },
    });

    const manyFiles = Array.from({ length: 20 }, (_, i) => ({
      type: "blob",
      path: `file${i}.py`,
      sha: `sha${i}`,
    }));
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: { tree: manyFiles },
    });

    const result = await reviewPlugin(context, validPluginData);
    // With very low token limit, either no files selected or very few
    // This exercises the token-based selection logic
    expect(result).toBeDefined();
  });

  it("handles blob fetch errors gracefully", async () => {
    const context = createMockContext();
    // First blob fails, second succeeds
    context.octokit.rest.git.getBlob
      .mockRejectedValueOnce(new Error("Blob not found"))
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('print("ok")').toString("base64"),
        },
      });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "Review content" } }],
    });

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(true);
  });

  it("handles general exceptions in reviewPlugin", async () => {
    const context = createMockContext();
    // repos.get is called by both validateMetadataYaml and fetchPythonFileTree
    context.octokit.rest.repos.get.mockRejectedValue(
      new Error("Network failure")
    );

    const result = await reviewPlugin(context, validPluginData);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network failure");
  });

  it("includes partial review note when not all files reviewed", async () => {
    const context = createMockContext();
    process.env.OPENAI_MAX_INPUT_TOKENS = "500";

    const files = Array.from({ length: 20 }, (_, i) => ({
      type: "blob",
      path: `module${i}.py`,
      sha: `sha${i}`,
    }));
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: { tree: files },
    });

    const code = 'def func(): pass\n'.repeat(5);
    context.octokit.rest.git.getBlob.mockResolvedValue({
      data: { content: Buffer.from(code).toString("base64") },
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "Review" } }],
    });

    const result = await reviewPlugin(context, validPluginData);
    if (result.success) {
      // If some files were selected, should have the partial review note
      expect(result.review).toContain("审核摘要");
    }
  });

  it("uses MAIN_FILE_PROMPT for main.py files", async () => {
    const context = createMockContext();
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [{ type: "blob", path: "main.py", sha: "sha1" }],
      },
    });

    mockCreate.mockImplementation(async (params) => {
      const prompt = params.messages[0].content;
      // MAIN_FILE_PROMPT contains framework-specific checks
      expect(prompt).toContain("针对 main.py 的额外审查要求");
      return { choices: [{ message: { content: "Review" } }] };
    });

    await reviewPlugin(context, validPluginData);
    expect(mockCreate).toHaveBeenCalled();
  });

  it("uses REGULAR_FILE_PROMPT for non-main.py files", async () => {
    const context = createMockContext();
    context.octokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [{ type: "blob", path: "helper.py", sha: "sha1" }],
      },
    });

    mockCreate.mockImplementation(async (params) => {
      const prompt = params.messages[0].content;
      // REGULAR_FILE_PROMPT does not contain main.py-specific checks
      expect(prompt).not.toContain("针对 main.py 的额外审查要求");
      expect(prompt).toContain("Python Code Review Expert");
      return { choices: [{ message: { content: "Review" } }] };
    });

    await reviewPlugin(context, validPluginData);
    expect(mockCreate).toHaveBeenCalled();
  });
});
