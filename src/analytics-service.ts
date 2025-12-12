import { getDb } from "./db.js";
import { DailyVisits, DeviceType, PageStatRow, PageStats, PageVisitsByDay, SiteRecord, SiteStats } from "./types.js";
import { randomBytes } from "crypto";
import { nip19 } from "nostr-tools";

const DEVICE_TYPES: DeviceType[] = ["desktop", "mobile", "tablet", "other"];

function normalizeDeviceType(deviceType?: string | null, userAgent?: string | null): DeviceType {
  const input = (deviceType || "").toLowerCase().trim();
  if (DEVICE_TYPES.includes(input as DeviceType)) {
    return input as DeviceType;
  }

  const ua = (userAgent || "").toLowerCase();
  if (ua.includes("mobile")) return "mobile";
  if (ua.includes("tablet") || ua.includes("ipad")) return "tablet";
  if (ua) return "desktop";

  return "other";
}

function normalizePagePath(path?: string | null): string {
  if (!path) return "/";
  try {
    // Accept full URLs or bare paths
    const url = path.startsWith("http") ? new URL(path) : new URL(path, "http://placeholder");
    return url.pathname || "/";
  } catch {
    return path.startsWith("/") ? path : `/${path}`;
  }
}

function findSite(siteUuid: string): SiteRecord | null {
  const db = getDb();
  const row = db.query("SELECT * FROM sites WHERE site_uuid = ?").get(siteUuid) as SiteRecord | undefined;
  return row || null;
}

function normalizeHexPubkey(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();

  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase();
    }
  } catch {
    // ignore decode errors
  }

  return null;
}

export function registerSite(params: {
  siteUuid: string;
  name?: string | null;
  ownerNpub: string;
}): SiteRecord {
  const db = getDb();
  const { siteUuid, name = null, ownerNpub } = params;

  const existing = findSite(siteUuid);

  if (existing) {
    if (ownerNpub && existing.owner_npub && existing.owner_npub !== ownerNpub) {
      throw new Error("Owner npub does not match existing site owner");
    }

    db.prepare(
      `UPDATE sites
       SET name = COALESCE(?, name),
           owner_npub = COALESCE(?, owner_npub),
           updated_at = CURRENT_TIMESTAMP
       WHERE site_uuid = ?`
    ).run(name, ownerNpub, siteUuid);

    return findSite(siteUuid)!;
  }

  const secretToken = randomBytes(24).toString("hex");

  db.prepare(
    `INSERT INTO sites (site_uuid, name, owner_npub, owner_signature, secret_token)
     VALUES (?, ?, ?, ?, ?)`
  ).run(siteUuid, name, ownerNpub, null, secretToken);

  return findSite(siteUuid)!;
}

export function recordVisit(params: {
  siteUuid: string;
  pagePath?: string | null;
  deviceType?: string | null;
  userAgent?: string | null;
  nostrEventId?: string | null;
}) {
  const db = getDb();
  const site = findSite(params.siteUuid);
  if (!site) throw new Error("Site not found");

  const pagePath = normalizePagePath(params.pagePath);
  const deviceType = normalizeDeviceType(params.deviceType, params.userAgent);
  const nostrEventId = (params.nostrEventId || "").trim() || null;

  const record = db.transaction(() => {
    const insert = db
      .prepare(
        `INSERT OR IGNORE INTO visits (site_id, page_path, device_type, nostr_event_id, visited_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(site.id, pagePath, deviceType, nostrEventId);

    // If we ignored due to duplicate nostr_event_id, return existing stats unchanged
    if (insert.changes === 0 && nostrEventId) {
      const existing = db
        .prepare(
          `SELECT visit_count, last_seen
           FROM page_stats
           WHERE site_id = ? AND page_path = ? AND device_type = ?`
        )
        .get(site.id, pagePath, deviceType) as { visit_count: number; last_seen: string | null } | undefined;

      return existing || { visit_count: 0, last_seen: null };
    }

    return db
      .prepare(
        `INSERT INTO page_stats (site_id, page_path, device_type, visit_count, last_seen)
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(site_id, page_path, device_type)
         DO UPDATE SET visit_count = visit_count + 1, last_seen = CURRENT_TIMESTAMP
         RETURNING visit_count, last_seen`
      )
      .get(site.id, pagePath, deviceType) as { visit_count: number; last_seen: string };
  })();

  return {
    siteUuid: site.site_uuid,
    pagePath,
    deviceType,
    visits: record.visit_count,
    lastSeen: record.last_seen,
  };
}

export function listSitesForNpub(params: { npub: string }): SiteRecord[] {
  const { npub } = params;
  const rows = getDb()
    .query(
      `SELECT * FROM sites
       WHERE owner_npub = ?
       ORDER BY created_at DESC`
    )
    .all(npub) as SiteRecord[];
  return rows;
}

export function getSiteStats(siteUuid: string, npub: string): SiteStats {
  const db = getDb();
  const site = findSite(siteUuid);
  if (!site) {
    throw new Error("Site not found");
  }
  if (site.owner_npub && site.owner_npub !== npub) {
    throw new Error("Owner npub mismatch");
  }

  const rows = db
    .query(
      `SELECT page_path, device_type, visit_count, last_seen
       FROM page_stats
       WHERE site_id = ?
       ORDER BY page_path, device_type`
    )
    .all(site.id) as PageStatRow[];

  const visitsByDayRows = db
    .query(
      `SELECT date(visited_at, 'localtime') AS day, COUNT(*) AS visits
       FROM visits
       WHERE site_id = ?
       GROUP BY day
       ORDER BY day`
    )
    .all(site.id) as { day: string; visits: number }[];

  const pageVisitsByDayRows = db
    .query(
      `SELECT page_path, date(visited_at, 'localtime') AS day, COUNT(*) AS visits
       FROM visits
       WHERE site_id = ?
       GROUP BY page_path, day
       ORDER BY page_path, day`
    )
    .all(site.id) as { page_path: string; day: string; visits: number }[];

  const pageMap = new Map<string, PageStats>();
  let totalVisits = 0;

  for (const row of rows) {
    const existing = pageMap.get(row.page_path) || {
      page: row.page_path,
      totalVisits: 0,
      devices: { desktop: 0, mobile: 0, tablet: 0, other: 0 },
      lastSeen: null as string | null,
    };

    existing.totalVisits += row.visit_count;
    existing.devices[row.device_type] = row.visit_count;
    existing.lastSeen = row.last_seen;

    totalVisits += row.visit_count;
    pageMap.set(row.page_path, existing);
  }

  const pages = Array.from(pageMap.values());
  const visitsByDay: DailyVisits[] = visitsByDayRows.map((row) => ({
    date: row.day,
    visits: row.visits,
  }));

  const pageVisitsByDay: PageVisitsByDay[] = [];
  const pageDayMap = new Map<string, PageVisitsByDay>();

  for (const row of pageVisitsByDayRows) {
    const entry = pageDayMap.get(row.page_path) || {
      page: row.page_path,
      days: [],
    };
    entry.days.push({ date: row.day, visits: row.visits });
    pageDayMap.set(row.page_path, entry);
  }

  for (const entry of pageDayMap.values()) {
    entry.days.sort((a, b) => a.date.localeCompare(b.date));
    pageVisitsByDay.push(entry);
  }

  return {
    site: {
      uuid: site.site_uuid,
      name: site.name,
      ownerNpub: site.owner_npub,
    },
    totals: {
      visits: totalVisits,
      pages: pages.length,
    },
    pages,
    visitsByDay,
    pageVisitsByDay,
  };
}

export function updateSiteByOwner(params: {
  siteUuid: string;
  callerPubkey: string;
  name?: string | null;
}): SiteRecord {
  const { siteUuid, callerPubkey, name } = params;
  const site = findSite(siteUuid);
  if (!site) {
    throw new Error("Site not found");
  }

  const ownerHex = normalizeHexPubkey(site.owner_npub);
  const callerHex = normalizeHexPubkey(callerPubkey);

  if (!ownerHex || !callerHex) {
    throw new Error("Unable to validate owner pubkey");
  }

  if (ownerHex !== callerHex) {
    throw new Error("Caller pubkey does not match site owner");
  }

  const db = getDb();

  // Build dynamic update - only include fields that were explicitly provided
  const updates: string[] = [];
  const values: (string | null)[] = [];

  if ("name" in params) {
    updates.push("name = ?");
    values.push(name ?? null);
  }

  if (updates.length === 0) {
    return site;
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(siteUuid);

  db.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE site_uuid = ?`).run(...values);

  return findSite(siteUuid)!;
}

export function deleteSiteByOwner(params: { siteUuid: string; callerPubkey: string }) {
  const { siteUuid, callerPubkey } = params;
  const site = findSite(siteUuid);
  if (!site) {
    throw new Error("Site not found");
  }

  const ownerHex = normalizeHexPubkey(site.owner_npub);
  const callerHex = normalizeHexPubkey(callerPubkey);

  if (!ownerHex || !callerHex) {
    throw new Error("Unable to validate owner pubkey");
  }

  if (ownerHex !== callerHex) {
    throw new Error("Caller pubkey does not match site owner");
  }

  const db = getDb();
  const deleted = db.prepare(`DELETE FROM sites WHERE id = ?`).run(site.id);

  return {
    siteUuid,
    deleted: deleted.changes > 0,
  };
}
