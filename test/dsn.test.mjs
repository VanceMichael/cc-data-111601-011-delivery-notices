import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDsn, parseContentType } from '../src/dsn.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const delayed = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));

test('multipart/report 按收件人逐块结构化，原信正文同名字段不被采集', () => {
  const parsed = parseDsn(primary);
  assert.equal(parsed.format, 'multipart-report');
  assert.equal(parsed.report.originalEnvelopeId, 'attempt-17');
  assert.equal(parsed.originalMessage.messageId, '<original-17@local.invalid>');
  assert.equal(parsed.recipients.length, 2);
  const [first, second] = parsed.recipients;
  assert.equal(first.action, 'failed');
  assert.equal(first.status, '5.1.1');
  assert.equal(first.diagnosticCode, 'smtp; 550 unavailable');
  assert.equal(first.originalRecipient.address, 'old@local.invalid');
  assert.equal(first.finalRecipient.address, 'new@local.invalid');
  assert.ok(first.doubts.includes('recipient_rewritten'));
  assert.equal(second.action, 'delayed');
  assert.equal(second.status, '4.2.0');
  assert.equal(second.diagnosticCode, null);
  // 原信 message/rfc822 正文中的 Action: failed / Status: 5.1.1 不得进入任何块
  const allActions = parsed.recipients.flatMap(block =>
    block.fields.filter(([name]) => name === 'action')).map(([, value]) => value);
  assert.deepEqual(allActions, ['failed', 'delayed']);
});

test('独立 message/delivery-status 可直接解析', () => {
  const parsed = parseDsn(delayed);
  assert.equal(parsed.format, 'delivery-status');
  assert.equal(parsed.originalMessage.present, false);
  assert.equal(parsed.recipients.length, 1);
  assert.equal(parsed.recipients[0].action, 'delayed');
  assert.equal(parsed.recipients[0].finalRecipient.address, 'new@local.invalid');
});

test('折行展开且重复头保留，互斥重复头产生疑点', () => {
  const folded = Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\n' +
    'Reporting-MTA: dns; mx\r\n\r\n' +
    'Final-Recipient: rfc822; a@x.invalid\r\n' +
    'Diagnostic-Code: smtp; 550\r\n mailbox\r\n' +
    'Action: failed\r\nAction: delayed\r\n' +
    'Status: 5.1.1\r\nStatus: 5.1.1\r\n');
  const parsed = parseDsn(folded);
  const block = parsed.recipients[0];
  assert.equal(block.diagnosticCode, 'smtp; 550 mailbox');
  assert.equal(block.fields.filter(([name]) => name === 'action').length, 2);
  assert.ok(block.doubts.includes('contradictory_fields'));
  // 一致的重复 Status 不算矛盾
  assert.equal(block.fields.filter(([name]) => name === 'status').length, 2);
});

test('未知 Action、畸形状态码与缺失字段保留疑点而非推断', () => {
  const weird = Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\n' +
    'Reporting-MTA: dns; mx\r\n\r\n' +
    'Final-Recipient: rfc822; b@x.invalid\r\n' +
    'Action: bounced\r\nStatus: 9.9\r\n');
  const block = parseDsn(weird).recipients[0];
  assert.equal(block.action, 'bounced');
  assert.equal(block.actionVerified, false);
  assert.ok(block.doubts.includes('unknown_action'));
  assert.ok(block.doubts.includes('malformed_status'));
});

test('畸形行不整封拒收，非 DSN 内容明确报错', () => {
  const malformed = Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\n' +
    'Reporting-MTA: dns; mx\r\n\r\n' +
    'broken-line-no-colon\r\n' +
    'Final-Recipient: rfc822; c@x.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\n');
  const parsed = parseDsn(malformed);
  assert.ok(parsed.recipients[0].doubts.includes('malformed_field_line'));
  assert.throws(() => parseDsn(Buffer.from('Content-Type: text/plain\r\n\r\nhello')),
    /not_delivery_status/);
  assert.throws(() => parseDsn(Buffer.from('Subject: no separator')),
    /mail_header_separator/);
});

test('Content-Type 参数解析支持引号边界', () => {
  const parsed = parseContentType('multipart/report; boundary="a;b"; report-type=delivery-status');
  assert.equal(parsed.type, 'multipart/report');
  assert.equal(parsed.params.boundary, 'a;b');
  assert.equal(parsed.params['report-type'], 'delivery-status');
});
