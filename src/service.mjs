import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseDsn } from './dsn.mjs';
import { correlateRecipient, noticeLevelContradictions, buildLedger } from './reconcile.mjs';

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function validateAttempts(value) {
  if (!Array.isArray(value)) throw new Error('attempts_array_required');
  const seen = new Set();
  const normalized = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string'
        || typeof item.messageId !== 'string' || !Array.isArray(item.recipients)
        || item.recipients.some(address => typeof address !== 'string')) {
      throw new Error('attempt_shape_invalid');
    }
    const key = item.id.toLowerCase();
    if (seen.has(key)) throw new Error('attempt_id_duplicated');
    seen.add(key);
    return { id: item.id, messageId: item.messageId,
      recipients: [...item.recipients] };
  });
  return normalized;
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      // 兼容接口：单件原件领取，不解释 DSN。
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      // 发送尝试清单快照：DSN 关联的事实依据，仅整份替换。
      if (url.pathname === '/attempts' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.readAttempts()));
      }
      if (url.pathname === '/attempts' && request.method === 'POST') {
        const payload = await readJson(request);
        const attempts = validateAttempts(payload.attempts ?? payload);
        await store.saveAttempts(attempts);
        return response.end(JSON.stringify({ saved: attempts.length }));
      }
      // DSN 结构化接收：逐收件人解析并关联发送尝试，保留疑点。
      if (url.pathname === '/notices' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listNotices()));
      }
      if (url.pathname === '/notices' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const sourceHref = new URL(payload.path, source).href;
        const parsed = parseDsn(result.bytes);
        const snapshot = await store.readAttempts();
        const context = {
          originalEnvelopeId: parsed.report.originalEnvelopeId,
          messageId: parsed.originalMessage.messageId,
        };
        const correlated = parsed.recipients.map(block =>
          correlateRecipient(block, context, snapshot.attempts));
        const contradictions = noticeLevelContradictions(correlated.map((correlation, index) => ({
          ...correlation, action: parsed.recipients[index].action })));
        const { notice, duplicated } = await store.acceptNotice(
          result.bytes, sourceHref, parsed, correlated, contradictions);
        response.statusCode = 201;
        return response.end(JSON.stringify({ duplicated, notice, ledger: '/ledger' }));
      }
      // 逐（尝试, 收件人）核对台账：终态不被晚到 delayed 覆盖。
      if (url.pathname === '/ledger' && request.method === 'GET') {
        const [notices, snapshot] = await Promise.all([store.listNotices(), store.readAttempts()]);
        const flat = notices.map(notice => ({
          ...notice,
          recipients: notice.recipients.map(block => ({
            action: block.action,
            actionVerified: block.actionVerified,
            terminal: block.terminal,
            status: block.status,
            diagnosticCode: block.diagnosticCode,
            ...block.correlation,
            doubts: [...new Set([...block.blockDoubts, ...block.correlation.doubts])],
          })),
        }));
        return response.end(JSON.stringify(buildLedger(flat, snapshot.attempts)));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
