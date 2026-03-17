import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockDb = {
  get: jest.fn(),
  putSync: jest.fn(),
  removeSync: jest.fn().mockReturnValue(true),
  transactionSync: jest.fn((fn) => fn()),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule("lmdb", () => ({
  open: jest.fn(() => mockDb),
}));

const {
  initializeImdb,
  getIssueIdForRepo,
  markIssueForRepo,
  removeIssueForRepoIfMatch,
} = await import("../reviewer/issue-dedup.js");

initializeImdb();

describe("imdb", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockReturnValue(undefined);
    mockDb.transactionSync.mockImplementation((fn) => fn());
  });

  it("returns issue id for existing repo mapping", () => {
    mockDb.get.mockReturnValue(123);
    const result = getIssueIdForRepo("owner/repo");
    expect(result).toBe(123);
  });

  it("returns null for invalid stored value", () => {
    mockDb.get.mockReturnValue("abc");
    const result = getIssueIdForRepo("owner/repo");
    expect(result).toBeNull();
  });

  it("writes issue mapping successfully", () => {
    const result = markIssueForRepo("owner/repo", 88);
    expect(result).toBe(88);
    expect(mockDb.putSync).toHaveBeenCalledWith("owner/repo", 88);
  });

  it("returns null for invalid mapping input", () => {
    const result = markIssueForRepo("owner/repo", 0);
    expect(result).toBeNull();
    expect(mockDb.putSync).not.toHaveBeenCalled();
  });

  it("removes mapping when repo and issue id both match", () => {
    mockDb.get.mockReturnValue(77);
    const removed = removeIssueForRepoIfMatch("owner/repo", 77);
    expect(removed).toBe(true);
    expect(mockDb.removeSync).toHaveBeenCalledWith("owner/repo");
  });

  it("does not remove mapping when issue id does not match", () => {
    mockDb.get.mockReturnValue(66);
    const removed = removeIssueForRepoIfMatch("owner/repo", 77);
    expect(removed).toBe(false);
    expect(mockDb.removeSync).not.toHaveBeenCalled();
  });
});
