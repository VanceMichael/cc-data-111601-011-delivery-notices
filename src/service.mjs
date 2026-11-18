import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseNotice, assess, buildLedger } from './dsn.mjs';
import { startProvider } from './provider.mjs';

async function readJson(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function loadAttempts(source) {
  try {
    const catalog = JSON.parse((await acquire(source, '/catalog')).bytes.toString('utf8'));
    if (typeof catalog?.attempts !== 'string') return null;
    const attempts = JSON.parse((await acquire(source, catalog.attempts)).bytes.toString('utf8'));
    return Array.isArray(attempts) ? attempts : null;
  } catch { return null; }
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/notices' && request.method === 'GET') return response.end(JSON.stringify(await store.listNotices()));
      if (url.pathname === '/ledger' && request.method === 'GET') return response.end(JSON.stringify(buildLedger(await store.listNotices())));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/notices' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const notice = parseNotice(result.bytes);
        const assessment = assess(notice, await loadAttempts(source));
        const href = new URL(payload.path, source).href;
        const record = await store.accept(result.bytes, href, inspect(result.bytes));
        const stored = await store.acceptNotice({ digest: record.digest, source: href, ...notice, ...assessment });
        response.statusCode = 201;
        return response.end(JSON.stringify(stored));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
