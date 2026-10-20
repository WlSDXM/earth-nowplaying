// GET /api/nowplaying?url=<stream url>
// Reads the ICY (Shoutcast/Icecast) metadata from a radio stream and returns
// { available, artist, title, raw } as JSON. HLS and other non-ICY streams
// simply return { available: false }.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Sites allowed to call this from a browser. Override with the ALLOWED_ORIGINS
// env var (comma separated) in the Vercel dashboard.
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://theokano.neocities.org')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) {
    const v4 = v6.slice(7);
    return net.isIPv4(v4) ? isPrivateIp(v4) : true;
  }
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Refuse anything that is not a public http(s) address (stops people using
// this endpoint to poke at internal networks).
async function assertPublic(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked address');
}

async function openStream(startUrl, signal) {
  let url = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublic(url);
    const res = await fetch(url, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'earth-nowplaying/1.0' },
      redirect: 'manual',
      signal,
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel();
      url = new URL(loc, url);
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

// ICY layout: [metaint bytes of audio][1 length byte (x16)][metadata][audio...]
async function readMeta(res) {
  const metaint = parseInt(res.headers.get('icy-metaint') || '', 10);
  if (!metaint || metaint > 65536 || !res.body) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let need = metaint + 1;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    chunks.push(value);
    total += value.length;
    if (total < need) continue;
    const buf = Buffer.concat(chunks);
    if (need === metaint + 1) {
      if (buf[metaint] === 0) return '';
      need = metaint + 1 + buf[metaint] * 16;
    }
    if (total >= need) return decode(buf.subarray(metaint + 1, need));
  }
}

function parseTitle(raw) {
  const m = /StreamTitle='([\s\S]*?)';/.exec(raw) || /StreamTitle='([\s\S]*)/.exec(raw);
  const text = (m ? m[1] : '').replace(/\0+/g, '').trim();
  const i = text.indexOf(' - ');
  return i > 0
    ? { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim() }
    : { artist: '', title: text };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Vary': 'Origin',
      // Vercel's CDN caches per stream URL, so many listeners = one upstream hit.
      'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
    },
  });
}

export async function GET(request) {
  const origin = request.headers.get('origin');
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ available: false, error: 'Missing url' }, 400, origin);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await openStream(target, controller.signal);
    const raw = await readMeta(res);
    if (!raw) return json({ available: false }, 200, origin);
    const { artist, title } = parseTitle(raw);
    return json({ available: Boolean(title), artist, title, raw }, 200, origin);
  } catch (err) {
    return json({ available: false, error: String(err.message || err) }, 502, origin);
  } finally {
    clearTimeout(timer);
    controller.abort(); // closes the audio stream so we stop downloading
  }
}
