import { describe, expect, it } from "vitest";
import { parseStateDirFromLsofOutput } from "./state.js";

describe("state helpers", () => {
  it("extracts the proxy state directory from lsof output", () => {
    const output = `
p12345
n/Users/elisoncampos/.local-router/routes.json
n/Users/elisoncampos/.local-router/proxy-state.json
`;

    expect(parseStateDirFromLsofOutput(output)).toBe("/Users/elisoncampos/.local-router");
  });

  it("returns undefined when no proxy state files are open", () => {
    const output = `
p12345
n/Users/elisoncampos/project/package.json
`;

    expect(parseStateDirFromLsofOutput(output)).toBeUndefined();
  });
});
