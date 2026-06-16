import { readFile } from "node:fs/promises";

export async function getVersion(): Promise<string> {
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(url, "utf8")) as { version: string };
  return pkg.version;
}
