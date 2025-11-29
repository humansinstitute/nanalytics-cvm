import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from "@contextvm/sdk";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { z } from "zod";
import { initializeDatabase } from "./src/db.js";
import { getSiteStats, listSitesForNpub, recordVisit, registerSite } from "./src/analytics-service.js";

const ENV_PATH = ".env";
const RELAYS = process.env.RELAYS?.split(",") || [
  "wss://relay.contextvm.org",
  "wss://cvm.otherstuff.ai",
];

function jsonContent(payload: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function ensureServerPrivateKey(): string {
  const existing = process.env.SERVER_PRIVATE_KEY;
  if (existing) return existing;

  const generated = randomBytes(32).toString("hex");
  try {
    let wrote = false;
    if (existsSync(ENV_PATH)) {
      const current = readFileSync(ENV_PATH, "utf8");
      if (!/SERVER_PRIVATE_KEY=/.test(current)) {
        const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
        appendFileSync(ENV_PATH, `${prefix}SERVER_PRIVATE_KEY=${generated}\n`);
        wrote = true;
      }
    } else {
      writeFileSync(ENV_PATH, `SERVER_PRIVATE_KEY=${generated}\n`);
      wrote = true;
    }
    if (wrote) {
      console.log("Generated SERVER_PRIVATE_KEY and wrote to .env");
    } else {
      console.warn("SERVER_PRIVATE_KEY not set in .env; using generated key only for this run");
    }
  } catch (err) {
    console.warn("Failed to persist generated server key; using ephemeral key", err);
  }

  process.env.SERVER_PRIVATE_KEY = generated;
  return generated;
}

async function main() {
  const SERVER_PRIVATE_KEY_HEX = ensureServerPrivateKey();

  initializeDatabase();

  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY_HEX);
  const relayHandler = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`Server Public Key: ${serverPubkey}`);
  console.log("Connecting to relays...");

  const mcpServer = new McpServer({
    name: "Analytics CVM Server",
    version: "0.1.0",
  });

  mcpServer.registerTool(
    "register_site",
    {
      title: "Register site",
      description: "Create or update a site record with owner npub",
      inputSchema: {
        siteUuid: z.string().min(8).describe("Unique site UUID (provided by the website)"),
        name: z.string().optional().describe("Human friendly name"),
        ownerNpub: z.string().describe("Owner npub"),
      },
    },
    async ({ siteUuid, name, ownerNpub }) => {
      try {
        const site = registerSite({ siteUuid, name, ownerNpub });
        return jsonContent(site);
      } catch (error) {
        return jsonContent({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  mcpServer.registerTool(
    "record_visit",
    {
      title: "Record visit",
      description: "Increment visit/device counters for a site page",
      inputSchema: {
        siteUuid: z.string().min(8).describe("Site UUID"),
        pagePath: z.string().optional().describe("Page path or URL"),
        deviceType: z.string().optional().describe("desktop|mobile|tablet|other"),
        userAgent: z.string().optional().describe("Optional UA for device detection"),
      },
    },
    async ({ siteUuid, pagePath, deviceType, userAgent }, extra) => {
      try {
        const nostrEventId = extra?.requestId ? String(extra.requestId) : null;
        const visit = recordVisit({ siteUuid, pagePath, deviceType, userAgent, nostrEventId });
        return jsonContent(visit);
      } catch (error) {
        return jsonContent({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  mcpServer.registerTool(
    "list_sites_for_npub",
    {
      title: "List sites by npub",
      description: "List sites where owner npub matches",
      inputSchema: {
        npub: z.string().describe("Owner npub"),
      },
    },
    async ({ npub }) => {
      try {
        const sites = listSitesForNpub({ npub });
        return jsonContent(sites);
      } catch (error) {
        return jsonContent({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  mcpServer.registerTool(
    "get_site_stats",
    {
      title: "Site stats",
      description: "Aggregate page/device counts for a site UUID",
      inputSchema: {
        siteUuid: z.string().min(8).describe("Site UUID"),
        npub: z.string().describe("Owner npub"),
      },
    },
    async ({ siteUuid, npub }) => {
      try {
        const stats = getSiteStats(siteUuid, npub);
        return jsonContent(stats);
      } catch (error) {
        return jsonContent({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  mcpServer.registerTool(
    "health",
    {
      title: "Health",
      description: "Ping the analytics server",
      inputSchema: {},
    },
    async () => jsonContent({ ok: true })
  );

  const nostrTransport = new NostrServerTransport({
    signer,
    relayHandler,
  });

  mcpServer.connect(nostrTransport);
}

main().catch((err) => {
  console.error("Fatal error starting server", err);
  process.exit(1);
});
