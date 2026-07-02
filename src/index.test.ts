import { describe, it, expect } from "vitest";
import * as api from "./index.js";

describe("public API", () => {
  it("exposes the scanning, removal and formatting functions", () => {
    expect(typeof api.scanComments).toBe("function");
    expect(typeof api.collectFiles).toBe("function");
    expect(typeof api.scanFile).toBe("function");
    expect(typeof api.scanPaths).toBe("function");
    expect(typeof api.isJsxFile).toBe("function");
    expect(typeof api.removeComments).toBe("function");
    expect(typeof api.detectDirective).toBe("function");
    expect(typeof api.isLegalComment).toBe("function");
    expect(typeof api.formatText).toBe("function");
    expect(typeof api.formatJson).toBe("function");
    expect(typeof api.formatGitHub).toBe("function");
  });

  it("scans a string end to end through the public entry", () => {
    expect(api.scanComments("// hi")).toHaveLength(1);
  });

  it("removes comments end to end through the public entry", () => {
    expect(api.removeComments("// bye\nconst x = 1;\n").code).toBe("const x = 1;\n");
  });
});
