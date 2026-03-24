import { describe, expect, it } from "vitest";
import { extractChildCommandFromProcessCommand } from "./process-info.js";

describe("extractChildCommandFromProcessCommand", () => {
  it("extracts the child command from a dist cli invocation", () => {
    const command =
      "/Users/elisoncampos/.asdf/installs/nodejs/22.13.1/bin/node /Users/elisoncampos/.npm/_npx/e40bc084790ace39/node_modules/@elisoncampos/local-router/dist/cli.js run next dev";

    expect(extractChildCommandFromProcessCommand(command)).toBe("next dev");
  });

  it("extracts the child command from a launcher invocation", () => {
    const command = "/usr/local/bin/local-router run npm run start:dev";

    expect(extractChildCommandFromProcessCommand(command)).toBe("npm run start:dev");
  });

  it("returns undefined when the process is not a local-router run command", () => {
    expect(extractChildCommandFromProcessCommand("node server.js")).toBeUndefined();
  });
});
