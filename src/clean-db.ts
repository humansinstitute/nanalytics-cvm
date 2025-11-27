import { getDb, initializeDatabase } from "./db.js";

function tableCount(table: string) {
  const row = getDb().query(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function cleanDatabase() {
  initializeDatabase();
  const db = getDb();

  const before = {
    sites: tableCount("sites"),
    pageStats: tableCount("page_stats"),
    visits: tableCount("visits"),
  };

  db.transaction(() => {
    db.exec("DELETE FROM visits;");
    db.exec("DELETE FROM page_stats;");
    db.exec("DELETE FROM sites;");
  })();

  db.exec("VACUUM;");

  const after = {
    sites: tableCount("sites"),
    pageStats: tableCount("page_stats"),
    visits: tableCount("visits"),
  };

  console.log(
    JSON.stringify(
      {
        cleared: before,
        remaining: after,
      },
      null,
      2
    )
  );
}

if (import.meta.main) {
  cleanDatabase();
}
