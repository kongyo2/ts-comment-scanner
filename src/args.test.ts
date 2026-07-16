import { describe, it, expect } from "vitest";
import { parseArgs, UsageError } from "./args.js";

describe("parseArgs", () => {
  it("defaults to scanning the current directory when no paths are given", () => {
    expect(parseArgs([])).toEqual({
      paths: ["."],
      format: "text",
      ignore: [],
      extensions: undefined,
      diff: undefined,
      directives: "include",
      failOnComment: false,
      remove: false,
      removeDirectives: false,
      removeLegal: false,
      dryRun: false,
      help: false,
      version: false,
    });
  });

  it("collects positional paths", () => {
    expect(parseArgs(["src", "lib/index.ts"]).paths).toEqual(["src", "lib/index.ts"]);
  });

  it("sets the json format when --json is passed", () => {
    const options = parseArgs(["--json", "src"]);

    expect(options.format).toBe("json");
    expect(options.paths).toEqual(["src"]);
  });

  it("accepts --format with a separate or inline value", () => {
    expect(parseArgs(["--format", "github"]).format).toBe("github");
    expect(parseArgs(["--format=json"]).format).toBe("json");
    expect(parseArgs(["--format", "text"]).format).toBe("text");
  });

  it("rejects an unknown format", () => {
    expect(() => parseArgs(["--format", "xml"])).toThrow(UsageError);
  });

  it("rejects a missing option value", () => {
    expect(() => parseArgs(["--format"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--ignore"])).toThrow(/requires a value/);
  });

  it("rejects unknown options instead of treating them as paths", () => {
    expect(() => parseArgs(["--jsno"])).toThrow(/unknown option: --jsno/);
    expect(() => parseArgs(["-x"])).toThrow(UsageError);
  });

  it("collects repeatable ignore patterns", () => {
    expect(parseArgs(["--ignore", "*.test.ts", "--ignore=dist/**"]).ignore).toEqual(["*.test.ts", "dist/**"]);
  });

  it("parses comma-separated extension lists", () => {
    expect(parseArgs(["--ext", ".ts, .mts"]).extensions).toEqual([".ts", ".mts"]);
    expect(parseArgs(["--ext=js", "--ext=jsx"]).extensions).toEqual(["js", "jsx"]);
  });

  it("rejects an --ext value that contains no extensions", () => {
    expect(() => parseArgs(["--ext", ""])).toThrow(/at least one extension/);
    expect(() => parseArgs(["--ext", " , "])).toThrow(UsageError);
  });

  it("accepts --diff with a separate or inline value", () => {
    expect(parseArgs(["--diff", "main..HEAD"]).diff).toBe("main..HEAD");
    expect(parseArgs(["--diff=HEAD"]).diff).toBe("HEAD");
  });

  it("rejects an empty or flag-like --diff value", () => {
    expect(() => parseArgs(["--diff", ""])).toThrow(/revision range/);
    expect(() => parseArgs(["--diff", "--remove"])).toThrow(/revision range/);
    expect(() => parseArgs(["--diff"])).toThrow(/requires a value/);
  });

  it("maps directive flags onto the directives mode", () => {
    expect(parseArgs([]).directives).toBe("include");
    expect(parseArgs(["--skip-directives"]).directives).toBe("skip");
    expect(parseArgs(["--only-directives"]).directives).toBe("only");
  });

  it("rejects combining --skip-directives with --only-directives", () => {
    expect(() => parseArgs(["--skip-directives", "--only-directives"])).toThrow(UsageError);
  });

  it("parses removal flags", () => {
    const options = parseArgs(["--remove", "--remove-directives", "--remove-legal", "--dry-run", "src"]);

    expect(options).toMatchObject({ remove: true, removeDirectives: true, removeLegal: true, dryRun: true });
  });

  it("rejects removal modifiers without --remove", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/requires --remove/);
    expect(() => parseArgs(["--remove-directives"])).toThrow(/requires --remove/);
    expect(() => parseArgs(["--remove-legal"])).toThrow(/requires --remove/);
  });

  it("rejects contradictory remove combinations", () => {
    expect(() => parseArgs(["--remove", "--fail-on-comment"])).toThrow(UsageError);
    expect(() => parseArgs(["--remove", "--format", "github"])).toThrow(UsageError);
  });

  it("rejects the no-op --remove --only-directives without --remove-directives", () => {
    expect(() => parseArgs(["--remove", "--only-directives"])).toThrow(/--remove-directives/);
    expect(parseArgs(["--remove", "--only-directives", "--remove-directives"]).directives).toBe("only");
  });

  it("rejects the pointless --remove-directives with --skip-directives", () => {
    expect(() => parseArgs(["--remove", "--skip-directives", "--remove-directives"])).toThrow(UsageError);
  });

  it("sets failOnComment for --fail-on-comment", () => {
    expect(parseArgs(["--fail-on-comment"]).failOnComment).toBe(true);
  });

  it("treats everything after -- as paths", () => {
    expect(parseArgs(["--", "--json", "-h"]).paths).toEqual(["--json", "-h"]);
  });

  it("rejects a value glued to a boolean flag", () => {
    expect(() => parseArgs(["--json=yes"])).toThrow(/does not take a value/);
  });

  it("sets help for -h and --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("sets version for -v and --version", () => {
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });
});
