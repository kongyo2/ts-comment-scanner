import { parseArgs } from "./args.js";
import { scanPaths, stripPaths } from "./files.js";
import { formatJson, formatStripSummary, formatText } from "./report.js";
import { getVersion } from "./version.js";

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const HELP_TEXT = `Usage: ts-comment-scanner [options] [paths...]

Detect and report comments across a TypeScript project.

Options:
  --json         Output results as JSON
  --strip        Remove comments and write the result to stdout
  --write        With --strip, rewrite the matched files in place
  -v, --version  Print the version number
  -h, --help     Show this help

Paths default to the current directory. Directories are scanned recursively
for .ts, .tsx, .mts and .cts files, skipping node_modules and .git.

Examples:
  ts-comment-scanner src
  ts-comment-scanner --json src test
  ts-comment-scanner --strip src/file.ts > stripped.ts
  ts-comment-scanner --strip --write src
`;

export async function run(argv: string[], io: CliIO): Promise<number> {
  const options = parseArgs(argv);

  if (options.help) {
    io.out(HELP_TEXT);
    return 0;
  }

  if (options.version) {
    io.out(`${await getVersion()}\n`);
    return 0;
  }

  try {
    if (options.strip) {
      const results = await stripPaths(options.paths, { write: options.write });
      if (options.write) {
        io.out(`${formatStripSummary(results)}\n`);
      } else {
        for (const result of results) {
          io.out(result.output);
        }
      }
      return 0;
    }

    const results = await scanPaths(options.paths);
    io.out(`${options.json ? formatJson(results) : formatText(results)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`ts-comment-scanner: ${message}\n`);
    return 1;
  }
}
