const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = {
  entry: async (params, settings) => {
    const { app, quickAddApi, obsidian, abort } = params;
    if (!(app.vault.adapter instanceof obsidian.FileSystemAdapter)) {
      abort("Wiki lint needs desktop Obsidian.");
    }

    const apply = await quickAddApi.yesNoPrompt(
      "Apply mechanical fixes?",
      "Yes = fix broken links / obvious orphans notes. No = report only."
    );

    const vaultPath = app.vault.adapter.getBasePath();
    const grokBin = resolveGrokBin(settings["Grok binary"]);
    const extra = (settings["Extra flags"] || "").trim();

    const prompt = [
      "Follow AGENTS.md. This vault is an LLM Wiki.",
      "Run the Lint operation.",
      "Read wiki/_index.md and wiki/_log.md first.",
      apply
        ? "Apply mechanical fixes. Propose deeper content edits and apply those too if clearly safe."
        : "Report only. Do not edit files except appending _log.md.",
      "Append a lint entry to wiki/_log.md.",
    ].join("\n");

    const notice = new obsidian.Notice("Grok is linting the wiki…", 0);
    const output = await runGrok(grokBin, vaultPath, prompt, extra).catch((e) => {
      notice.hide();
      abort(String(e));
    });
    notice.hide();
    await quickAddApi.infoDialog("Lint report", (output || "").slice(0, 3500));
  },
  settings: {
    name: "Wiki lint",
    author: "Grok Build",
    options: {
      "Grok binary": {
        type: "text",
        defaultValue: "~/.grok/bin/grok",
        description: "Used when ~/.grok/bin/grok is not the binary you want.",
      },
      "Extra flags": {
        type: "text",
        defaultValue: "--always-approve --no-auto-update --no-alt-screen",
      },
    },
  },
};

function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function resolveGrokBin(setting) {
  const configured = expandHome((setting || "").trim());
  const command =
    configured && !configured.includes("/") && !configured.includes("\\")
      ? configured
      : "grok";
  const candidates = [];
  if (configured && configured !== command) candidates.push(configured);
  candidates.push(path.join(os.homedir(), ".grok", "bin", command));
  candidates.push("/opt/homebrew/bin/" + command);
  candidates.push("/usr/local/bin/" + command);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, command));
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) {
      // Obsidian's PATH usually does not include the shell path that has grok.
    }
  }
  return configured || command;
}

function runGrok(bin, cwd, prompt, extra) {
  const args = ["-p", prompt, "--cwd", cwd, "--output-format", "plain"];
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new Error("Could not start " + bin + ". " + err.message))
    );
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || ("exit " + code)))
    );
  });
}
