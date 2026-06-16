import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("defaults to scanning the current directory when no paths are given", () => {
    expect(parseArgs([])).toEqual({
      paths: ["."],
      json: false,
      help: false,
      version: false,
      strip: false,
      write: false,
    });
  });

  it("collects positional paths", () => {
    expect(parseArgs(["src", "lib/index.ts"]).paths).toEqual(["src", "lib/index.ts"]);
  });

  it("sets json when --json is passed", () => {
    const options = parseArgs(["--json", "src"]);

    expect(options.json).toBe(true);
    expect(options.paths).toEqual(["src"]);
  });

  it("sets help for -h and --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("sets version for -v and --version", () => {
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("sets strip when --strip is passed", () => {
    expect(parseArgs(["--strip"]).strip).toBe(true);
  });

  it("sets write when --write is passed", () => {
    expect(parseArgs(["--write"]).write).toBe(true);
  });

  it("defaults strip and write to false", () => {
    const options = parseArgs([]);

    expect(options.strip).toBe(false);
    expect(options.write).toBe(false);
  });
});
