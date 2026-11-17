import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'notice-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const post = (path, body) => fetch(`${service.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const get = path => fetch(`${service.url}${path}`);
  return { directory, provider, service, post, get,
    cleanup: async () => { await service.close(); await provider.close();
      await rm(directory, { recursive: true, force: true }); } };
}

test('DSN 端到端：逐收件人结构化、关联尝试、原信陷阱字段不入库', async () => {
  const h = await harness();
  try {
    const attempts = await (await fetch(`${h.provider.url}/attempts`)).json();
    const saved = await h.post('/attempts', { attempts });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).saved, 2);

    const response = await h.post('/notices', { path: '/primary' });
    assert.equal(response.status, 201);
    const { duplicated, notice } = await response.json();
    assert.equal(duplicated, false);
    assert.equal(notice.report.originalEnvelopeId, 'attempt-17');
    assert.equal(notice.originalMessage.messageId, '<original-17@local.invalid>');
    assert.equal(notice.recipients.length, 2);

    const [first, second] = notice.recipients;
    assert.equal(first.action, 'failed');
    assert.equal(first.status, '5.1.1');
    assert.equal(first.diagnosticCode, 'smtp; 550 unavailable');
    assert.equal(first.originalRecipient.address, 'old@local.invalid');
    assert.equal(first.finalRecipient.address, 'new@local.invalid');
    assert.equal(first.correlation.state, 'doubtful');
    assert.equal(first.correlation.attemptId, 'attempt-17');
    assert.equal(first.correlation.recipient, 'old@local.invalid');
    assert.ok(first.correlation.doubts.includes('recipient_rewritten'));
    assert.ok(first.correlation.doubts.includes('original_final_mismatch'));
    assert.equal(second.action, 'delayed');
    assert.equal(second.correlation.state, 'matched');
    assert.equal(second.correlation.attemptId, 'attempt-17');

    // message/rfc822 正文中的陷阱 Action/Status 不得出现在任何块字段里
    const storedActions = notice.recipients.flatMap(item =>
      item.fields.filter(([name]) => name === 'action')).map(([, value]) => value);
    assert.deepEqual(storedActions, ['failed', 'delayed']);

    // 原件字节仍可取回
    const raw = Buffer.from(await (await h.get(`/objects/${notice.digest}`)).arrayBuffer());
    assert.match(raw.toString(), /multipart\/report/);
  } finally { await h.cleanup(); }
});

test('晚到的 delayed 不抹掉已确认失败；疑点收件人不推断永久失效', async () => {
  const h = await harness();
  try {
    const attempts = await (await fetch(`${h.provider.url}/attempts`)).json();
    await h.post('/attempts', { attempts });
    await h.post('/notices', { path: '/primary' });
    const delayed = await h.post('/notices', { path: '/delayed' });
    assert.equal(delayed.status, 201);

    const ledger = await (await h.get('/ledger')).json();
    const failed = ledger.entries.find(e => e.attemptId === 'attempt-17'
      && e.recipient === 'old@local.invalid');
    assert.equal(failed.terminal, 'failed');
    assert.equal(failed.currentAction, 'failed');
    assert.equal(failed.observations.length, 1); // delayed 是另一个收件人键，不并入此条
    assert.ok(failed.doubts.includes('recipient_rewritten'));
    assert.deepEqual(failed.aliasHints, [{ original: 'old@local.invalid', final: 'new@local.invalid' }]);

    const second = ledger.entries.find(e => e.recipient === 'second@local.invalid');
    assert.equal(second.terminal, null);
    assert.equal(second.currentAction, 'delayed');

    // delayed 通知只有 final=new@，该地址不在尝试名单里：保留疑点，不做永久失效结论
    const rewritten = ledger.entries.find(e => e.recipient === 'new@local.invalid');
    assert.equal(rewritten.terminal, null);
    assert.equal(rewritten.currentAction, 'delayed');
    assert.ok(rewritten.doubts.includes('recipient_not_in_attempt'));

    // 不存在任何“地址全局无效”字段；同一 old@ 在 attempt-18 下没有条目
    assert.ok(!ledger.entries.some(e => e.attemptId === 'attempt-18'));
    assert.ok(!ledger.entries.some(e => 'addressInvalid' in e || 'permanentlyInvalid' in e));
  } finally { await h.cleanup(); }
});

test('重领同一通知幂等；重启后通知与台账仍在', async () => {
  const h = await harness();
  try {
    const attempts = await (await fetch(`${h.provider.url}/attempts`)).json();
    await h.post('/attempts', { attempts });
    const first = await (await h.post('/notices', { path: '/primary' })).json();
    const again = await h.post('/notices', { path: '/primary' });
    assert.equal(again.status, 201);
    const repeat = await again.json();
    assert.equal(repeat.duplicated, true);
    assert.equal(repeat.notice.id, first.notice.id);
    assert.equal((await (await h.get('/notices')).json()).length, 1);

    await h.service.close();
    const reopened = await startService({ source: h.provider.url, directory: h.directory });
    try {
      const notices = await (await fetch(`${reopened.url}/notices`)).json();
      assert.equal(notices.length, 1);
      const ledger = await (await fetch(`${reopened.url}/ledger`)).json();
      assert.ok(ledger.entries.length >= 2);
      const stored = await (await fetch(`${reopened.url}/attempts`)).json();
      assert.equal(stored.attempts.length, 2);
    } finally { await reopened.close(); }
  } finally { await h.cleanup(); }
});

test('畸形与越界输入被拒且不产生通知；GET 接口无写副作用', async () => {
  const h = await harness();
  try {
    assert.equal((await h.post('/notices', { path: '/missing' })).status, 422);
    assert.equal((await h.post('/notices', { path: 'https://example.invalid/x' })).status, 422);
    assert.equal((await h.post('/notices', {})).status, 422);
    assert.equal((await h.post('/attempts', { attempts: [{ id: 'x' }] })).status, 422);
    assert.equal((await h.post('/attempts', { attempts: 'not-array' })).status, 422);
    assert.deepEqual(await (await h.get('/notices')).json(), []);
    assert.deepEqual((await (await h.get('/ledger')).json()).entries, []);
    // 兼容接口保持不变
    const legacy = await h.post('/intakes', { path: '/primary' });
    assert.equal(legacy.status, 201);
    const records = await (await h.get('/records')).json();
    assert.equal(records.length, 1);
    assert.equal(records[0].parsed.kind, 'mail-envelope');
  } finally { await h.cleanup(); }
});
