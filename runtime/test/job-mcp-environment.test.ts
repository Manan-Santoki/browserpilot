import { describe, expect, test } from "bun:test";
import { browserSubprocessEnv } from "../src/agent/engine/mcp";

describe("job browser MCP environment", () => {
  test("uses the native Unix temp filesystem instead of a Windows mount", () => {
    const env = browserSubprocessEnv({
      PATH: "/usr/bin",
      TMP: "/mnt/c/Users/candidate/AppData/Local/Temp",
      TEMP: "/mnt/c/Users/candidate/AppData/Local/Temp",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
    }, "linux");
    expect(env).toMatchObject({ PATH: "/usr/bin", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("preserves the host temp directory for a native Windows subprocess", () => {
    const env = browserSubprocessEnv({ TEMP: "C:\\Temp" }, "win32");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.TMPDIR).toBeUndefined();
  });
});
