import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { getVersion } from "./version.js";

describe("getVersion", () => {
  it("returns the version declared in package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    expect(await getVersion()).toBe(pkg.version);
  });
});
