import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeJsonPath } from "../../src/install/claude-config.js";
import { registerSettings, unregisterSettings } from "../../src/install/register.js";

const repoHooks = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
type Entry = { matcher?: string; hooks: { type: string; command: string }[] };

const ENV = ["CLAUDE_CONFIG_DIR", "HOME", "EMINIAR_HOME"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let claudeDir: string;

beforeAll(() => {
  // The settings method also writes the MCP server to .claude.json: keep it off the real one.
  process.env.HOME = mkdtempSync(join(tmpdir(), "em-userhome-"));
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
});
beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "em-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A stable copy with the real hooks/hooks.json, the way materialize leaves it. */
function stableCopy(prefix = "em-stable-", hooksJson = readFileSync(repoHooks, "utf8")): string {
  const stable = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(stable, "bin"));
  mkdirSync(join(stable, "hooks"));
  writeFileSync(join(stable, "hooks", "hooks.json"), hooksJson);
  mkdirSync(join(stable, "skills", "em-docs"), { recursive: true });
  writeFileSync(join(stable, "skills", "em-docs", "SKILL.md"), "---\nname: em-docs\n---\n");
  return stable;
}
/** hooks.json's table as the settings method must write it for `stable`. */
function pluginTable(stable: string): Record<string, Entry[]> {
  const raw = readFileSync(repoHooks, "utf8").replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, () => stable);
  return JSON.parse(raw).hooks;
}
const settingsFile = () => join(claudeDir, "settings.json");
const writeSettings = (hooks: Record<string, Entry[]>) =>
  writeFileSync(settingsFile(), JSON.stringify({ hooks }));
const readHooks = () =>
  (JSON.parse(readFileSync(settingsFile(), "utf8")).hooks ?? {}) as Record<string, Entry[]>;
const hook = (command: string) => ({ type: "command", command });

describe("registerSettings", () => {
  it("writes the plugin's hooks.json entries and replaces an older registration", () => {
    const stable = stableCopy();
    const oldHook = hook(`"${join(stable, "bin", "em-hook")}"`);
    const mine = { matcher: "Bash", hooks: [hook("./hooks/mine.sh")] };
    // What an install before this change wrote: the narrow matcher, plus our entry on an event
    // hooks.json does not list.
    writeSettings({
      PreToolUse: [
        mine,
        {
          matcher: "^(Bash|Read|Grep|Glob|WebFetch|Agent|Task|mcp__.*__em_swarm)$",
          hooks: [{ ...oldHook, timeout: 10 } as Entry["hooks"][0]],
        },
      ],
      Notification: [{ hooks: [oldHook] }],
    });

    const wrote = registerSettings(stable);
    registerSettings(stable); // a second run must not duplicate

    const plugin = pluginTable(stable);
    const hooks = readHooks();
    expect(wrote.hookEvents).toEqual(Object.keys(plugin));
    expect(hooks).toEqual({ ...plugin, PreToolUse: [mine, ...(plugin.PreToolUse ?? [])] });
    expect(JSON.stringify(hooks)).not.toContain(`\${CLAUDE_PLUGIN_`);
    const matcher = new RegExp(hooks.PreToolUse?.[1]?.matcher ?? "$^");
    for (const tool of ["Edit", "MultiEdit", "Write", "WebSearch", "Bash", "Read"])
      expect(matcher.test(tool)).toBe(true);
    const cj = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    expect(cj.mcpServers.eminiar.command).toBe(join(stable, "bin", "em-server"));

    // Uninstall sweeps every event too, not only the recorded ones.
    writeSettings({ ...readHooks(), Notification: [{ hooks: [oldHook] }] });
    unregisterSettings(stable, wrote);
    expect(readHooks()).toEqual({ PreToolUse: [mine] });
  });

  it("removes only our hooks: a user's hook in the same entry, or one running eminiar, stays", () => {
    const stable = stableCopy();
    const ours = hook(`"${join(stable, "bin", "em-hook")}"`);
    const lint = hook("./mine-lint.sh");
    const stats = hook("~/.eminiar/plugin/node_modules/.bin/eminiar stats --notify");
    writeSettings({
      PreToolUse: [{ matcher: "Bash", hooks: [lint, ours] }],
      Notification: [{ hooks: [stats] }],
    });

    const wrote = registerSettings(stable);
    const hooks = readHooks();
    expect(hooks.PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [lint] });
    expect(hooks.Notification).toEqual([{ hooks: [stats] }]);

    unregisterSettings(stable, wrote);
    expect(readHooks()).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [lint] }],
      Notification: [{ hooks: [stats] }],
    });
  });

  it("fills a stable root holding `$&` or `$$` literally", () => {
    const stable = stableCopy("em-st$&$$-");
    registerSettings(stable);
    expect(readHooks().SessionStart?.[0]?.hooks[0]?.command).toBe(
      `"${join(stable, "bin", "em-hook")}"`,
    );
    expect(readHooks()).toEqual(pluginTable(stable));
  });

  it("refuses a hooks.json it cannot use rather than write broken commands", () => {
    const table = { hooks: { Stop: [{ hooks: [hook(`"\${CLAUDE_PLUGIN_DATA}/bin/em-hook"`)] }] } };
    const stable = stableCopy("em-stable-", JSON.stringify(table));
    expect(() => registerSettings(stable)).toThrow(/cannot fill the variable/);
    rmSync(join(stable, "hooks", "hooks.json"));
    expect(() => registerSettings(stable)).toThrow(/hooks\.json is missing/);
  });
});
