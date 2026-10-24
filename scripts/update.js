// Official-source version, one brand at a time.
// You list phones in sources/<brand>.txt (one per line: Brand | Model | official spec page URL).
// The script reads each official page, and Gemini ONLY turns that text into clean JSON.
// If a page can't be read (blocked or JavaScript-only), paste its specs into pasted/<id>.txt instead.
import { GoogleGenAI } from '@google/genai';
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'; // change if Google renames/retires models
const MAX_PHONES = +(process.env.MAX_PHONES || 15);           // Gemini calls per run (1 per phone)
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; SpecDeckStudentProject/1.0)' };

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const htmlToText = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const SPEC_KEYS = ['screenSize', 'resolution', 'panel', 'refreshRate', 'chipset', 'ram', 'storage', 'battery', 'charging',
  'rearCamera', 'frontCamera', 'video', 'weight', 'os', 'waterResistance', 'ramType', 'storageType', 'expandableStorage',
  'network', 'sim', 'wifi', 'bluetooth', 'nfc', 'usb', 'wirelessCharging', 'peakBrightness', 'protection',
  'fingerprint', 'speakers', 'headphoneJack', 'softwareUpdates'];

function readSources() {
  if (!fs.existsSync('sources')) return [];
  const out = [];
  for (const f of fs.readdirSync('sources').filter((f) => f.endsWith('.txt'))) {
    for (const line of fs.readFileSync(path.join('sources', f), 'utf8').split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const [brand, model, url] = l.split('|').map((s) => s.trim());
      if (brand && model) out.push({ brand, model, url, id: slug(`${brand} ${model}`) });
    }
  }
  return out;
}

async function getText(x) {
  const pasted = path.join('pasted', x.id + '.txt');
  if (fs.existsSync(pasted)) return fs.readFileSync(pasted, 'utf8').slice(0, 20000);
  if (!x.url) throw new Error(`no URL. Paste the specs into pasted/${x.id}.txt`);
  const r = await fetch(x.url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}. Paste the specs into pasted/${x.id}.txt`);
  const t = htmlToText(await r.text());
  if (t.length < 1500) throw new Error(`page has no readable specs (needs a browser). Paste the specs into pasted/${x.id}.txt`);
  return t.slice(0, 20000);
}

async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(30000 * (i + 1)); }
  }
}
async function extract(x, text) {
  const r = await retry(() => ai.models.generateContent({
    model: MODEL, config: { responseMimeType: 'application/json' },
    contents: `Extract smartphone data from this OFFICIAL manufacturer page text. Use ONLY the text. Use null for anything not stated. Never guess.
Return ONE JSON object with keys: name, launchDate (YYYY-MM-DD, or YYYY-MM, or null), priceINR (number in rupees if an Indian price is shown, else null),
confidence (0 to 1),
specs (object with exactly these keys: ${SPEC_KEYS.join(', ')}; short values like 6.7" or 5,000 mAh),
scores (integers 0-100 for gaming, camera, battery, longTerm, multitasking, judged only from the specs in the text:
gaming = chipset, refresh rate; camera = sensors, video; battery = capacity, charging; longTerm = software support, build, water resistance; multitasking = RAM, chipset).

PHONE: ${x.brand} ${x.model}
TEXT:
${text}` }));
  await sleep(7000); // stay under per-minute limits
  return JSON.parse(r.text);
}

async function savePhone(x, p) {
  await db.collection('devices').doc(x.id).set({
    id: x.id, type: 'Phones', brand: x.brand, name: p.name || x.model, launchDate: p.launchDate ?? null,
    specs: p.specs, scores: p.scores, confidence: p.confidence, verified: false, source: 'official',
    sourceUrl: x.url || null,
    ...(p.priceINR ? { priceINR: p.priceINR } : {}), // a price typed by hand is kept when the page shows none
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ---------- Main ----------
const all = readSources();
if (!all.length) console.log('No phones listed. Add lines to sources/<brand>.txt');
const snaps = all.length ? await db.getAll(...all.map((x) => db.collection('devices').doc(x.id))) : [];
const todo = all.filter((x, i) => !(snaps[i].exists && snaps[i].data().source === 'official')).slice(0, MAX_PHONES);
console.log(`${all.length} listed, ${todo.length} to process this run`);

let added = 0;
for (const x of todo) {
  try {
    const p = await extract(x, await getText(x));
    if (p?.specs && p.confidence >= 0.6) { await savePhone(x, p); added++; console.log('Added', x.brand, x.model); }
    else console.log('LOW CONFIDENCE (not saved)', x.brand, x.model, '- check the page or paste specs');
  } catch (e) {
    if (e.status === 429) { console.log('Gemini quota reached. Will continue at the next run.'); break; }
    console.error('FAILED', x.brand, x.model, '->', e.message);
  }
}
console.log(`Done. Added ${added} phones.`);
