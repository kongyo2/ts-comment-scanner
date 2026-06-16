export interface CliOptions {
  paths: string[];
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const paths: string[] = [];
  let json = false;
  let help = false;
  let version = false;

  for (const arg of argv) {
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      default:
        paths.push(arg);
    }
  }

  return { paths: paths.length > 0 ? paths : ["."], json, help, version };
}
