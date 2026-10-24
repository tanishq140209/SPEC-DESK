// Backup: saves every Firestore collection to backup/<collection>.json
// Clean: deletes ONLY the old Wikipedia phones, plus the helper collections "skipped" and "meta".
// Official phones (source = "official") are never touched.
import admin from 'firebase-admin';
import fs from 'node:fs';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const MODE = process.env.MODE || 'backup';
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === 'object' && typeof x.toDate === 'function') ? x.toDate().toISOString() : x));

async function purge(q) {
  let n = 0;
  for (;;) {
    const s = await q.limit(400).get();
    if (!s.size) break;
    const b = db.batch();
    s.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
    n += s.size;
  }
  return n;
}

if (MODE === 'backup') {
  fs.mkdirSync('backup', { recursive: true });
  for (const col of await db.listCollections()) {
    const snap = await col.get();
    const data = Object.fromEntries(snap.docs.map((d) => [d.id, plain(d.data())]));
    fs.writeFileSync(`backup/${col.id}.json`, JSON.stringify(data, null, 2));
    console.log(`${col.id}: ${snap.size} documents saved`);
  }
} else if (MODE === 'clean') {
  console.log('Wikipedia phones deleted:', await purge(db.collection('devices').where('source', '==', 'wikipedia')));
  console.log('skipped deleted:', await purge(db.collection('skipped')));
  console.log('meta deleted:', await purge(db.collection('meta')));
} else {
  console.log('Unknown mode. Use backup or clean.');
}

