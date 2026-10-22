// Runs inside GitHub Actions. Modes: "daily" (new launches + price refresh) and "backfill" (every past phone, in batches).
import { GoogleGenAI } from '@google/genai';
import admin from 'firebase-admin';

const MODE = process.env.MODE || 'daily';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'; // change if Google renames/retires models
const MAX_PHONES = +(process.env.MAX_PHONES || 10);           // phones per run (keeps you inside free limits)
const START_YEAR = +(process.env.START_YEAR || 2023);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

const SPEC_KEYS = ['screenSize', 'resolution', 'panel', 'refreshRate', 'chipset', 'ram', 'storage', 'battery', 'charging',
  'rearCamera', 'frontCamera', 'video', 'weight', 'os', 'waterResistance', 'ramType', 'storageType', 'expandableStorage',
  'network', 'sim', 'wifi', 'bluetooth', 'nfc', 'usb', 'wirelessCharging', 'peakBrightness', 'protection',
  'fingerprint', 'speakers', 'headphoneJack', 'softwareUpdates'];

async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(15000 * (i + 1)); } // back off on rate limits
  }
}
// Step 1: Gemini WITH Google Search, so it reads real, current pages instead of guessing.
async function search(prompt) {
  const r = await retry(() => ai.models.generateContent({ model: MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } }));
  await sleep(6000);
  return r.text;
}
// Step 2: Gemini WITHOUT tools, forced to return clean JSON.
async function toJson(prompt) {
  const r = await retry(() => ai.models.generateContent({ model: MODEL, contents: prompt, config: { responseMimeType: 'application/json' } }));
  await sleep(6000);
  return JSON.parse(r.text);
}

async function getPhone(brand, name) {
  const facts = await search(`Find the full official specifications of the ${brand} ${name} smartphone (manufacturer website first), its launch date, its current price in India in INR, and source URLs.`);
  return toJson(`From the text below return ONE JSON object with keys: brand, name, launchDate (YYYY-MM-DD), priceINR (number or null), sourceUrl, confidence (0 to 1),
specs (object with exactly these keys: ${SPEC_KEYS.join(', ')}), scores (integers 0-100 for gaming, camera, battery, longTerm, multitasking).
Write values short, like 6.7" or 5,000 mAh. Use null for anything the text does not state. Never guess.
Score only from the specs and reviews in the text: gaming = chipset, refresh rate, cooling; camera = sensors, OIS, video; battery = capacity, charging, efficiency; longTerm = software updates, build, water resistance; multitasking = RAM, storage speed, chipset.

TEXT:
${facts}`);
}

async function save(p) {
  if (!p || !p.name || !p.brand || !(p.confidence >= 0.6)) return false; // skip low-confidence data
  const id = slug(`${p.brand} ${p.name}`);
  await db.collection('devices').doc(id).set({
    ...p, id, type: 'Phones', verified: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    priceUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
}

async function processList(list) {
  let added = 0;
  for (const x of list) {
    try {
      const id = slug(`${x.brand} ${x.name}`);
      if ((await db.collection('devices').doc(id).get()).exists) continue;
      if (await save(await getPhone(x.brand, x.name))) { added++; console.log('Added', x.brand, x.name); }
    } catch (e) { console.error('Failed', x.brand, x.name, e.message); }
  }
  console.log(`Added ${added} phones`);
}

async function daily() {
  const text = await search(`List every smartphone officially launched or announced anywhere in the world between ${weekAgo} and ${today}. Give brand, model and launch date. Only confirmed launches.`);
  const list = await toJson(`Extract a JSON array of {brand, name, launchDate} from this text. Return [] if there are none.\n\n${text}`);
  await processList(list.slice(0, MAX_PHONES));
  // Refresh prices of the 10 phones whose price is oldest
  const old = await db.collection('devices').orderBy('priceUpdatedAt').limit(10).get();
  for (const d of old.docs) {
    try {
      const { brand, name } = d.data();
      const t = await search(`Current price of the ${brand} ${name} in India in INR on Amazon.in or Flipkart.`);
      const r = await toJson(`Return JSON {"priceINR": number or null} from this text. Do not guess.\n\n${t}`);
      await d.ref.update({ ...(r.priceINR ? { priceINR: r.priceINR } : {}), priceUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) { console.error('Price failed', d.id, e.message); }
  }
}

// Priority brands for India first. Override with the BRANDS env var (comma separated) to add more later.
const BRANDS = (process.env.BRANDS || 'Samsung,Apple,Xiaomi,Redmi,Poco,Realme,OnePlus,Oppo,Vivo,iQOO,Motorola,Nothing,Google').split(',');

async function backfill() {
  const ref = db.doc('meta/backfill');
  let s = (await ref.get()).data();
  if (!s) {
    const years = Array.from({ length: new Date().getFullYear() - START_YEAR + 1 }, (_, i) => START_YEAR + i);
    s = { queue: BRANDS.flatMap((brand) => years.map((year) => ({ brand, year }))), pending: [] };
  }
  if (!s.pending.length) {
    const t = s.queue.shift();
    if (!t) return console.log('Backfill complete');
    const text = await search(`List every smartphone model launched by ${t.brand} in ${t.year}, all regions, every variant as its own model.`);
    s.pending = await toJson(`Extract a JSON array of {brand, name} from this text. Return [] if none.\n\n${text}`);
    console.log(`Queued ${s.pending.length} phones for ${t.brand} ${t.year}`);
  }
  const batch = s.pending.splice(0, MAX_PHONES);
  try { await processList(batch); } finally { await ref.set(s); }
}

if (MODE === 'daily') await daily(); else await backfill();
