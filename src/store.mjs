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
    try { await this.readAttempts(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.writeAttempts([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async saveNotices(notices) {
    const temporary = join(this.directory, `notices-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(notices));
    await rename(temporary, join(this.directory, 'notices.json'));
  }
  async listNotices() {
    return JSON.parse(await readFile(join(this.directory, 'notices.json'), 'utf8'));
  }
  async writeAttempts(attempts) {
    const temporary = join(this.directory, `attempts-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ attempts, savedAt: new Date().toISOString() }));
    await rename(temporary, join(this.directory, 'attempts.json'));
  }
  async readAttempts() {
    return JSON.parse(await readFile(join(this.directory, 'attempts.json'), 'utf8'));
  }
  async saveAttempts(attempts) {
    return this.runExclusive(async () => {
      await this.writeAttempts(attempts);
      return attempts;
    });
  }
  async runExclusive(job) {
    const operation = this.pending.then(job);
    this.pending = operation.catch(() => {});
    return operation;
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
  async acceptNotice(bytes, source, parsed, correlated, contradictions) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    return this.runExclusive(async () => {
      const notices = await this.listNotices();
      const existing = notices.find(notice => notice.digest === digest && notice.source === source);
      if (existing) return { notice: existing, duplicated: true };
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const notice = {
        id: randomUUID(),
        digest,
        source,
        bytes: bytes.length,
        sequence: notices.length,
        receivedAt: new Date().toISOString(),
        format: parsed.format,
        report: parsed.report,
        originalMessage: parsed.originalMessage,
        noticeDoubts: parsed.doubts,
        contradictions,
        recipients: parsed.recipients.map((block, index) => ({
          index,
          originalRecipient: block.originalRecipient,
          finalRecipient: block.finalRecipient,
          action: block.action,
          actionVerified: block.actionVerified,
          terminal: block.terminal,
          status: block.status,
          diagnosticCode: block.diagnosticCode,
          fields: block.fields,
          blockDoubts: block.doubts,
          correlation: correlated[index],
        })),
      };
      notices.push(notice);
      await this.saveNotices(notices);
      return { notice, duplicated: false };
    });
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
