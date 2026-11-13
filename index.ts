// Vavoo Proxy v21.26 — minimal
// /live?ch=<nome>[&delay=<sec>]  /seg?u=<url>&ch=<nome>  /debug?ch=<nome>
// Delay auto = maxDur*1.5. Prefetch 4 concorrenti, SEG_TIMEOUT 12s.
// Pin automatico 6h dopo il primo resolve. Matching permissivo v21.16.
const PING_URL = "https://www.vavoo.tv/api/app/ping";
const BASE_SITES = ["https://geil.to", "https://vavoo.to"];
const REPO_URL =
  "https://raw.githubusercontent.com/a3273/vavoo-channels/main/channels.json";
const LANGUAGE = "es", REGION = "ES";
const SIG_TTL = 240000,
  SEARCH_TTL = 600000,
  SPAIN_TTL = 1800000,
  RESOLVE_TTL = 900000,
  REPO_TTL = 3600000,
  MAN_TTL = 3000,
  SEG_MAX = 300,
  SEG_TIMEOUT = 12000,
  STALE_MAX = 2000,
  PREFETCH_MAX = 4,
  WIN_MIN = 8,
  WIN_MAX = 40,
  PIN_TTL = 21600000;
const UA = "VAVOO/2.6";

// ==================== CANALES LOCALES (edítalos aquí) ====================
const LOCAL_CHANNELS = [
  // Formato: { name: "Nombre visible", query: "texto que se busca en Vavoo" }
  { name: "Movistar Liga de Campeones", query: "liga de campeones" },
  { name: "HISTORIA.B", query: "HISTORIA .b" },
  { name: "HISTORIA.C", query: "HISTORIA .c" },
  { name: "ODISEA.B", query: "CANAL ODISEA .b" },
  { name: "ODISEA.C", query: "CANAL ODISEA .c" },
  { name: "DISCOVERY", query: "DISCOVERY CHANNEL .b" },
  { name: "NATGEO.B", query: "NATIONAL GEOGRAPHIC HD .b" },
  { name: "NATGEO.C", query: "NAT GEO .c" },
  { name: "NATGEOWILD", query: "NAT GEO WILD HD .b" },
  { name: "DAZNLIGA", query: "DAZN LALIGA 1 .c" },
  { name: "CAMPEONES", query: "M.LIGA DE CAMPEONES HD .b" },
  { name: "LIGA.B", query: "MOVISTAR LA LIGA .b" },
  { name: "LIGA.C", query: "M+ LALIGA .c" },
  { name: "BAR.B", query: "LALIGA TV BAR .b" },
  { name: "BAR.C", query: "LALIGA TV BAR .c" },
  // Añade aquí todos los que quieras...
];

const cache: any = { sig: null, search: {}, spain: null, resolve: {} };
const ts: any = { sig: 0, spain: 0, repo: 0 };
let repo: any[] | null = null;
const segCache = new Map<string, Uint8Array>();
const busySeg = new Map<string, Promise<void>>();
const bgBusy = new Set<string>();
const manifestCache: Record<string, { text: string; u: string; ts: number }> =
  {};
const pinnedChannels: Record<
  string,
  { name: string; url: string; ts: number }
> = {};
const revMap: Record<string, string> = {};
let activePrefetch = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (t: number, ttl: number) => Date.now() - t < ttl;
const fetchT = (u: string, o: any = {}, ms = 8000) =>
  fetch(u, { ...o, signal: AbortSignal.timeout(ms) });
const cid = (u: string) => (u.split("?")[0] || u);
const normName = (s: string) =>
  s.toLowerCase().replace(/[._()]/g, " ").replace(/\s+/g, " ").trim();

async function getSig(): Promise<string> {
  if (cache.sig && fresh(ts.sig, SIG_TTL)) return cache.sig;
  const now = Date.now();
  const payload = {
    reason: "app-focus",
    locale: LANGUAGE,
    theme: "dark",
    metadata: {
      device: { type: "desktop", uniqueId: "v" + now },
      os: { name: "linux", version: "Linux", abis: ["x64"], host: "node" },
      app: { platform: "electron" },
      version: { package: "tv.vavoo.app", binary: "3.1.8", js: "3.1.8" },
    },
    appFocusTime: 0,
    playerActive: false,
    playDuration: 0,
    devMode: false,
    hasAddon: true,
    castConnected: false,
    package: "tv.vavoo.app",
    version: "3.1.8",
    process: "app",
    firstAppStart: now,
    lastAppStart: now,
    ipLocation: null,
    adblockEnabled: true,
    proxy: {
      supported: ["ss"],
      engine: "Mu",
      enabled: false,
      autoServer: true,
    },
    iap: { supported: false },
  };
  for (const ping of [PING_URL, BASE_SITES[0] + "/api/app/ping"]) {
    try {
      const r = await fetchT(ping, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MediaHubMX/2",
        },
        body: JSON.stringify(payload),
      }, 8000);
      if (!r.ok) continue;
      const j: any = await r.json();
      if (j && j.addonSig) {
        cache.sig = j.addonSig;
        ts.sig = now;
        return j.addonSig;
      }
    } catch (e) {}
  }
  throw new Error("No addonSig");
}

const apiHeaders = (sig: string) => ({
  "content-type": "application/json; charset=utf-8",
  "mediahubmx-signature": sig,
  "user-agent": "MediaHubMX/2",
  "accept": "*/*",
  "Accept-Language": LANGUAGE,
});

const extractCountry = (g: string) => {
  g = (g || "").trim();
  for (const sep of ["\u27BE", "\u27FF", "->", "\u2192", "\u00BB", "\u203A"]) {
    if (g.includes(sep)) return g.split(sep)[0].trim() || "default";
  }
  return g || "default";
};

async function catalogFrom(
  base: string,
  sig: string,
  extra: any,
  pages: number,
): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < pages; p++) {
    const r = await fetchT(base + "/mediahubmx-catalog.json", {
      method: "POST",
      headers: apiHeaders(sig),
      body: JSON.stringify({
        language: LANGUAGE,
        region: REGION,
        catalogId: "iptv",
        id: "iptv",
        adult: false,
        search: "",
        sort: "",
        filter: {},
        cursor,
        clientVersion: "3.0.2",
        ...extra,
      }),
    }, 8000);
    if (!r.ok) throw new Error(base + " HTTP " + r.status);
    const data: any = await r.json();
    for (const it of data.items || []) {
      if (it.type === "iptv" && it.url) {
        out.push({
          name: it.name || "?",
          url: it.url,
          country: extractCountry(it.group || ""),
        });
      }
    }
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  if (!out.length) throw new Error("vacio");
  return out;
}

async function searchCatalog(q: string): Promise<any[]> {
  const k = q.toLowerCase(), c = cache.search[k];
  if (c && fresh(c.ts, SEARCH_TTL)) return c.channels;
  const sig = await getSig();
  const ch = await Promise.any(
    BASE_SITES.map((b) => catalogFrom(b, sig, { search: q }, 3)),
  );
  cache.search[k] = { channels: ch, ts: Date.now() };
  return ch;
}

async function spainCatalog(): Promise<any[]> {
  if (cache.spain && fresh(ts.spain, SPAIN_TTL)) return cache.spain;
  const sig = await getSig();
  const ch = await Promise.any(
    BASE_SITES.map((b) =>
      catalogFrom(b, sig, { filter: { group: "Spain" } }, 10)
    ),
  );
  cache.spain = ch;
  ts.spain = Date.now();
  return ch;
}

function findChannel(q: string, cat: any[]): any | null {
  q = normName(q);
  const spa = cat.filter((c) => c.country.toLowerCase() === "spain");
  const P = spa.length ? spa : cat;
  let best: any = null, bs = 0;
  for (const c of P) {
    const n = normName(c.name);
    if (n === q) return c;
    if (q.includes(n) || n.includes(q)) return c;
    let s = q.split(" ").filter((w) => n.includes(w)).length;
    if (c.country.toLowerCase() === "spain") s += 2;
    if (s > bs) {
      bs = s;
      best = c;
    }
  }
  return bs >= Math.max(1, q.split(" ").length - 1) ? best : null;
}

function playCandidates(base: string, play: string): string[] {
  const out = [play];
  try {
    const pu = new URL(play), bu = new URL(base);
    const rw = bu.origin + pu.pathname + pu.search;
    if (rw !== play) out.unshift(rw);
  } catch (e) {}
  return out;
}

async function resolveChannel(play: string): Promise<string> {
  const sig = await getSig();
  const dl = Date.now() + 16000;
  let err = "";
  for (const base of BASE_SITES) {
    for (const p of playCandidates(base, play)) {
      if (Date.now() > dl - 500) break;
      try {
        const r = await fetchT(base + "/mediahubmx-resolve.json", {
          method: "POST",
          headers: apiHeaders(sig),
          body: JSON.stringify({
            language: LANGUAGE,
            region: REGION,
            url: p,
            clientVersion: "3.0.2",
          }),
        }, Math.min(8000, Math.max(800, dl - Date.now())));
        if (!r.ok) {
          err = base + " HTTP " + r.status;
          continue;
        }
        const d: any = await r.json();
        const u = Array.isArray(d) ? d[0]?.url : d.url || d.streamUrl;
        if (u) return u;
        err = base + " no url";
      } catch (e: any) {
        err = base + ": " + e.message;
      }
    }
  }
  throw new Error("resolve fallido: " + err);
}

async function repoChannels(): Promise<any[] | null> {
  // Devuelve siempre la lista local (ya no usa REPO_URL)
  return LOCAL_CHANNELS.map((c) => ({
    name: c.name,
    query: c.query || c.name,
  }));
}

function repoLookup(ch: string, list: any[] | null): string | null {
  if (!list) return null;
  const q = normName(ch);
  for (const e of list) if (normName(e.query) === q) return e.query;
  for (const e of list) if (normName(e.name) === q) return e.query;
  for (const e of list) {
    const eq = normName(e.query), en = normName(e.name);
    if ((eq && q.includes(eq)) || (en && q.includes(en))) return e.query;
  }
  return null;
}

async function discover(ch: string): Promise<{ name: string; url: string }> {
  const list = await repoChannels();
  if (list) {
    const rq = repoLookup(ch, list);
    if (rq) {
      try {
        const r = await searchCatalog(rq);
        const spa = r.filter((c) => c.country.toLowerCase() === "spain");
        const m = findChannel(ch, spa.length ? spa : r);
        if (m) return { name: m.name, url: m.url };
      } catch (e) {}
      try {
        const m = findChannel(ch, await spainCatalog());
        if (m) return { name: m.name, url: m.url };
      } catch (e) {}
      throw new Error("canal no encontrado (repo): " + ch);
    }
  }
  try {
    const m = findChannel(ch, await searchCatalog(ch));
    if (m) return { name: m.name, url: m.url };
  } catch (e) {}
  try {
    const m = findChannel(ch, await spainCatalog());
    if (m) return { name: m.name, url: m.url };
  } catch (e) {}
  throw new Error("canal no encontrado: " + ch);
}

async function getStreamUrl(ch: string): Promise<string> {
  const k = ch.toLowerCase();
  const pin = pinnedChannels[k];
  if (pin && Date.now() - pin.ts < PIN_TTL) return pin.url;
  const c = cache.resolve[k];
  if (c && fresh(c.ts, RESOLVE_TTL)) return c.url;
  const found = await discover(ch);
  const u = await resolveChannel(found.url);
  cache.resolve[k] = { url: u, ts: Date.now() };
  pinnedChannels[k] = { name: found.name, url: u, ts: Date.now() };
  return u;
}

function keepLast(text: string, k: number): string {
  const L = text.split("\n");
  const E: number[] = [];
  for (let i = 0; i < L.length; i++) {
    if (!(L[i] || "").trim().startsWith("#EXTINF:")) continue;
    for (let j = i + 1; j < L.length; j++) {
      const u = (L[j] || "").trim();
      if (u && !u.startsWith("#")) {
        E.push(i);
        break;
      }
      if (u.startsWith("#EXTINF:")) break;
    }
  }
  const drop = Math.max(0, E.length - k), from = E.length ? E[drop] : 0;
  const out: string[] = [];
  let fixed = false;
  for (let i = 0; i < L.length; i++) {
    if (i < from) {
      const t = (L[i] || "").trim();
      if (!t || !t.startsWith("#")) continue;
      if (
        t.startsWith("#EXTINF:") || t.startsWith("#EXT-X-PROGRAM-DATE-TIME")
      ) continue;
      if (!fixed && drop > 0 && t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        out.push(
          "#EXT-X-MEDIA-SEQUENCE:" + ((parseInt(t.split(":")[1]) || 0) + drop),
        );
        fixed = true;
        continue;
      }
      out.push(L[i]);
      continue;
    }
    out.push(L[i]);
  }
  return out.join("\n");
}

function prefetchOrder(n: number, delaySec: number, avgDur: number): number[] {
  if (avgDur <= 0) return Array.from({ length: n }, (_, i) => i);
  const startIdx = Math.max(
    0,
    Math.min(n - 1, Math.floor(n - delaySec / avgDur)),
  );
  const order: number[] = [];
  for (let i = startIdx; i < n; i++) order.push(i);
  for (let i = startIdx - 1; i >= 0; i--) order.push(i);
  return order;
}

async function doPrefetch(abs: string, id: string): Promise<void> {
  while (activePrefetch >= PREFETCH_MAX) await sleep(30);
  activePrefetch++;
  try {
    if (segCache.has(id)) return;
    const r = await fetchT(abs, { headers: { "User-Agent": UA } }, SEG_TIMEOUT);
    if (r.ok) {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > 0 && buf[0] !== 0x3c) {
        segCache.set(id, buf);
        while (segCache.size > SEG_MAX) {
          const o = segCache.keys().next().value;
          if (o === undefined) break;
          segCache.delete(o);
        }
      }
    }
  } catch (x) {
  } finally {
    activePrefetch--;
  }
}

function prefetch(
  text: string,
  mUrl: string,
  delaySec: number = 0,
): Promise<void>[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  );
  const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) =>
    parseFloat(m[1])
  );
  const avgDur = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 10;
  const order = prefetchOrder(lines.length, delaySec, avgDur);
  const ps: Promise<void>[] = [];
  for (const i of order) {
    const l = lines[i];
    let abs: string;
    try {
      abs = new URL(l, mUrl).href;
    } catch (x) {
      continue;
    }
    const id = cid(abs);
    if (segCache.has(id) || busySeg.has(id)) continue;
    const p: any = (async () => {
      await doPrefetch(abs, id);
    })();
    busySeg.set(id, p);
    p.finally(() => {
      if (busySeg.get(id) === p) busySeg.delete(id);
    });
    ps.push(p);
  }
  return ps;
}

function prefetchAhead(ch: string, currentId: string): void {
  if (!ch) return;
  const entry = manifestCache[ch.toLowerCase()];
  if (!entry) return;
  const lines = entry.text.split("\n").map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  );
  const urls: string[] = [];
  for (const l of lines) {
    try {
      urls.push(new URL(l, entry.u).href);
    } catch (e) {}
  }
  const idx = urls.findIndex((u) => cid(u) === currentId);
  if (idx < 0) return;
  for (let i = idx + 1; i < Math.min(urls.length, idx + 7); i++) {
    const abs = urls[i], id = cid(abs);
    if (segCache.has(id) || busySeg.has(id)) continue;
    const p: any = (async () => {
      await doPrefetch(abs, id);
    })();
    busySeg.set(id, p);
    p.finally(() => {
      if (busySeg.get(id) === p) busySeg.delete(id);
    });
  }
}

function revLookup(target: string): string | null {
  try {
    const o = new URL(target).origin;
    return revMap[o] || null;
  } catch (x) {
    return null;
  }
}

async function freshUrl(target: string, dl: number): Promise<string | null> {
  try {
    const ch = revLookup(target);
    if (!ch || Date.now() > dl - 2500) return null;
    const { text, u } = await manifest(ch, dl);
    const want = cid(target);
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (l && !l.startsWith("#")) {
        try {
          const abs = new URL(l, u).href;
          if (cid(abs) === want) return abs;
        } catch (x) {}
      }
    }
  } catch (x) {}
  return null;
}

function rewrite(text: string, mUrl: string, o: string, ch: string): string {
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try {
          return 'URI="' + o + "/seg?u=" +
            encodeURIComponent(new URL(uri, mUrl).href) + "&ch=" +
            encodeURIComponent(ch) + '"';
        } catch {
          return m;
        }
      });
    }
    try {
      return o + "/seg?u=" + encodeURIComponent(new URL(t, mUrl).href) +
        "&ch=" + encodeURIComponent(ch);
    } catch {
      return line;
    }
  }).join("\n");
}

async function serveLive(
  text: string,
  mUrl: string,
  key: string,
  stale: boolean,
  u: any,
  PREFIX: string,
  CORS: any,
): Promise<Response> {
  const delayRaw = parseFloat(u.searchParams.get("delay") || "");
  const userDelay = isNaN(delayRaw) ? -1 : Math.max(0, Math.min(120, delayRaw));
  const durs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((x) =>
    parseFloat(x[1])
  );
  const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 10;
  const maxDur = durs.length ? Math.max(...durs) : 30;
  const minDelay = maxDur * 1.5;
  const effectiveDelay = userDelay < 0
    ? minDelay
    : Math.max(userDelay, minDelay);
  const targetWindowSec = effectiveDelay + maxDur * 4 + 15;
  const win = Math.max(
    WIN_MIN,
    Math.min(WIN_MAX, Math.ceil(targetWindowSec / avg)),
  );
  let pl = keepLast(text, win);
  const realTd = Math.ceil(maxDur) + 1;
  if (
    pl.split("\n").some((l) => l.trim().startsWith("#EXT-X-TARGETDURATION:"))
  ) {
    pl = pl.split("\n").map((l) =>
      l.trim().startsWith("#EXT-X-TARGETDURATION:")
        ? "#EXT-X-TARGETDURATION:" + realTd
        : l
    ).join("\n");
  } else {pl = pl.replace(
      /^(#EXTM3U\n?)/,
      "$1#EXT-X-TARGETDURATION:" + realTd + "\n",
    );}
  if (!pl.includes("#EXT-X-INDEPENDENT-SEGMENTS")) {
    pl = pl.replace(/^(#EXTM3U\n?)/, "$1#EXT-X-INDEPENDENT-SEGMENTS\n");
  }
  if (!pl.includes("#EXT-X-ALLOW-CACHE")) {
    pl = pl.replace(/^(#EXTM3U\n?)/, "$1#EXT-X-ALLOW-CACHE:YES\n");
  }
  pl = pl.split("\n").filter((l) => !l.trim().startsWith("#EXT-X-START")).join(
    "\n",
  );
  pl = pl.replace(
    /^(#EXTM3U\n?)/,
    "$1#EXT-X-START:TIME-OFFSET=-" + Math.round(effectiveDelay) +
      ",PRECISE=YES\n",
  );
  if (!pl.includes("#EXT-X-SERVER-CONTROL")) {
    pl = pl.replace(
      /^(#EXTM3U\n?)/,
      "$1#EXT-X-SERVER-CONTROL:HOLD-BACK=" + (maxDur * 2).toFixed(1) + "\n",
    );
  }
  const ps = prefetch(pl, mUrl, effectiveDelay);
  await Promise.race([Promise.all(ps.slice(0, 4)), sleep(10000)]);
  const pin = pinnedChannels[key];
  return new Response(rewrite(pl, mUrl, PREFIX, key), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Delay": String(Math.round(effectiveDelay)),
      "X-Win": String(win),
      "X-Avg": avg.toFixed(1),
      "X-Max": maxDur.toFixed(1),
      "X-Stale": stale ? "1" : "0",
      "X-Pin": pin ? encodeURIComponent(pin.name) : "",
      ...CORS,
    },
  });
}

async function manifest(
  ch: string,
  dl: number,
): Promise<{ text: string; u: string }> {
  const left = () => Math.max(400, dl - Date.now());
  const u = await getStreamUrl(ch);
  const r = await fetchT(
    u,
    { headers: { "User-Agent": UA } },
    Math.min(8000, left()),
  );
  if (!r.ok) throw new Error("manifest " + r.status);
  const text = await r.text();
  if (!text.startsWith("#EXTM3U")) throw new Error("manifest non valido");
  manifestCache[ch.toLowerCase()] = { text, u, ts: Date.now() };
  try {
    revMap[new URL(u).origin] = ch;
  } catch (e) {}
  return { text, u };
}

function bgRefresh(key: string, ch: string) {
  if (bgBusy.has(key)) return;
  bgBusy.add(key);
  (async () => {
    try {
      const { text, u } = await manifest(ch, Date.now() + 8000);
      if (text) prefetch(text, u, 0);
    } catch (err) {}
  })().catch(() => {}).finally(() => bgBusy.delete(key));
}

async function fetchSeg(
  id: string,
  target: string,
  chSeg: string,
): Promise<boolean> {
  let resp: any = null, url = target;
  const dl = Date.now() + 25000;
  const waits = [0, 500, 1500];
  for (let a = 0; a < 3; a++) {
    if (a > 0) await sleep(waits[a]);
    if (Date.now() > dl - 4000) break;
    url = target;
    if (a > 0 && chSeg) {
      try {
        delete cache.resolve[chSeg.toLowerCase()];
        const f = await freshUrl(target, dl);
        if (f) url = f;
      } catch (e) {}
    }
    try {
      resp = await fetchT(url, { headers: { "User-Agent": UA } }, SEG_TIMEOUT);
      if (resp.ok) break;
    } catch (e) {
      resp = null;
    }
  }
  if (!resp || !resp.ok) return false;
  try {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length > 0 && buf[0] === 0x3c) return false;
    segCache.set(id, buf);
    while (segCache.size > SEG_MAX) {
      const o = segCache.keys().next().value;
      if (o === undefined) break;
      segCache.delete(o);
    }
    return true;
  } catch (x) {
    return false;
  }
}

export default async function (req: Request): Promise<Response> {
  const u = new URL(req.url);
  const path = "/" + u.pathname.split("/").filter(Boolean).pop();
  const PREFIX = u.origin + "/vavoo-stream";
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };
  const PLAIN = { "Content-Type": "text/plain; charset=utf-8", ...CORS };

  if (path === "/live") {
    const ch = u.searchParams.get("ch");
    if (!ch) {
      return new Response("uso: /live?ch=<nome>[&delay=<sec>]", {
        status: 400,
        headers: PLAIN,
      });
    }
    const key = ch.toLowerCase();
    const entry = manifestCache[key];
    const force = !!u.searchParams.get("force");
    if (entry && !force && fresh(entry.ts, MAN_TTL)) {
      bgRefresh(key, ch);
      return await serveLive(entry.text, entry.u, key, false, u, PREFIX, CORS);
    }
    if (entry && !force) {
      bgRefresh(key, ch);
      const t0 = Date.now();
      while (Date.now() - t0 < STALE_MAX) {
        await sleep(50);
        const e2 = manifestCache[key];
        if (e2 && e2.ts > entry.ts) {
          return await serveLive(e2.text, e2.u, key, false, u, PREFIX, CORS);
        }
      }
      return await serveLive(entry.text, entry.u, key, true, u, PREFIX, CORS);
    }
    try {
      const { text, u: streamUrl } = await manifest(ch, Date.now() + 8000);
      return await serveLive(text, streamUrl, key, false, u, PREFIX, CORS);
    } catch (x: any) {
      if (entry) {
        bgRefresh(key, ch);
        return await serveLive(entry.text, entry.u, key, true, u, PREFIX, CORS);
      }
      return new Response("unavailable: " + (x.message || x), {
        status: 502,
        headers: PLAIN,
      });
    }
  }

  if (path === "/seg") {
    const target = u.searchParams.get("u");
    if (!target) {
      return new Response("uso: /seg?u=<url>", { status: 400, headers: PLAIN });
    }
    const chSeg = u.searchParams.get("ch") || revLookup(target) || "";
    const id = cid(target);
    const hit = segCache.get(id);
    if (hit) {
      if (chSeg) prefetchAhead(chSeg, id);
      return new Response(hit, {
        headers: { "Content-Type": "video/mp2t", "X-Cache": "hit", ...CORS },
      });
    }
    const running = busySeg.get(id);
    if (running) {
      try {
        await Promise.race([running, sleep(4000)]);
      } catch (x) {}
      const after = segCache.get(id);
      if (after) {
        if (chSeg) prefetchAhead(chSeg, id);
        return new Response(after, {
          headers: { "Content-Type": "video/mp2t", "X-Cache": "wait", ...CORS },
        });
      }
    }
    const p = fetchSeg(id, target, chSeg);
    busySeg.set(id, p.then(() => {}));
    try {
      await p;
    } catch (x) {}
    const after = segCache.get(id);
    if (after) {
      if (chSeg) prefetchAhead(chSeg, id);
      return new Response(after, {
        headers: { "Content-Type": "video/mp2t", "X-Cache": "miss", ...CORS },
      });
    }
    return new Response("slow, retry", {
      status: 503,
      headers: { ...CORS, "Retry-After": "1", "Content-Type": "text/plain" },
    });
  }

  // ==================== /find?ch=... ====================
  if (path === "/find") {
    const ch = u.searchParams.get("ch");
    if (!ch) {
      return new Response("uso: /find?ch=<nombre>", {
        status: 400,
        headers: PLAIN,
      });
    }

    try {
      const list = await repoChannels();
      const rq = list ? repoLookup(ch, list) : null;

      // 1. Intentar primero con la lista local
      let found: any = null;
      let source = "";

      if (rq) {
        try {
          const r = await searchCatalog(rq);
          const spa = r.filter((c) => c.country.toLowerCase() === "spain");
          found = findChannel(ch, spa.length ? spa : r);
          if (found) source = "local+search";
        } catch (e) {}
      }

      // 2. Si no, buscar en catálogo Spain
      if (!found) {
        try {
          found = findChannel(ch, await spainCatalog());
          if (found) source = "spainCatalog";
        } catch (e) {}
      }

      // 3. Último intento: búsqueda libre
      if (!found) {
        try {
          found = findChannel(ch, await searchCatalog(ch));
          if (found) source = "searchCatalog";
        } catch (e) {}
      }

      if (!found) {
        return new Response(
          JSON.stringify(
            {
              ok: false,
              query: ch,
              error: "canal no encontrado",
            },
            null,
            2,
          ),
          {
            status: 404,
            headers: { "Content-Type": "application/json", ...CORS },
          },
        );
      }

      // Opcional: intentar resolver la URL real
      // let streamUrl = null;
      // try {
      //  streamUrl = await resolveChannel(found.url);
      //} catch (e) {}

      // Solo resolver si se pide explícitamente con &resolve=1
      const wantResolve = u.searchParams.get("resolve") === "1";
      let streamUrl = null;
      if (wantResolve) {
        try {
          streamUrl = await resolveChannel(found.url);
        } catch (e) {}
      }

      return new Response(
        JSON.stringify(
          {
            ok: true,
            query: ch,
            found: {
              name: found.name,
              country: found.country,
              playUrl: found.url,
              streamUrl: streamUrl, // URL real del m3u8 (si se pudo resolver)
            },
            source,
            localMatch: rq || null,
          },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json", ...CORS },
        },
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify(
          {
            ok: false,
            query: ch,
            error: e.message || String(e),
          },
          null,
          2,
        ),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...CORS },
        },
      );
    }
  }

  // ==================== /channels ====================
  if (path === "/channels") {
    try {
      const local = LOCAL_CHANNELS.map((c) => ({
        name: c.name,
        query: c.query || c.name,
        source: "local",
      }));

      let spain: any[] = [];
      try {
        const cat = await spainCatalog();
        spain = cat.map((c) => ({
          name: c.name,
          country: c.country,
          playUrl: c.url,
          source: "spainCatalog",
        }));
      } catch (e) {
        // si falla el catálogo de Spain, devolvemos solo los locales
      }

      // Evitar duplicados por nombre normalizado
      const seen = new Set(local.map((c) => normName(c.name)));
      const extra = spain.filter((c) => !seen.has(normName(c.name)));

      const result = {
        ok: true,
        total: local.length + extra.length,
        local: local.length,
        spain: extra.length,
        channels: [...local, ...extra],
      };

      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    } catch (e: any) {
      return new Response(
        JSON.stringify({ ok: false, error: e.message || String(e) }, null, 2),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...CORS },
        },
      );
    }
  }

  if (path === "/debug") {
    const ch = u.searchParams.get("ch") || "HISTORIA.B";
    try {
      const { text, u: su } = await manifest(ch, Date.now() + 8000);
      const durs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((x) =>
        parseFloat(x[1])
      );
      const avg = durs.length
        ? durs.reduce((a, b) => a + b, 0) / durs.length
        : 0;
      const maxDur = durs.length ? Math.max(...durs) : 0;
      const effDelay = maxDur * 1.5;
      const win = Math.max(
        WIN_MIN,
        Math.min(
          WIN_MAX,
          Math.ceil((effDelay + maxDur * 4 + 15) / (avg || 10)),
        ),
      );
      const k = ch.toLowerCase(), pin = pinnedChannels[k];
      return new Response(
        "OK | " + text.split("\n").filter((l) => {
          const t = l.trim();
          return t && !t.startsWith("#");
        }).length + " segs" +
          "\nPIN: " + (pin ? "'" + pin.name + "'" : "nessuno") +
          "\nDELAY: avg=" + avg.toFixed(1) + "s max=" + maxDur.toFixed(1) +
          "s -> " + Math.round(effDelay) + "s" +
          "\nWIN: " + win + " seg (~" + (win * avg).toFixed(0) + "s)" +
          "\nPREFETCH: " + activePrefetch + "/" + PREFETCH_MAX +
          "\nSEGCACHE: " + segCache.size + "/" + SEG_MAX,
        { headers: PLAIN },
      );
    } catch (e: any) {
      return new Response("ERROR: " + e.message, { headers: PLAIN });
    }
  }

  // ==================== Atajos ====================
  const SHORTCUTS: Record<string, string> = {
    "/historia": "historia.b",
    "/odisea": "odisea.b",
    "/discovery": "discovery",
    "/dazn": "daznliga",
    "/liga": "liga.b",
    "/campeones": "campeones",
  };
  if (SHORTCUTS[path]) {
    const target = new URL(req.url);
    target.pathname = target.pathname.replace(/\/[^/]*$/, "/live");
    target.searchParams.set("ch", SHORTCUTS[path]);
    return Response.redirect(target.toString(), 302);
  }

  // ==================== /lista ====================
  if (path === "/lista") {
    const base = u.origin; // usa automáticamente el dominio actual del val

    const m3u =
      `#EXTM3U url-tvg="https://raw.githubusercontent.com/davidmuma/EPG_dobleM/refs/heads/master/guiatv.xml,https://epgshare01.online/epgshare01/epg_ripper_NL1.xml.gz,https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml" refresh="3600"
#EXTVLCOPT:network-caching=1000


#EXTINF:-1 group-title="DOCU" tvg-id="historia" tvg-name="HISTORIA" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/historia-es.png" ,HISTORIA .b
${base}/live?ch=historia.b
#EXTINF:-1 group-title="DOCU" tvg-id="historia" tvg-name="HISTORIA" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/historia-es.png" ,HISTORIA .c
${base}/live?ch=historia.c


#EXTINF:-1 group-title="DOCU" tvg-id="odisea" tvg-name="ODISEA HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/odisea-es.png" ,ODISEA b
${base}/live?ch=odisea.b
#EXTINF:-1 group-title="DOCU" tvg-id="odisea" tvg-name="ODISEA HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/odisea-es.png" ,ODISEA c
${base}/live?ch=odisea.c


#EXTINF:-1 group-title="DOCU" tvg-id="Discovery" tvg-name="ES| DISCOVERY CHANNEL HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/discovery-channel-es.png" ,DISCOVERY CHANNEL
${base}/live?ch=discovery


#EXTINF:-1 group-title="DOCU" tvg-id="National Geographic HD" tvg-name="ES| NAT GEOGRAPHIC HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/national-geographic-es.png" ,NAT GEOGRAPHIC b
${base}/live?ch=natgeo.b
#EXTINF:-1 group-title="DOCU" tvg-id="National Geographic HD" tvg-name="ES| NAT GEOGRAPHIC HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/national-geographic-es.png" ,NAT GEOGRAPHIC c
${base}/live?ch=natgeo.c

#EXTINF:-1 group-title="DOCU" tvg-id="Nat Geo Wild HD" tvg-name="ES| NAT GEO WILD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/national-geographic-wild-es.png" ,NAT GEO WILD
${base}/live?ch=natgeowild



#EXTINF:-1 group-title="LIGA" tvg-id="DAZN LaLiga HD" tvg-name="ES| DAZN LA LIGA 1 HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/dazn-laliga-es.png" ,BAZN LALIJA 1 HD
${base}/live?ch=DAZNLIGA



#EXTINF:-1 group-title="LIGA" tvg-id="DAZN LaLiga HD" tvg-name="ES| M+ LALIGA HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/laliga-tv-por-movistar-plus-es.png" ,M.LALIJA HD .b
${base}/live?ch=LIGA.B
#EXTINF:-1 group-title="LIGA" tvg-id="DAZN LaLiga HD" tvg-name="ES| M+ LALIGA HD" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/laliga-tv-por-movistar-plus-es.png" ,M.LALIJA HD .c
${base}/live?ch=LIGA.C
#EXTINF:-1 group-title="LIGA" tvg-id="LaLiga TV BAR" tvg-name="ES| LaLiga TV BAR" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/laliga-tv-por-movistar-plus-es.png" ,TV BAR .b
${base}/live?ch=BAR.B
#EXTINF:-1 group-title="LIGA" tvg-id="LaLiga TV BAR" tvg-name="ES| LaLiga TV BAR" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/laliga-tv-por-movistar-plus-es.png" ,TV BAR HD .c
${base}/live?ch=BAR.C


#EXTINF:-1 group-title="CAMP" tvg-id="M+ Liga de Campeones HD" tvg-name="ES| M+ LIGA DE CAMPEONES 1" tvg-logo="https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/spain/liga-de-campeones-por-movistar-plus-es.png" ,CAMPEONES
${base}/live?ch=CAMPEONES
`;

    return new Response(m3u, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Disposition": 'attachment; filename="lista.m3u"',
        ...CORS,
      },
    });
  }

  return new Response(
    "uso: /live?ch=<nombre>[&delay=<sec>] | /seg | /debug | /find?ch=<nombre>[&resolve=1] | /channels /lista (devuelve archivo lista.m3u)",
    {
      status: 400,
      headers: PLAIN,
    },
  );
}
