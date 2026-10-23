// Points Claude Code's user settings at the glaude proxy, or removes that again.
//   node claude-settings.mjs set <proxy-url> <glaude-path>
//   node claude-settings.mjs unset
//   node claude-settings.mjs status
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
const [action, proxyUrl, glaudePath] = process.argv.slice(2);
const MARKER = "--api-key-helper";

const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const ours = typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.includes(MARKER);

function save() {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.glaude-backup`);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

if (action === "set") {
  if (settings.apiKeyHelper && !ours) {
    console.error(`glaude: ${file} already has an apiKeyHelper (${settings.apiKeyHelper}); remove it first.`);
    process.exit(1);
  }
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: proxyUrl };
  settings.apiKeyHelper = `'${glaudePath.replaceAll("'", "'\\''")}' ${MARKER}`;
  save();
  console.log(`Plain \`claude\` now uses Gloo via ${proxyUrl} (${file}).`);
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (settings.env[key]) console.warn(`glaude: note: env.${key} in ${file} takes precedence over the proxy token.`);
  }
} else if (action === "unset") {
  if (!ours) {
    console.log("Plain `claude` was not routed through glaude; nothing to change.");
    process.exit(0);
  }
  delete settings.apiKeyHelper;
  if (settings.env) {
    delete settings.env.ANTHROPIC_BASE_URL;
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  save();
  console.log("Plain `claude` is back to its normal Anthropic login.");
} else if (action === "status") {
  console.log(ours ? `routed through glaude (${settings.env?.ANTHROPIC_BASE_URL})` : "not routed through glaude");
} else {
  console.error("usage: claude-settings.mjs set <proxy-url> <glaude-path> | unset | status");
  process.exit(2);
}
