import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "./files.js";

// A Windows-flavoured path module: everything real except the separator, so
// the posix-normalisation branches run on a Linux/macOS test host too.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, sep: "\\" };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcs-win-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function onWin32<T>(action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("collectFiles on Windows-like platforms", () => {
  it("collapses input paths that differ only by case", async () => {
    await writeFile(join(dir, "CASED.ts"), "// upper\n");
    await writeFile(join(dir, "cased.ts"), "// lower\n");

    const files = await onWin32(() => collectFiles([join(dir, "CASED.ts"), join(dir, "cased.ts")]));

    expect(files).toEqual([join(dir, "CASED.ts")]);
  });

  it("still matches ignore globs when the path separator is a backslash", async () => {
    await writeFile(join(dir, "a.ts"), "// keep\n");
    await writeFile(join(dir, "a.skip.ts"), "// skip\n");

    const files = await collectFiles([dir], { ignore: ["*.skip.ts"] });

    expect(files).toEqual([join(dir, "a.ts")]);
  });
});
