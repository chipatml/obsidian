const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = {
  entry: async (params, settings) => {
    const { app, quickAddApi, obsidian, abort } = params;
    if (!(app.vault.adapter instanceof obsidian.FileSystemAdapter)) {
      abort("Creating a macro needs desktop Obsidian.");
    }

    const name = await quickAddApi.inputPrompt(
      "New macro name",
      "Shown in QuickAdd settings"
    );
    if (!name || !name.trim()) return;

    const suggested = toKebab(name);
    if (!suggested) abort("Use a name that contains letters or numbers.");

    const filenameInput = await quickAddApi.inputPrompt(
      "Script filename",
      "kebab-case, without .js",
      suggested
    );
    if (!filenameInput || !filenameInput.trim()) return;

    let filename;
    try {
      filename = normalizeFilename(filenameInput);
    } catch (err) {
      abort(err.message);
    }

    const job = await quickAddApi.wideInputPrompt(
      "What should this macro do?",
      "Prompts, files, and steps. This is the whole spec."
    );
    if (!job || !job.trim()) return;

    const mode = await quickAddApi.suggester(
      ["Have Grok write the script", "Write a starter I can edit"],
      ["grok", "stub"]
    );
    if (!mode) return;

    const dir = path.resolve(
      expandHome(settings["Scripts folder"] || "~/obsidian-global/scripts")
    );
    const dest = path.resolve(dir, filename);
    if (path.dirname(dest) !== dir) abort("Refusing a path outside the scripts folder.");

    if (fs.existsSync(dest)) {
      const overwrite = await quickAddApi.yesNoPrompt(
        "Replace existing script?",
        dest
      );
      if (!overwrite) return;
    }

    fs.mkdirSync(dir, { recursive: true });

    let source;
    if (mode === "stub") {
      source = stubSource(name.trim(), filename, job.trim());
    } else {
      const grokBin = resolveGrokBin(settings["Grok binary"]);
      const extra = (settings["Extra flags"] || "").trim();
      const defaultTurns = String(settings["Max turns"] || "8").trim();
      const turnsInput = await quickAddApi.inputPrompt(
        "Maximum turns",
        "Agent rounds Grok may use before it stops",
        defaultTurns
      );
      if (!turnsInput || !String(turnsInput).trim()) return;
      let maxTurns;
      try {
        maxTurns = parseMaxTurns(turnsInput);
      } catch (err) {
        abort(err.message);
      }
      const notice = new obsidian.Notice("Grok is writing the macro…", 0);
      const output = await runGrok(
        grokBin,
        promptFor(name.trim(), filename, job.trim()),
        extra,
        maxTurns
      ).catch((err) => {
        notice.hide();
        abort(String(err));
      });
      notice.hide();
      try {
        source = extractScript(output);
      } catch (err) {
        abort(err.message + "\n\n" + String(output || "").slice(0, 1500));
      }
    }

    fs.writeFileSync(dest, source);
    await quickAddApi.infoDialog(
      "Macro script saved",
      [
        dest,
        "",
        "Attach it once: QuickAdd → Manage Macros → your macro → User Script →",
        "scripts/" + filename,
        "",
        "scripts/ is the global folder, so the file is available in every linked vault.",
      ].join("\n")
    );
  },
  settings: {
    name: "Create QuickAdd macro",
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
      "Max turns": {
        type: "text",
        defaultValue: "8",
        description: "Prefilled value when the macro asks how many agent rounds Grok may use.",
      },
      "Scripts folder": {
        type: "text",
        defaultValue: "~/obsidian-global/scripts",
        description: "Where new user scripts are written. Same folder for every vault.",
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

function toKebab(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function normalizeFilename(input) {
  const base = path.basename(String(input).trim()).replace(/\.js$/i, "");
  const kebab = toKebab(base);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(kebab)) {
    throw new Error("Filename must be kebab-case, such as daily-review.");
  }
  return kebab + ".js";
}

function stubSource(name, filename, job) {
  const comment = job
    .replace(/\*\//g, "* /")
    .split("\n")
    .map((line) => "    // " + line)
    .join("\n");
  return `module.exports = {
  entry: async (params, settings) => {
    const { quickAddApi } = params;
${comment}
    await quickAddApi.infoDialog(
      ${JSON.stringify(name)},
      "Starter script. Edit ~/obsidian-global/scripts/${filename} and replace this entry."
    );
  },
  settings: {
    name: ${JSON.stringify(name)},
    author: "Grok Build",
    options: {},
  },
};
`;
}

function promptFor(name, filename, job) {
  return [
    "Write one Obsidian QuickAdd user script.",
    "Output only JavaScript source. No markdown fences. No explanation.",
    "The file will be saved by the caller. Do not write files yourself.",
    "",
    "Contract:",
    "- CommonJS. module.exports = { entry: async (params, settings) => {}, settings: { name, author, options } }",
    "- params provides app, quickAddApi, variables, obsidian, and abort.",
    "- quickAddApi.inputPrompt(header, placeholder?, value?), wideInputPrompt, yesNoPrompt(header, text?), suggester(labels, values), checkboxPrompt(items, selected), infoDialog(header, text).",
    "- If a prompt returns null or an empty string, return immediately.",
    "- abort(message) stops the macro. Use it for hard failures.",
    '- settings.name is ' + JSON.stringify(name) + ".",
    '- settings.author is "Grok Build".',
    "- Add settings.options only for values the user should change without editing code.",
    "- Desktop Obsidian has Node require (fs, path, os, child_process).",
    "- Vault files go through app.vault. Never write .obsidian or any hidden folder.",
    "- Do not copy the script anywhere. It already lives in ~/obsidian-global/scripts.",
    "- Implement only the requested behavior.",
    "",
    "Filename: " + filename,
    "Behavior:",
    job,
  ].join("\n");
}

function extractScript(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Grok returned an empty script.");
  const fences = [...raw.matchAll(/```(?:javascript|js)?\s*([\s\S]*?)```/g)];
  let code = fences.length ? fences.map((m) => m[1].trim()).join("\n\n") : raw;
  const start = code.search(/(?:["']use strict["'];|const |let |var |async function |function |module\.exports)/);
  if (start > 0) code = code.slice(start);
  code = code.trim() + "\n";
  if (!code.includes("module.exports")) {
    throw new Error("Grok output has no module.exports.");
  }
  if (!/entry\s*:/.test(code) && !/module\.exports\s*=\s*async/.test(code)) {
    throw new Error("Grok output has no entry function.");
  }
  return code;
}

function parseMaxTurns(input) {
  const n = Number(String(input).trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("Maximum turns must be a whole number from 1 to 100.");
  }
  return String(n);
}

function runGrok(bin, prompt, extra, maxTurns) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "plain",
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools",
    "run_terminal_cmd,search_replace,write,Agent",
  ];
  if (extra) {
    const parts = extra.split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--max-turns") {
        i += 1;
        continue;
      }
      if (parts[i].startsWith("--max-turns=")) continue;
      args.push(parts[i]);
    }
  }
  args.push("--max-turns", maxTurns);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new Error("Could not start " + bin + ". Set Grok binary. " + err.message))
    );
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || "exit " + code))
    );
  });
}
