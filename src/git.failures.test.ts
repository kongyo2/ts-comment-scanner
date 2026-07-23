import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { changedFiles } from "./git.js";

// Replacing execFile lets these tests dictate exactly how the git process
// fails; the real spawn behaviour is covered by git.test.ts.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type ExecFileCallback = (error: unknown, stdout: string, stderr: string) => void;

const execFileMock = vi.mocked(execFile);

function gitFailsWith(error: unknown): void {
  execFileMock.mockImplementationOnce(((...args: unknown[]) => {
    (args[args.length - 1] as ExecFileCallback)(error, "", "");
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("changedFiles when git cannot run", () => {
  it("explains a missing git executable", async () => {
    gitFailsWith(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));

    await expect(changedFiles("HEAD")).rejects.toThrow(/git executable not found/);
  });

  it("reports only the first line of a multi-line git stderr", async () => {
    gitFailsWith(Object.assign(new Error("exit 128"), { stderr: "fatal: broken\nhint: try --help\n" }));

    await expect(changedFiles("HEAD")).rejects.toThrow("git rev-parse failed: fatal: broken");
  });

  it("falls back to the error message when git produced no stderr", async () => {
    gitFailsWith(Object.assign(new Error("spawn failed"), { stderr: "" }));

    await expect(changedFiles("HEAD")).rejects.toThrow("git rev-parse failed: spawn failed");
  });

  it("stringifies failures that carry neither stderr nor a message", async () => {
    gitFailsWith({ code: 128 });

    await expect(changedFiles("HEAD")).rejects.toThrow("git rev-parse failed: [object Object]");
  });
});
