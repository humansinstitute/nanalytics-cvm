export type DeviceType = "desktop" | "mobile" | "tablet" | "other";

export interface SiteRecord {
  id: number;
  site_uuid: string;
  name: string | null;
  owner_npub: string | null;
  owner_signature: string | null;
  secret_token: string;
  created_at: string;
  updated_at: string;
}

export interface PageStatRow {
  page_path: string;
  device_type: DeviceType;
  visit_count: number;
  last_seen: string;
}

export interface PageStats {
  page: string;
  totalVisits: number;
  devices: Record<DeviceType, number>;
  lastSeen: string | null;
}

export interface DailyVisits {
  date: string;
  visits: number;
}

export interface PageVisitsByDay {
  page: string;
  days: DailyVisits[];
}

export interface SiteStats {
  site: {
    uuid: string;
    name: string | null;
    ownerNpub: string | null;
  };
  totals: {
    visits: number;
    pages: number;
  };
  pages: PageStats[];
  visitsByDay: DailyVisits[];
  pageVisitsByDay: PageVisitsByDay[];
}
