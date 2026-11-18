import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNotice, correlate, assess, buildLedger } from '../src/dsn.mjs';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const delayed = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
const attempts = JSON.parse(await readFile(new URL('../fixtures/resource-01.bin', import.meta.url), 'utf8'));

function assessed(id, bytes, list = attempts) {
  const notice = parseNotice(bytes);
  return { id, ...notice, ...assess(notice, list) };
}

test('multipart 通知逐收件人解释，转发原信内的同名状态字段不混入', () => {
  const notice = parseNotice(primary);
  assert.equal(notice.kind, 'delivery-status');
  assert.equal(notice.messageId, '<notice-1@local.invalid>');
  assert.equal(notice.report.reportingMta, 'dns; mx.local.invalid');
  assert.equal(notice.clues.originalEnvelopeId, 'attempt-17');
  assert.equal(notice.clues.originalMessageId, '<original-17@local.invalid>');
  assert.equal(notice.recipients.length, 2);
  const [failed, pending] = notice.recipients;
  assert.equal(failed.originalRecipient.address, 'old@local.invalid');
  assert.equal(failed.finalRecipient.address, 'new@local.invalid');
  assert.equal(failed.action, 'failed');
  assert.equal(failed.status, '5.1.1');
  assert.equal(failed.diagnosticCode, 'smtp; 550 unavailable');
  assert.equal(pending.originalRecipient, null);
  assert.equal(pending.finalRecipient.address, 'second@local.invalid');
  assert.equal(pending.action, 'delayed');
  assert.equal(pending.status, '4.2.0');
});

test('单独 message/delivery-status 通知同样解释', () => {
  const notice = parseNotice(delayed);
  assert.equal(notice.recipients.length, 1);
  assert.equal(notice.clues.originalEnvelopeId, 'attempt-17');
  assert.equal(notice.clues.originalMessageId, null);
  assert.equal(notice.recipients[0].action, 'delayed');
  assert.equal(notice.recipients[0].status, '4.2.0');
  assert.equal(notice.recipients[0].finalRecipient.address, 'new@local.invalid');
});

test('折行展开且重复状态头保留', () => {
  const bytes = Buffer.from([
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.local.invalid',
    '',
    'Final-Recipient: rfc822; user@local.invalid',
    'Action: failed',
    'Status: 5.1.1',
    'Status: 5.0.0',
    'Diagnostic-Code: smtp; 550',
    ' unavailable',
    '',
  ].join('\r\n'));
  const [recipient] = parseNotice(bytes).recipients;
  assert.equal(recipient.diagnosticCode, 'smtp; 550 unavailable');
  assert.equal(recipient.status, '5.1.1');
  assert.equal(recipient.fields.filter(([name]) => name === 'status').length, 2);
});

test('非 delivery-status 或缺块的输入被拒绝', () => {
  assert.throws(() => parseNotice(Buffer.from('Content-Type: text/plain\r\n\r\nhello')), /not_delivery_status/);
  assert.throws(() => parseNotice(Buffer.from('[{"id":"attempt-17"}]')), /mail_header_separator/);
  assert.throws(() => parseNotice(Buffer.from(
    'Content-Type: multipart/report; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhi\r\n--x--\r\n')),
    /dsn_part_missing/);
  assert.throws(() => parseNotice(Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mx\r\n\r\nAction: failed\r\n')),
    /dsn_final_recipient_missing/);
  assert.throws(() => parseNotice(Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mx\r\n')), /dsn_recipient_missing/);
});

test('信封、原信标识与原始收件人共同核对出发送尝试', () => {
  const { correlation, recipients } = assess(parseNotice(primary), attempts);
  assert.equal(correlation.state, 'matched');
  assert.equal(correlation.attemptId, 'attempt-17');
  assert.ok(recipients[0].doubts.includes('recipient-changed'));
  assert.deepEqual(recipients[1].doubts, []);
});

test('线索不足、相互矛盾或多候选时不挑第一个候选', () => {
  assert.equal(correlate({ clues: {}, recipients: [] }, attempts).reason, 'no-clues');
  const conflict = correlate({ clues: { originalEnvelopeId: 'attempt-17', originalMessageId: '<original-18@local.invalid>' },
    recipients: [] }, attempts);
  assert.equal(conflict.state, 'ambiguous');
  assert.equal(conflict.reason, 'conflicting-clues');
  assert.equal(conflict.attemptId, null);
  const multiple = correlate({ clues: {}, recipients: [{ originalRecipient: { address: 'old@local.invalid' },
    finalRecipient: { address: 'old@local.invalid' } }] }, attempts);
  assert.equal(multiple.state, 'ambiguous');
  assert.equal(multiple.reason, 'multiple-candidates');
  const missing = correlate({ clues: { originalEnvelopeId: 'attempt-99' }, recipients: [] }, attempts);
  assert.equal(missing.state, 'unmatched');
  assert.equal(missing.reason, 'no-matching-attempt');
  const partial = correlate({ clues: { originalEnvelopeId: 'attempt-17', originalMessageId: '<ghost@local.invalid>' },
    recipients: [] }, attempts);
  assert.equal(partial.state, 'matched');
  assert.equal(partial.attemptId, 'attempt-17');
  assert.ok(partial.doubts.includes('clue-without-attempt'));
});

test('同一通知内同一收件人动作自相矛盾时保留疑点', () => {
  const bytes = Buffer.from([
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.local.invalid',
    'Original-Envelope-Id: attempt-17',
    '',
    'Final-Recipient: rfc822; second@local.invalid',
    'Action: failed',
    'Status: 5.1.1',
    '',
    'Final-Recipient: rfc822; second@local.invalid',
    'Action: delivered',
    'Status: 2.0.0',
    '',
  ].join('\r\n'));
  const { recipients } = assess(parseNotice(bytes), attempts);
  assert.ok(recipients[0].doubts.includes('conflicting-actions'));
  assert.ok(recipients[1].doubts.includes('conflicting-actions'));
});

test('较晚到达的暂缓不覆盖已确认的失败，且只落在对应收件人', () => {
  const ledger = buildLedger([assessed('n1', primary), assessed('n2', delayed)]);
  const entry = ledger.find(item => item.recipient === 'new@local.invalid');
  assert.equal(entry.attemptId, 'attempt-17');
  assert.equal(entry.outcome.action, 'failed');
  assert.equal(entry.outcome.status, '5.1.1');
  assert.equal(entry.confirmed.action, 'failed');
  assert.deepEqual(entry.observations.map(observation => observation.action), ['failed', 'delayed']);
  assert.ok(entry.doubts.includes('recipient-changed'));
  const pending = ledger.find(item => item.recipient === 'second@local.invalid');
  assert.equal(pending.outcome.action, 'delayed');
  assert.equal(pending.confirmed, null);
  assert.ok(!ledger.some(item => item.recipient === 'old@local.invalid'));
});

test('先到的暂缓会被后来的失败更新为已确认', () => {
  const ledger = buildLedger([assessed('n1', delayed), assessed('n2', primary)]);
  const entry = ledger.find(item => item.recipient === 'new@local.invalid');
  assert.equal(entry.outcome.action, 'failed');
  assert.deepEqual(entry.observations.map(observation => observation.action), ['delayed', 'failed']);
});

test('终态相互矛盾时保留先确认的事实并留下疑点', () => {
  const delivered = Buffer.from([
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.local.invalid',
    'Original-Envelope-Id: attempt-17',
    '',
    'Final-Recipient: rfc822; new@local.invalid',
    'Action: delivered',
    'Status: 2.0.0',
    '',
  ].join('\r\n'));
  const ledger = buildLedger([assessed('n1', primary), assessed('n2', delivered)]);
  const entry = ledger.find(item => item.recipient === 'new@local.invalid');
  assert.equal(entry.confirmed.action, 'failed');
  assert.equal(entry.outcome.action, 'failed');
  assert.ok(entry.doubts.includes('conflicting-actions'));
});

test('关联不上的通知仍保留事实与疑点，不断言邮箱永久无效', () => {
  const orphan = Buffer.from([
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.local.invalid',
    '',
    'Final-Recipient: rfc822; ghost@local.invalid',
    'Action: failed',
    'Status: 5.1.1',
    '',
  ].join('\r\n'));
  const ledger = buildLedger([assessed('n1', orphan)]);
  const entry = ledger.find(item => item.recipient === 'ghost@local.invalid');
  assert.equal(entry.attemptId, null);
  assert.equal(entry.outcome.action, 'failed');
  assert.ok(entry.doubts.includes('unmatched'));
});

test('通知接收、台账合并、重领幂等与持久重开', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notice-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  t.after(async () => {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = path => fetch(`${service.url}/notices`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  const first = await post('/primary');
  assert.equal(first.status, 201);
  const notice = await first.json();
  assert.equal(notice.correlation.attemptId, 'attempt-17');
  assert.equal(notice.recipients.length, 2);
  assert.ok(notice.recipients[0].doubts.includes('recipient-changed'));
  assert.equal((await post('/delayed')).status, 201);
  const again = await post('/primary');
  assert.equal((await again.json()).id, notice.id);
  assert.equal((await (await fetch(`${service.url}/notices`)).json()).length, 2);
  const ledger = await (await fetch(`${service.url}/ledger`)).json();
  const entry = ledger.find(item => item.recipient === 'new@local.invalid');
  assert.equal(entry.outcome.action, 'failed');
  assert.equal(entry.observations.length, 2);
  assert.ok(!ledger.some(item => item.recipient === 'old@local.invalid'));
  assert.equal((await (await fetch(`${service.url}/notices`)).json()).length, 2);
  const record = (await (await fetch(`${service.url}/records`)).json()).find(item => item.digest === notice.digest);
  assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()), primary);
  assert.equal((await post('/attempts')).status, 422);
  assert.equal((await post('/missing')).status, 422);
  assert.equal((await (await fetch(`${service.url}/notices`)).json()).length, 2);
  assert.equal((await new Store(directory).listNotices()).length, 2);
  await service.close();
  const reopened = await startService({ source: provider.url, directory });
  t.after(() => reopened.close());
  const notices = await (await fetch(`${reopened.url}/notices`)).json();
  assert.equal(notices.length, 2);
  const rebuilt = await (await fetch(`${reopened.url}/ledger`)).json();
  assert.equal(rebuilt.find(item => item.recipient === 'new@local.invalid').outcome.action, 'failed');
});

test('发送尝试来源不可用时通知仍保存并标记疑点', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notice-test-'));
  const bare = http.createServer((request, response) => {
    if (request.url === '/notice') {
      response.setHeader('Content-Type', 'message/rfc822');
      return response.end(delayed);
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve));
  const service = await startService({ source: `http://127.0.0.1:${bare.address().port}`, directory });
  t.after(async () => {
    await service.close();
    await new Promise(resolve => bare.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(`${service.url}/notices`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/notice' }) });
  assert.equal(response.status, 201);
  const notice = await response.json();
  assert.equal(notice.correlation.state, 'unmatched');
  assert.equal(notice.correlation.reason, 'attempts-unavailable');
  const ledger = await (await fetch(`${service.url}/ledger`)).json();
  assert.ok(ledger[0].doubts.includes('unmatched'));
});
