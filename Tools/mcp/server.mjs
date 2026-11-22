#!/usr/bin/env node
/**
 * TransitStats MCP server: read-only, local-only access to the admin's own trips.
 *
 * Other Claude chats on this Mac can ask things like "how often did I take the 506 this month".
 * The tools are the same ones SMS ASK uses (functions/lib/claude.js QUERY_TOOLS and
 * buildQueryToolExecutors), so every number matches ASK and the dashboard: same counting rules,
 * imported PRESTO rides included, stops resolved the app's way.
 *
 * Privacy: it exposes location history, so it runs over stdio on this Mac only (no network port),
 * reads only the single admin profile's trips (no tool takes a user id), and has no write tools.
 *
 * Key: ~/Developer/Credentials/Firebase for TransitStats.json, else the gcloud application-default login.
 * Register: claude mcp add -s user transitstats -- node "<repo>/Tools/mcp/server.mjs"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// stdout carries the protocol; anything else printed there corrupts it. Send all logging to stderr.
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = (...a) => console.error(...a);

const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY_PATH = process.env.TRANSITSTATS_KEY || path.join(os.homedir(), 'Developer/Credentials/Firebase for TransitStats.json');
const PROJECT_ID = 'transitstats-21ba4';
const fnRequire = createRequire(path.join(ROOT, 'functions/lib/index.js'));

// Initialize the default app before functions/lib loads, so its db module reuses this one.
const { initializeApp, cert, applicationDefault } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
initializeApp(fs.existsSync(KEY_PATH)
  ? { credential: cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))) }
  : { credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const { QUERY_TOOLS, buildQueryToolExecutors } = fnRequire('./claude.js');
const { DEFAULT_TRIP_TIME_ZONE } = fnRequire('./trip-stats.js');

/** The one rider this server answers for: the single admin profile. Refuses anything else. */
let ownerRead = null;
function owner() {
  if (!ownerRead) {
    ownerRead = db.collection('profiles').where('isAdmin', '==', true).get().then(snap => {
      if (snap.size !== 1) throw new Error(`Expected exactly one admin profile, found ${snap.size}.`);
      return snap.docs[0].id;
    });
    ownerRead.catch(() => { ownerRead = null; });
  }
  return ownerRead;
}

// Fresh reads each call, so a trip logged a minute ago counts. Personal scale: two queries per call.
async function run(name, input) {
  const executors = buildQueryToolExecutors(db, await owner(), DEFAULT_TRIP_TIME_ZONE);
  if (typeof executors[name] !== 'function') throw new Error(`Unknown tool: ${name}`);
  return executors[name](input || {});
}

const TOOLS = QUERY_TOOLS.map(t => ({
  name: t.name,
  description: `${t.description} (Ryan's own TransitStats trips; dates are Toronto local days.)`,
  inputSchema: t.input_schema || { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
}));

const server = new Server({ name: 'transitstats', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const result = await run(req.params.name, req.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message || String(err) }] };
  }
});

await server.connect(new StdioServerTransport());
