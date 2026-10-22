// Free version: finds phones from Wikipedia's "Mobile phones introduced in YEAR" categories,
// reads each phone's Wikipedia page, and uses Gemini ONLY to turn that text into clean JSON.
// No Google Search tool is used, so it fits Gemini's free tier. Newest phones are processed first.
import { GoogleGenAI } from '@google/genai';
import admin from 'firebase-admin';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'; // change if Google renames/retires models
const MAX_PHONES = +(process.env.MAX_PHONES || 15);           // Gemini calls per run (1 per phone)
const START_YEAR = +(process.env.START_YEAR || 2023);         // lower it later to go further back
const UA = { 'User-Agent': 'SpecDeckStudentProject/1.0 (https://github.com)' };

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const SPEC_KEYS = ['screenSize', 'resolution', 'panel', 'refreshRate', 'chipset', 'ram', 'storage', 'battery', 'charging',
  'rearCamera', 'frontCamera', 'video', 'weight', 'os', 'waterResistance', 'ramType', 'storageType', 'expandableStorage',
  'network', 'sim', 'wifi', 'bluetooth', 'nfc', 'usb', 'wirelessCharging', 'peakBrightness', 'protection',
  'fingerprint', 'speakers', 'headphoneJack', 'softwareUpdates'];

// ---------- Wikipedia (free, no key) ----------
async function wiki(params) {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error('Wikipedia ' + r.status);
  return r.json();
}
async function categoryTitles(year) {
  const out = []; let cont;
  do {
    const j = await wiki({ action: 'query', list: 'categorymembers', cmtitle: `Category:Mobile phones introduced in ${year}`,
      cmtype: 'page', cmlimit: '500', ...(cont ? { cmcontinue: cont } : {}) });
    out.push(...(j.query?.categorymembers || []).map((m) => m.title));
    cont = j.continue?.cmcontinue;
  } while (cont);
  return out;
}
async function pageText(title) {
  const j = await wiki({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' });
  return (j.parse?.wikitext || '').slice(0, 14000);
}

// ---------- Gemini (no tools, JSON only) ----------
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(30000 * (i + 1)); }
  }
}
async function extract(title, text) {
  const r = await retry(() => ai.models.generateContent({
    model: MODEL, config: { responseMimeType: 'application/json' },
    contents: `Extract smartphone data from this Wikipedia wikitext. Use ONLY the text. Use null for anything not stated. Never guess.
Return ONE JSON object with keys: isPhone (true only if the page is about a specific smartphone model or series), brand, name,
launchDate (YYYY-MM-DD, or YYYY-MM if the day is unknown), confidence (0 to 1),
specs (object with exactly these keys: ${SPEC_KEYS.join(', ')}; short values like 6.7" or 5,000 mAh),
scores (integers 0-100 for gaming, camera, battery, longTerm, multitasking, judged only from the specs in the text:
gaming = chipset, refresh rate; camera = sensors, video; battery = capacity, charging; longTerm = software support, build, water resistance; multitasking = RAM, chipset).

PAGE TITLE: ${title}
WIKITEXT:
${text}` }));
  await sleep(7000); // stay under per-minute limits
  return JSON.parse(r.text);
}

// ---------- Firestore ----------
async function unknownTitles(titles) {
  const items = titles.filter((t) => !/^(List of|Comparison of)/i.test(t)).map((t) => ({ t, id: slug(t) }));
  const out = [];
  for (let i = 0; i < items.length; i += 200) {
    const c = items.slice(i, i + 200);
    const [a, b] = await Promise.all([
      db.getAll(...c.map((x) => db.collection('devices').doc(x.id))),
      db.getAll(...c.map((x) => db.collection('skipped').doc(x.id))),
    ]);
    c.forEach((x, k) => { if (!a[k].exists && !b[k].exists) out.push(x); });
  }
  return out;
}
async function savePhone(x, p) {
  await db.collection('devices').doc(x.id).set({
    id: x.id, type: 'Phones', brand: p.brand, name: p.name, launchDate: p.launchDate ?? null,
    specs: p.specs, scores: p.scores, confidence: p.confidence, verified: false, source: 'wikipedia',
    sourceUrl: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(x.t.replace(/ /g, '_')),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true }); // priceINR is not touched, so prices you add by hand are kept
}

// ---------- Main ----------
let todo = [];
for (let y = new Date().getFullYear(); y >= START_YEAR && todo.length < MAX_PHONES; y--) {
  try { todo.push(...await unknownTitles(await categoryTitles(y))); console.log(`Year ${y}: ${todo.length} new so far`); }
  catch (e) { console.error('Category failed', y, e.message); }
}
todo = todo.slice(0, MAX_PHONES);

let added = 0;
for (const x of todo) {
  try {
    const p = await extract(x.t, await pageText(x.t));
    if (p?.isPhone && p.brand && p.name && p.confidence >= 0.6) { await savePhone(x, p); added++; console.log('Added', x.t); }
    else { await db.collection('skipped').doc(x.id).set({ title: x.t }); console.log('Skipped', x.t); }
  } catch (e) {
    if (e.status === 429) { console.log('Gemini quota reached. Will continue at the next run.'); break; }
    console.error('Failed', x.t, e.message);
  }
}
console.log(`Done. Added ${added} phones.`);
