const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE =
  "/Users/chiragpatel/Library/CloudStorage/GoogleDrive-chirag2004ml@gmail.com/My Drive/GoodNotes";

module.exports = {
  entry: async (params, settings) => {
    const { app, quickAddApi, obsidian, abort } = params;
    if (!(app.vault.adapter instanceof obsidian.FileSystemAdapter)) {
      abort("Copying GoodNotes needs desktop Obsidian.");
    }

    const sourceRoot = path.resolve(settings["Source folder"] || DEFAULT_SOURCE);
    let vaultParts;
    try {
      vaultParts = vaultSegments(settings["Vault folder"] || "goodnotes");
    } catch (err) {
      abort(err.message);
    }

    try {
      const sourceStat = fs.statSync(sourceRoot);
      if (!sourceStat.isDirectory()) abort("Source folder is not a directory. " + sourceRoot);
    } catch (err) {
      abort("Cannot read source folder. " + sourceRoot);
    }

    const searchLimit = parseSearchLimit(settings["Search limit"]);
    const picked = await pickEntry(quickAddApi, obsidian, sourceRoot, searchLimit);
    if (!picked) return;

    const vaultPath = app.vault.adapter.getBasePath();
    const destDir = path.resolve(vaultPath, ...vaultParts);
    const dest = path.join(destDir, path.basename(picked));
    try {
      assertInside(sourceRoot, picked);
      assertInside(vaultPath, destDir);
      assertInside(destDir, dest);
    } catch (err) {
      abort(err.message);
    }

    const vaultRel = path.relative(vaultPath, dest).split(path.sep).join("/");
    if (fs.existsSync(dest)) {
      const replace = await quickAddApi.yesNoPrompt(
        "Replace existing copy?",
        vaultRel
      );
      if (!replace) return;
    }

    const notice = new obsidian.Notice("Copying into " + vaultRel + "…", 0);
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      await fs.promises.cp(picked, dest, { recursive: true, force: true });
    } catch (err) {
      notice.hide();
      abort(
        "Copy failed. If this item is still online-only in Google Drive, open it once so it downloads, then run the macro again. " +
          err.message
      );
    }
    notice.hide();

    if (fs.statSync(dest).isFile()) {
      const file = app.vault.getAbstractFileByPath(vaultRel);
      if (file) await app.workspace.getLeaf(false).openFile(file);
    }
    await quickAddApi.infoDialog("Copied into the vault", vaultRel);
  },
  settings: {
    name: "Copy GoodNotes",
    author: "Grok Build",
    options: {
      "Source folder": {
        type: "text",
        defaultValue: DEFAULT_SOURCE,
        description: "GoodNotes folder on Google Drive. Browse starts here.",
      },
      "Vault folder": {
        type: "text",
        defaultValue: "goodnotes",
        description: "Folder inside the current vault. Created if it is missing.",
      },
      "Search limit": {
        type: "text",
        defaultValue: "40",
        description: "How many matches to show when searching the GoodNotes tree.",
      },
    },
  },
};

async function pickEntry(quickAddApi, obsidian, root, searchLimit) {
  let current = root;
  while (true) {
    const { labels, values } = listChoices(current, root);
    const choice = await quickAddApi.suggester(labels, values);
    if (!choice) return null;
    if (choice.action === "search") {
      const next = await searchAndPick(quickAddApi, obsidian, root, searchLimit);
      if (!next) continue;
      if (next.action === "browse") {
        current = next.target;
        continue;
      }
      if (next.action === "copy") return next.target;
      continue;
    }
    if (choice.action === "up") {
      current = path.dirname(current);
      continue;
    }
    if (choice.action === "noop") continue;
    if (choice.action === "open") {
      const name = path.basename(choice.target);
      const what = await quickAddApi.suggester(
        ["Open " + name + "/", "Copy " + name + "/ into the vault"],
        ["open", "copy"]
      );
      if (what === "open") {
        current = choice.target;
        continue;
      }
      if (what === "copy") return choice.target;
      continue;
    }
    if (choice.action === "copy") return choice.target;
  }
}

function listChoices(dir, root) {
  const labels = [];
  const values = [];
  const rel = path.relative(root, dir);
  labels.push(rel ? "In: " + rel : "In: GoodNotes");
  values.push({ action: "noop" });
  labels.push("Search the tree");
  values.push({ action: "search" });
  if (rel) {
    labels.push("Up one folder");
    values.push({ action: "up" });
    labels.push("Copy this folder");
    values.push({ action: "copy", target: dir });
  }

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.name && !ent.name.startsWith("."))
    .sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });

  for (const ent of entries) {
    const target = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      labels.push(ent.name + "/");
      values.push({ action: "open", target });
    } else if (ent.isFile()) {
      labels.push(ent.name);
      values.push({ action: "copy", target });
    }
  }

  if (entries.length === 0) {
    labels.push("(empty folder)");
    values.push({ action: "noop" });
  }
  return { labels, values };
}

async function searchAndPick(quickAddApi, obsidian, root, searchLimit) {
  const query = await quickAddApi.inputPrompt(
    "Search GoodNotes",
    "Words matched against the file or folder path"
  );
  if (!query || !String(query).trim()) return null;

  const notice = new obsidian.Notice("Searching GoodNotes…", 0);
  let found;
  try {
    found = await searchTree(root, String(query).trim(), searchLimit);
  } catch (err) {
    notice.hide();
    await quickAddApi.infoDialog("Search failed", err.message);
    return null;
  }
  notice.hide();

  if (!found.matches.length) {
    await quickAddApi.infoDialog("No matches", String(query).trim());
    return null;
  }

  const labels = found.matches.map((match) =>
    match.isDirectory ? match.rel + "/" : match.rel
  );
  const values = found.matches.map((match) => ({
    action: match.isDirectory ? "folder" : "copy",
    target: match.target,
  }));
  if (found.truncated) {
    labels.push("(showing " + found.matches.length + " of " + found.total + ")");
    values.push({ action: "noop" });
  }

  const choice = await quickAddApi.suggester(labels, values);
  if (!choice || choice.action === "noop") return null;
  if (choice.action === "copy") return choice;
  if (choice.action !== "folder") return null;

  const name = path.basename(choice.target);
  const what = await quickAddApi.suggester(
    ["Open " + name + "/", "Copy " + name + "/ into the vault"],
    ["browse", "copy"]
  );
  if (what !== "browse" && what !== "copy") return null;
  return { action: what, target: choice.target };
}

async function searchTree(root, query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith(".")) continue;
      const target = path.join(dir, ent.name);
      const rel = path.relative(root, target);
      const rank = matchRank(rel, terms);
      if (ent.isDirectory()) {
        queue.push(target);
        if (rank !== null) matches.push({ target, rel, isDirectory: true, rank });
      } else if (ent.isFile() && rank !== null) {
        matches.push({ target, rel, isDirectory: false, rank });
      }
    }
  }
  matches.sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel));
  return {
    matches: matches.slice(0, limit),
    total: matches.length,
    truncated: matches.length > limit,
  };
}

function matchRank(rel, terms) {
  const hay = rel.toLowerCase();
  if (!terms.every((term) => hay.includes(term))) return null;
  const base = path.basename(rel).toLowerCase();
  return terms.every((term) => base.includes(term)) ? 0 : 1;
}

function parseSearchLimit(value) {
  const n = Number(String(value || "").trim());
  if (!Number.isInteger(n) || n < 1) return 40;
  return Math.min(n, 200);
}

function vaultSegments(folder) {
  const parts = String(folder || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Vault folder must be a relative path inside the vault, such as goodnotes.");
  }
  return parts;
}

function assertInside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Refusing a path outside " + base);
  }
}
