const fs = require("fs");
const path = require("path");

const DEFAULT_GOODNOTES =
  "/Users/chiragpatel/Library/CloudStorage/GoogleDrive-chirag2004ml@gmail.com/My Drive/GoodNotes";

module.exports = {
  entry: async (params, settings) => {
    const { app, quickAddApi, obsidian, abort } = params;
    if (!obsidian || !(app.vault.adapter instanceof obsidian.FileSystemAdapter)) {
      abort("Adding a GoodNotes folder needs desktop Obsidian.");
      return;
    }

    const entered = await quickAddApi.inputPrompt(
      "Relative path under GoodNotes",
      "School/My Notes"
    );
    if (entered == null || entered === "") return;
    if (String(entered).trim() === "") return;

    const goodnotesRoot = goodnotesRootFromSettings(settings, abort);
    if (!goodnotesRoot) return;

    const vaultRoot = path.resolve(app.vault.adapter.getBasePath());
    const parts = partsUnderRoot(goodnotesRoot, entered, abort);
    if (!parts) return;

    const source = path.resolve(goodnotesRoot, ...parts);
    const linkPath = path.resolve(vaultRoot, ...parts);
    if (!path.isAbsolute(source) || !path.isAbsolute(linkPath)) {
      abort("Symlink paths must be absolute.");
      return;
    }
    if (!isStrictInside(goodnotesRoot, source)) {
      abort("That path is outside the GoodNotes folder.");
      return;
    }
    if (!isStrictInside(vaultRoot, linkPath)) {
      abort("That path is outside the vault.");
      return;
    }
    if (source === linkPath) {
      abort("The GoodNotes path and the vault path are the same.");
      return;
    }
    if (!isDirectory(source, abort, "That GoodNotes folder does not exist.")) return;

    const existing = lstatOrMissing(linkPath, abort);
    if (existing === false) return;
    if (existing) {
      if (existing.isSymbolicLink() && linksTo(linkPath, source)) {
        await quickAddApi.infoDialog("Already linked", linkPath + "\n→ " + source);
        return;
      }
      abort("A file or folder already exists at\n" + linkPath);
      return;
    }

    const parentPosix = parts.slice(0, -1).join("/");
    if (parentPosix) {
      const ready = await ensureParentFolder(
        app,
        obsidian,
        path.dirname(linkPath),
        parentPosix,
        abort
      );
      if (!ready) return;
    }

    try {
      fs.symlinkSync(source, linkPath, "dir");
    } catch (err) {
      abort(err.message || "Could not create the symlink.");
      return;
    }

    await quickAddApi.infoDialog("GoodNotes folder linked", linkPath + "\n→ " + source);
  },
  settings: {
    name: "Add Goodnotes Note",
    author: "Grok Build",
    options: {
      "GoodNotes folder": {
        type: "text",
        defaultValue: DEFAULT_GOODNOTES,
        description: "Absolute path of the GoodNotes folder.",
      },
    },
  },
};

function goodnotesRootFromSettings(settings, abort) {
  const configured =
    String((settings && settings["GoodNotes folder"]) || "").trim() || DEFAULT_GOODNOTES;
  if (!path.isAbsolute(configured)) {
    abort("Set GoodNotes folder to an absolute path.");
    return null;
  }
  const root = path.resolve(configured);
  if (!isDirectory(root, abort, "GoodNotes folder was not found.")) return null;
  return root;
}

function partsUnderRoot(root, entered, abort) {
  const trimmed = String(entered).trim();
  let rawParts;
  if (path.isAbsolute(trimmed)) {
    const absolute = path.resolve(trimmed);
    if (!isStrictInside(root, absolute)) {
      abort("That path is outside the GoodNotes folder.");
      return null;
    }
    rawParts = path.relative(path.resolve(root), absolute).split(path.sep);
  } else {
    rawParts = trimmed.replace(/\\/g, "/").split("/");
  }

  const parts = rawParts.map((part) => part.trim()).filter((part) => part && part !== ".");
  if (parts.length === 0) {
    abort("Enter a folder inside GoodNotes.");
    return null;
  }
  if (parts.some((part) => part === "..")) {
    abort("Enter a folder path without ..");
    return null;
  }
  if (parts.some((part) => part.startsWith(".") || part.includes("\0"))) {
    abort("Enter a visible folder path.");
    return null;
  }
  return parts;
}

function isDirectory(folder, abort, missingMessage) {
  let stat;
  try {
    stat = fs.statSync(folder);
  } catch (err) {
    abort(err.code === "ENOENT" ? missingMessage + "\n" + folder : err.message);
    return false;
  }
  if (!stat.isDirectory()) {
    abort("That path is not a folder:\n" + folder);
    return false;
  }
  return true;
}

function isStrictInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function lstatOrMissing(target, abort) {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    abort(err.message);
    return false;
  }
}

function linksTo(linkPath, source) {
  try {
    const current = fs.readlinkSync(linkPath);
    const resolved = path.isAbsolute(current)
      ? path.resolve(current)
      : path.resolve(path.dirname(linkPath), current);
    return resolved === path.resolve(source);
  } catch (err) {
    return false;
  }
}

async function ensureParentFolder(app, obsidian, parentAbs, parentPosix, abort) {
  const onDisk = lstatOrMissing(parentAbs, abort);
  if (onDisk === false) return false;
  if (onDisk) {
    let followed = onDisk;
    if (onDisk.isSymbolicLink()) {
      try {
        followed = fs.statSync(parentAbs);
      } catch (err) {
        abort("The parent folder link is broken:\n" + parentAbs);
        return false;
      }
    }
    if (!followed.isDirectory()) {
      abort("A file already occupies the parent path:\n" + parentAbs);
      return false;
    }
    return true;
  }

  const known = app.vault.getAbstractFileByPath(parentPosix);
  if (known && !(known instanceof obsidian.TFolder)) {
    abort("A file already occupies the parent path:\n" + parentPosix);
    return false;
  }
  if (!known) {
    try {
      await app.vault.createFolder(parentPosix);
    } catch (err) {
      abort((err && err.message) || "Could not create the vault folder.");
      return false;
    }
  }
  return true;
}
