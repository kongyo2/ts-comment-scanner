import { describe, it, expect, afterEach, vi } from "vitest";
import { getVersion } from "./version.js";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

/** Re-imports the CLI entry point so its top-level code runs with the given argv. */
async function runCli(...args: string[]): Promise<void> {
  process.argv = ["node", "ts-comment-scanner", ...args];
  vi.resetModules();
  await import("./cli.js");
}

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("cli", () => {
  it("wires stdout and the exit code up to run", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli("--version");

    expect(write).toHaveBeenCalledWith(`${await getVersion()}\n`);
    expect(process.exitCode).toBe(0);
  });

  it("wires stderr up and reports failures through the exit code", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli("--no-such-flag");

    expect(write).toHaveBeenCalledWith(expect.stringContaining("unknown option: --no-such-flag"));
    expect(process.exitCode).toBe(2);
  });
});
