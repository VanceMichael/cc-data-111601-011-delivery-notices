import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = (path, body) => fetch(`${service.url}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  const attempts = await (await fetch(`${provider.url}/attempts`)).json();
  console.log('登记发送尝试', await (await post('/attempts', { attempts })).json());

  const primary = await post('/notices', { path: '/primary' });
  if (primary.status !== 201) throw new Error(await primary.text());
  const primaryBody = await primary.json();
  console.log('DSN 逐收件人结构', primaryBody.notice.recipients.map(block => ({
    originalRecipient: block.originalRecipient?.address ?? null,
    finalRecipient: block.finalRecipient.address,
    action: block.action,
    status: block.status,
    diagnosticCode: block.diagnosticCode,
    correlation: block.correlation,
  })));

  const delayed = await post('/notices', { path: '/delayed' });
  if (delayed.status !== 201) throw new Error(await delayed.text());
  console.log('晚到通知接收', (await delayed.json()).notice.recipients);

  const ledger = await (await fetch(`${service.url}/ledger`)).json();
  console.log('核对台账', {
    entries: ledger.entries.map(entry => ({
      attemptId: entry.attemptId, recipient: entry.recipient,
      currentAction: entry.currentAction, terminal: entry.terminal,
      doubts: entry.doubts, aliasHints: entry.aliasHints,
      observations: entry.observations.length,
    })),
    unresolved: ledger.unresolved,
  });

  // 兼容接口仍可使用
  const legacy = await post('/intakes', { path: '/primary' });
  console.log('兼容收件接口状态', legacy.status);
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
