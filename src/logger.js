/** JSONL logging into data/ plus console helpers. */
const fs = require("fs");
const path = require("path");
const { istParts } = require("./util");

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* exists */
  }
}

function loadJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return dflt;
  }
}

function saveJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

class Logger {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = cfg.dataDir;
    ensureDir(this.dir);
    this.dateKey = cfg._dateKey || istParts().dateKey;
  }

  setDate(dateKey) {
    this.dateKey = dateKey;
  }

  file(name) {
    return path.join(this.dir, `${name}-${this.dateKey}.jsonl`);
  }

  append(name, objs) {
    if (!objs || !objs.length) return;
    try {
      fs.appendFileSync(this.file(name), objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
    } catch (err) {
      this.error(`log append failed (${name}): ${err.message}`);
    }
  }

  candidate(rec) {
    this.append("candidates", [rec]);
  }

  alert(obj) {
    this.append("alerts", [obj]);
  }

  line(msg) {
    if (this.cfg.logging.console) console.log(`[${istParts().timeStr}] ${msg}`);
  }

  error(msg) {
    console.error(`[${istParts().timeStr}] ${msg}`);
  }
}

module.exports = { Logger, ensureDir, loadJson, saveJson };
