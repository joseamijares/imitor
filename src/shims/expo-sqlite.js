// Stand-in for expo-sqlite on web, backed by sql.js (SQLite compiled to wasm).
// Imitor's boot loader initialises sql.js before the app bundle runs and puts
// it on globalThis.__imitor.SQL, so the synchronous API works.
// Data is in memory, mirrored to sessionStorage so a page reload keeps it.
const KEY = "imitor:sqlite:";

function engine() {
  const SQL = globalThis.__imitor && globalThis.__imitor.SQL;
  if (!SQL) throw new Error("Imitor: sql.js is not loaded. Serve the app with `imitor`.");
  return SQL;
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function normalise(params) {
  if (params.length === 0) return undefined;
  const first = params[0];
  const value = params.length === 1 && (Array.isArray(first) || (first && typeof first === "object" && !(first instanceof Uint8Array))) ? first : params;
  const fix = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  if (Array.isArray(value)) return value.map(fix);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]));
}

const WRITE = /^\s*(insert|update|delete|replace|create|drop|alter|pragma|begin|commit|rollback|end|vacuum)/i;

class SQLiteDatabase {
  constructor(name) {
    const SQL = engine();
    this.databasePath = name;
    this.options = {};
    this._name = name;
    this._tx = 0;
    this._fk = false;
    this._timer = null;
    let saved = null;
    try {
      saved = name !== ":memory:" && sessionStorage.getItem(KEY + name);
    } catch {}
    this._db = saved ? new SQL.Database(fromB64(saved)) : new SQL.Database();
  }

  _touched(sql) {
    if (/pragma\s+foreign_keys\s*=\s*(on|1)/i.test(sql)) this._fk = true;
    if (!WRITE.test(sql) || this._name === ":memory:" || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._tx > 0 || !this._db) return;
      try {
        sessionStorage.setItem(KEY + this._name, toB64(this._db.export()));
        if (this._fk) this._db.run("PRAGMA foreign_keys = ON;"); // export() resets it
      } catch {}
    }, 0);
  }

  execSync(sql) {
    this._db.exec(sql);
    this._touched(sql);
  }
  runSync(sql, ...params) {
    this._db.run(sql, normalise(params));
    const changes = this._db.getRowsModified();
    const row = this._db.exec("SELECT last_insert_rowid()");
    this._touched(sql);
    return { changes, lastInsertRowId: row[0] ? row[0].values[0][0] : 0 };
  }
  getAllSync(sql, ...params) {
    const stmt = this._db.prepare(sql);
    try {
      const bound = normalise(params);
      if (bound) stmt.bind(bound);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
      this._touched(sql);
    }
  }
  getFirstSync(sql, ...params) {
    const rows = this.getAllSync(sql, ...params);
    return rows.length ? rows[0] : null;
  }
  *getEachSync(sql, ...params) {
    yield* this.getAllSync(sql, ...params);
  }
  prepareSync(sql) {
    const db = this;
    const result = (params) => {
      const isQuery = /^\s*(select|with|pragma)/i.test(sql);
      const rows = isQuery ? db.getAllSync(sql, ...params) : [];
      const meta = isQuery ? { changes: 0, lastInsertRowId: 0 } : db.runSync(sql, ...params);
      return {
        ...meta,
        getAllSync: () => rows,
        getFirstSync: () => (rows.length ? rows[0] : null),
        resetSync() {},
        getAllAsync: async () => rows,
        getFirstAsync: async () => (rows.length ? rows[0] : null),
        resetAsync: async () => {},
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    };
    return {
      executeSync: (...params) => result(params),
      executeAsync: async (...params) => result(params),
      finalizeSync() {},
      finalizeAsync: async () => {},
    };
  }
  withTransactionSync(task) {
    this._db.exec("BEGIN");
    this._tx++;
    try {
      task();
      this._tx--;
      this._db.exec("COMMIT");
      this._touched("commit");
    } catch (error) {
      this._tx--;
      this._db.exec("ROLLBACK");
      throw error;
    }
  }
  isInTransactionSync() {
    return this._tx > 0;
  }
  closeSync() {
    if (this._db) this._db.close();
    this._db = null;
  }

  async execAsync(sql) {
    return this.execSync(sql);
  }
  async runAsync(sql, ...params) {
    return this.runSync(sql, ...params);
  }
  async getAllAsync(sql, ...params) {
    return this.getAllSync(sql, ...params);
  }
  async getFirstAsync(sql, ...params) {
    return this.getFirstSync(sql, ...params);
  }
  async *getEachAsync(sql, ...params) {
    yield* this.getAllSync(sql, ...params);
  }
  async prepareAsync(sql) {
    return this.prepareSync(sql);
  }
  async withTransactionAsync(task) {
    this._db.exec("BEGIN");
    this._tx++;
    try {
      await task();
      this._tx--;
      this._db.exec("COMMIT");
      this._touched("commit");
    } catch (error) {
      this._tx--;
      this._db.exec("ROLLBACK");
      throw error;
    }
  }
  async withExclusiveTransactionAsync(task) {
    return this.withTransactionAsync(() => task(this));
  }
  async isInTransactionAsync() {
    return this._tx > 0;
  }
  async closeAsync() {
    this.closeSync();
  }
}

function openDatabaseSync(name) {
  return new SQLiteDatabase(name);
}
async function openDatabaseAsync(name) {
  return new SQLiteDatabase(name);
}
function deleteDatabaseSync(name) {
  try {
    sessionStorage.removeItem(KEY + name);
  } catch {}
}

module.exports = {
  __esModule: true,
  SQLiteDatabase,
  openDatabaseSync,
  openDatabaseAsync,
  deleteDatabaseSync,
  deleteDatabaseAsync: async (name) => deleteDatabaseSync(name),
  defaultDatabaseDirectory: "imitor://sqlite",
  bundledExtensions: {},
  addDatabaseChangeListener: () => ({ remove() {} }),
};
