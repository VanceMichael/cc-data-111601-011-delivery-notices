import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  for (const path of ['/primary', '/delayed']) {
    const notice = await fetch(`${service.url}/notices`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (notice.status !== 201) throw new Error(await notice.text());
    console.log(`通知解释 ${path}`, await notice.json());
  }
  console.log('合并台账', await (await fetch(`${service.url}/ledger`)).json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
