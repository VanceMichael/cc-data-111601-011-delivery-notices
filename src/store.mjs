import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listNotices(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveNotices([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async saveNotices(notices) {
    const temporary = join(this.directory, `notices-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(notices));
    await rename(temporary, join(this.directory, 'notices.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listNotices() {
    return JSON.parse(await readFile(join(this.directory, 'notices.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async acceptNotice(notice) {
    const operation = this.pending.then(async () => {
      const notices = await this.listNotices();
      const existing = notices.find(record => record.digest === notice.digest && record.source === notice.source);
      if (existing) return existing;
      const record = { id: randomUUID(), ...notice };
      notices.push(record);
      await this.saveNotices(notices);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
