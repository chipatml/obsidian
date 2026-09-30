const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE =
  "/Users/chiragpatel/Library/CloudStorage/GoogleDrive-chirag2004ml@gmail.com/My Drive/GoodNotes";

module.exports = {
  entry: async (params, settings) => {
    const { app, quickAddApi, obsidian, abort } = params;
    if (!(app.vault.adapter instanceof obsidian.FileSystemAdapter)) {
      abort("Refreshing GoodNotes needs desktop Obsidian.");
    }

    const sourceRoot = path.resolve(settings["Source folder"] || DEFAULT_SOURCE);
    let vaultParts;
    try {
      vaultParts = vaultSegments(settings["Vault folder"] || "goodnotes");
    } catch (err) {
      abort(err.message);
    }

    let sourceStat;
    try {
      sourceStat = await fs.promises.stat(sourceRoot);
    } catch (err) {
      abort("Cannot read source folder. " + sourceRoot);
    }
    if (!sourceStat.isDirectory()) abort("Source folder is not a directory. " + sourceRoot);

    const vaultPath = app.vault.adapter.getBasePath();
    const destDir = path.resolve(vaultPath, ...vaultParts);
    try {
      assertInside(vaultPath, destDir);
    } catch (err) {
      abort(err.message);
    }

    let destStat;
    try {
      destStat = await fs.promises.stat(destDir);
    } catch (err) {
      await quickAddApi.infoDialog(
        "Nothing to refresh",
        vaultParts.join("/") + "/ is not in this vault yet. Copy a folder first."
      );
      return;
    }
    if (!destStat.isDirectory()) {
      abort(vaultParts.join("/") + " is a file, not a folder.");
    }

    const notice = new obsidian.Notice("Comparing goodnotes with Drive…", 0);
    let plan;
    try {
      plan = await planRefresh(sourceRoot, destDir);
    } catch (err) {
      notice.hide();
      abort(err.message);
    }
    notice.hide();

    if (!plan.matched.length) {
      await quickAddApi.infoDialog("Nothing to refresh", formatReport(plan, []));
      return;
    }

    const names = plan.matched.map((item) => item.name).join(", ");
    const go = await quickAddApi.yesNoPrompt(
      "Refresh " + plan.matched.length + " item" + (plan.matched.length === 1 ? "" : "s") + " from GoodNotes?",
      "Updates and adds files in " + names + ". Nothing in the vault is deleted."
    );
    if (!go) return;

    const working = new obsidian.Notice("Refreshing from GoodNotes…", 0);
    const results = [];
    try {
      for (const item of plan.matched) {
        assertInside(sourceRoot, item.source);
        assertInside(destDir, item.dest);
        const report = { updated: [], skipped: [], unchanged: 0 };
        await syncTree(item.source, item.dest, report, item.name);
        results.push({ name: item.name, report });
      }
    } catch (err) {
      working.hide();
      abort(
        "Refresh failed. If an item is still online-only in Google Drive, open it once so it downloads, then run the macro again. " +
          err.message
      );
    }
    working.hide();
    await quickAddApi.infoDialog("GoodNotes refresh", formatReport(plan, results).slice(0, 3500));
  },
  settings: {
    name: "Refresh GoodNotes",
    author: "Grok Build",
    options: {
      "Source folder": {
        type: "text",
        defaultValue: DEFAULT_SOURCE,
        description: "GoodNotes folder on Google Drive.",
      },
      "Vault folder": {
        type: "text",
        defaultValue: "goodnotes",
        description: "Folder inside the current vault that holds the copies.",
      },
    },
  },
};

async function planRefresh(sourceRoot, destDir) {
  const index = await indexSource(sourceRoot);
  const entries = await fs.promises.readdir(destDir, { withFileTypes: true });
  const matched = [];
  const missing = [];
  const ambiguous = [];
  for (const ent of entries) {
    if (!ent.name || ent.name.startsWith(".")) continue;
    const isDirectory = ent.isDirectory();
    const isFile = ent.isFile();
    if (!isDirectory && !isFile) continue;
    const found = matchSource(index, ent.name, isDirectory);
    if (found.status === "one") {
      matched.push({
        name: ent.name,
        source: found.target,
        dest: path.join(destDir, ent.name),
      });
    } else if (found.status === "ambiguous") {
      ambiguous.push({
        name: ent.name,
        sources: found.targets.map((target) => path.relative(sourceRoot, target)),
      });
    } else {
      missing.push(ent.name);
    }
  }
  matched.sort((a, b) => a.name.localeCompare(b.name));
  return { matched, missing, ambiguous };
}

async function indexSource(root) {
  const byKey = new Map();
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith(".")) continue;
      const target = path.join(dir, ent.name);
      if (ent.isDirectory()) queue.push(target);
      if (!ent.isDirectory() && !ent.isFile()) continue;
      const key = (ent.isDirectory() ? "d:" : "f:") + ent.name.toLowerCase();
      const list = byKey.get(key) || [];
      list.push(target);
      byKey.set(key, list);
    }
  }
  return byKey;
}

function matchSource(index, name, isDirectory) {
  const hits = index.get((isDirectory ? "d:" : "f:") + name.toLowerCase()) || [];
  const exact = hits.filter((target) => path.basename(target) === name);
  const pool = exact.length ? exact : hits;
  if (pool.length === 1) return { status: "one", target: pool[0] };
  if (!pool.length) return { status: "missing" };
  return { status: "ambiguous", targets: pool };
}

async function syncTree(src, dest, report, rel) {
  const srcStat = await fs.promises.lstat(src);
  if (srcStat.isSymbolicLink()) {
    report.skipped.push(rel + " (symlink)");
    return;
  }
  let destStat = null;
  try {
    destStat = await fs.promises.lstat(dest);
  } catch (err) {
    destStat = null;
  }

  if (srcStat.isDirectory()) {
    if (destStat && !destStat.isDirectory()) {
      report.skipped.push(rel + " (vault has a file with this name)");
      return;
    }
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith(".")) continue;
      await syncTree(path.join(src, ent.name), path.join(dest, ent.name), report, rel + "/" + ent.name);
    }
    return;
  }

  if (!srcStat.isFile()) return;
  if (destStat && destStat.isDirectory()) {
    report.skipped.push(rel + " (vault has a folder with this name)");
    return;
  }
  if (!destStat || (await fileChanged(src, dest))) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    report.updated.push(rel);
  } else {
    report.unchanged += 1;
  }
}

async function fileChanged(src, dest) {
  const srcStat = await fs.promises.stat(src);
  const destStat = await fs.promises.stat(dest);
  if (srcStat.size !== destStat.size) return true;
  return srcStat.mtimeMs - destStat.mtimeMs > 1000;
}

function formatReport(plan, results) {
  const lines = [];
  if (!results.length && plan.matched.length) {
    lines.push("Matched, not refreshed:");
    for (const item of plan.matched) lines.push("- " + item.name);
  }
  for (const item of results) {
    const bits = [];
    if (item.report.updated.length) bits.push(item.report.updated.length + " updated");
    if (item.report.skipped.length) bits.push(item.report.skipped.length + " skipped");
    if (!bits.length) bits.push(item.report.unchanged + " unchanged");
    lines.push(item.name + ": " + bits.join(", "));
    for (const file of item.report.updated) lines.push("  updated " + file);
    for (const file of item.report.skipped) lines.push("  skipped " + file);
  }
  if (plan.missing.length) {
    lines.push("Left in place, no Drive match:");
    for (const name of plan.missing) lines.push("- " + name);
  }
  if (plan.ambiguous.length) {
    lines.push("Left in place, more than one Drive item has this name:");
    for (const item of plan.ambiguous) {
      lines.push("- " + item.name);
      for (const source of item.sources) lines.push("  " + source);
    }
  }
  return lines.join("\n") || "Nothing in the vault folder came from GoodNotes.";
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
