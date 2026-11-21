import 'dotenv/config';
import dns from 'node:dns';
import { MongoClient, type ClientSession, type Document, type Filter } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';

// Optional override for networks whose DNS server blocks Atlas SRV/TXT lookups.
if (process.env.MONGODB_DNS_SERVERS) {
  dns.setServers(
    process.env.MONGODB_DNS_SERVERS.split(',')
      .map((server) => server.trim())
      .filter(Boolean)
  );
}
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required. Configure it in .env.');
export const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
const dbName = process.env.MONGODB_DB_NAME?.trim() || 'boothguard';
const database = client.db(dbName);
const sessions = new AsyncLocalStorage<ClientSession>();
const options = () => ({ session: sessions.getStore() });
export const collection = (name: string) => database.collection(name);

export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  if (sessions.getStore()) return work();
  return client.withSession((session) =>
    session.withTransaction(() => sessions.run(session, work), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    })
  );
}

export async function find<T>(
  name: string,
  filter: Filter<Document> = {},
  sort: Record<string, 1 | -1> = {},
  limit = 0
): Promise<T[]> {
  return collection(name)
    .find(filter, { ...options(), projection: { _id: 0, revision: 0 } })
    .sort(sort)
    .limit(limit)
    .toArray() as Promise<T[]>;
}
export async function one<T>(name: string, filter: Filter<Document>): Promise<T | null> {
  return collection(name).findOne(filter, {
    ...options(),
    projection: { _id: 0, revision: 0 },
  }) as Promise<T | null>;
}
export async function count(name: string, filter: Filter<Document> = {}) {
  return collection(name).countDocuments(filter, options());
}
export async function update(name: string, filter: Filter<Document>, fields: Document) {
  return collection(name).updateOne(filter, { $set: fields }, options());
}
export async function insert(name: string, document: Document) {
  await collection(name).insertOne({ ...document }, options());
}
export async function remove(name: string, filter: Filter<Document>) {
  await collection(name).deleteMany(filter, options());
}
export async function nextId(name: string): Promise<number> {
  const counter = await database
    .collection<{ _id: string; value: number }>('counters')
    .findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { ...options(), upsert: true, returnDocument: 'after' }
    );
  return counter!.value;
}
// Every booth mutation takes the same document write lock. MongoDB retries conflicting
// transactions, so closing a poll and replacing its roll cannot race a vote.
export async function lockBooth(id: string) {
  await collection('booths').updateOne({ id }, { $inc: { revision: 1 } }, options());
}
export async function connectDatabase() {
  await client.connect();
  await database.command({ ping: 1 });
  for (const name of ['booths', 'officers', 'voters', 'audit_logs', 'admins']) {
    await collection(name).createIndex({ id: 1 }, { unique: true });
  }
  await collection('officers').createIndex({ booth_id: 1, username: 1 }, { unique: true });
  await collection('admins').createIndex({ username: 1 }, { unique: true });
  for (const name of ['officers', 'admins'])
    await collection(name).createIndex({ active_session_token: 1 });
  await collection('voters').createIndex({ booth_id: 1, serial_no: 1 }, { unique: true });
  await collection('voters').createIndex({ booth_id: 1, voter_id: 1 }, { unique: true });
  await collection('audit_logs').createIndex({ booth_id: 1, id: -1 });
}
export async function closeDatabase() {
  await client.close();
}
