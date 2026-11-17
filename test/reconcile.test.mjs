import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateRecipient, buildLedger, noticeLevelContradictions } from '../src/reconcile.mjs';
import { parseDsn } from '../src/dsn.mjs';

const attempts = [
  { id: 'attempt-17', messageId: '<original-17@local.invalid>',
    recipients: ['old@local.invalid', 'second@local.invalid'] },
  { id: 'attempt-18', messageId: '<original-18@local.invalid>',
    recipients: ['old@local.invalid'] },
];

const block = ({ original = null, final, action = 'failed', status = '5.1.1',
  diagnosticCode = null, doubts = [], actionVerified = true, terminal = true }) => ({
  originalRecipient: original ? { address: original } : null,
  finalRecipient: { address: final },
  action, actionVerified, terminal, status, diagnosticCode, doubts,
});

test('envelope-id 与 message-id 共同指向唯一尝试时干净命中', () => {
  const result = correlateRecipient(
    block({ final: 'second@local.invalid' }),
    { originalEnvelopeId: 'attempt-17', messageId: '<original-17@local.invalid>' },
    attempts);
  assert.equal(result.state, 'matched');
  assert.equal(result.attemptId, 'attempt-17');
  assert.equal(result.recipient, 'second@local.invalid');
  assert.deepEqual(result.doubts, []);
});

test('原始与最终收件人不一致时保留改写疑点，不推断邮箱永久无效', () => {
  const result = correlateRecipient(
    block({ original: 'old@local.invalid', final: 'new@local.invalid', doubts: ['recipient_rewritten'] }),
    { originalEnvelopeId: 'attempt-17', messageId: '<original-17@local.invalid>' },
    attempts);
  assert.equal(result.state, 'doubtful');
  assert.equal(result.attemptId, 'attempt-17');
  assert.equal(result.recipient, 'old@local.invalid');
  assert.ok(result.doubts.includes('recipient_rewritten'));
  assert.ok(result.doubts.includes('original_final_mismatch'));
  assert.deepEqual(result.aliasHint, { original: 'old@local.invalid', final: 'new@local.invalid' });
});

test('仅有收件人线索且命中多个尝试时 ambiguous，不挑第一个', () => {
  const result = correlateRecipient(
    block({ final: 'old@local.invalid' }),
    { originalEnvelopeId: null, messageId: null },
    attempts);
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.attemptId, null);
  assert.deepEqual(result.candidateIds.sort(), ['attempt-17', 'attempt-18']);
  assert.ok(result.doubts.includes('multiple_attempt_candidates'));
});

test('仅有收件人线索且唯一命中时标弱关联疑点', () => {
  const result = correlateRecipient(
    block({ final: 'second@local.invalid' }),
    { originalEnvelopeId: null, messageId: null },
    attempts);
  assert.equal(result.state, 'doubtful');
  assert.equal(result.attemptId, 'attempt-17');
  assert.ok(result.doubts.includes('weak_recipient_only_match'));
});

test('线索指向未知尝试时 unmatched 并保留标识', () => {
  const result = correlateRecipient(
    block({ final: 'second@local.invalid' }),
    { originalEnvelopeId: 'attempt-99', messageId: null },
    attempts);
  assert.equal(result.state, 'unmatched');
  assert.ok(result.doubts.includes('attempt_identifier_unknown'));
});

test('envelope-id 与 message-id 指向不同尝试时自相矛盾，标 ambiguous', () => {
  const result = correlateRecipient(
    block({ final: 'old@local.invalid' }),
    { originalEnvelopeId: 'attempt-17', messageId: '<original-18@local.invalid>' },
    attempts);
  assert.equal(result.state, 'ambiguous');
  assert.ok(result.doubts.includes('attempt_identifier_conflict'));
  assert.deepEqual(result.candidateIds.sort(), ['attempt-17', 'attempt-18']);
});

test('收件人不在候选尝试名单内时保留疑点', () => {
  const result = correlateRecipient(
    block({ final: 'stranger@local.invalid' }),
    { originalEnvelopeId: 'attempt-17', messageId: '<original-17@local.invalid>' },
    attempts);
  assert.equal(result.state, 'doubtful');
  assert.ok(result.doubts.includes('recipient_not_in_attempt'));
});

const noticeOf = (id, sequence, recipients) => ({
  id, sequence, digest: `digest-${id}`, receivedAt: `2026-11-17T0${sequence}:00:00.000Z`, recipients,
});
const ledgerBlock = ({ attemptId, recipient, action, state = 'matched',
  actionVerified = true, terminal = true, doubts = [], aliasHint = null,
  status = '5.1.1', diagnosticCode = null }) => ({
  attemptId, recipient, action, actionVerified, terminal, state, doubts, aliasHint,
  status, diagnosticCode, candidateIds: [],
});

test('台账：晚到的 delayed 不覆盖已确认失败，且逐收件人隔离', () => {
  const notices = [
    noticeOf('n1', 0, [
      ledgerBlock({ attemptId: 'attempt-17', recipient: 'old@local.invalid',
        action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 unavailable',
        doubts: ['recipient_rewritten'] }),
      ledgerBlock({ attemptId: 'attempt-17', recipient: 'second@local.invalid',
        action: 'delayed', terminal: false, status: '4.2.0' }),
    ]),
    noticeOf('n2', 1, [
      ledgerBlock({ attemptId: 'attempt-17', recipient: 'old@local.invalid',
        action: 'delayed', terminal: false, status: '4.2.0' }),
    ]),
  ];
  const ledger = buildLedger(notices, attempts);
  const failed = ledger.entries.find(e => e.recipient === 'old@local.invalid');
  assert.equal(failed.currentAction, 'failed');
  assert.equal(failed.terminal, 'failed');
  assert.equal(failed.observations.length, 2);
  assert.ok(failed.doubts.includes('late_delayed_after_terminal'));
  const second = ledger.entries.find(e => e.recipient === 'second@local.invalid');
  assert.equal(second.currentAction, 'delayed');
  assert.equal(second.terminal, null);
});

test('台账：先到 delayed 后到 failed，终态落锤且不产生覆盖疑点', () => {
  const notices = [
    noticeOf('n1', 0, [ledgerBlock({ attemptId: 'attempt-18', recipient: 'old@local.invalid',
      action: 'delayed', terminal: false, status: '4.2.0' })]),
    noticeOf('n2', 1, [ledgerBlock({ attemptId: 'attempt-18', recipient: 'old@local.invalid',
      action: 'failed', status: '5.1.1' })]),
  ];
  const ledger = buildLedger(notices, attempts);
  const entry = ledger.entries.find(e => e.attemptId === 'attempt-18');
  assert.equal(entry.currentAction, 'failed');
  assert.equal(entry.terminal, 'failed');
  assert.ok(!entry.doubts.includes('late_delayed_after_terminal'));
});

test('台账：终态互相冲突时保留双方事实并挂疑点', () => {
  const notices = [
    noticeOf('n1', 0, [ledgerBlock({ attemptId: 'attempt-18', recipient: 'old@local.invalid',
      action: 'failed', status: '5.1.1' })]),
    noticeOf('n2', 1, [ledgerBlock({ attemptId: 'attempt-18', recipient: 'old@local.invalid',
      action: 'delivered', status: '2.0.0' })]),
  ];
  const ledger = buildLedger(notices, attempts);
  const entry = ledger.entries.find(e => e.attemptId === 'attempt-18');
  assert.equal(entry.terminal, 'failed');
  assert.ok(entry.doubts.includes('terminal_conflict'));
  assert.deepEqual(entry.observations.map(o => o.action), ['failed', 'delivered']);
});

test('台账：ambiguous/unmatched 观察进入 unresolved，不进入任何地址的确定结论', () => {
  const notices = [
    noticeOf('n1', 0, [
      { ...ledgerBlock({ attemptId: null, recipient: 'old@local.invalid', action: 'failed' }),
        state: 'ambiguous', candidateIds: ['attempt-17', 'attempt-18'],
        doubts: ['multiple_attempt_candidates'] },
      { ...ledgerBlock({ attemptId: null, recipient: 'ghost@local.invalid', action: 'failed' }),
        state: 'unmatched', candidateIds: [], doubts: ['attempt_identifier_unknown'] },
    ]),
  ];
  const ledger = buildLedger(notices, attempts);
  assert.equal(ledger.entries.length, 0);
  assert.equal(ledger.unresolved.length, 2);
  assert.deepEqual(ledger.unresolved.map(item => item.state).sort(), ['ambiguous', 'unmatched']);
});

test('同通知内同尝试同收件人动作互斥被识别为自相矛盾', () => {
  const contradictions = noticeLevelContradictions([
    { attemptId: 'a1', recipient: 'r@x.invalid', action: 'failed' },
    { attemptId: 'a1', recipient: 'r@x.invalid', action: 'delayed' },
    { attemptId: 'a1', recipient: 's@x.invalid', action: 'failed' },
  ]);
  assert.equal(contradictions.length, 1);
  assert.deepEqual(contradictions[0].actions, ['failed', 'delayed']);
});

test('解析与关联串联：自相矛盾的多块通知保留全部块并挂矛盾结论', () => {
  const bytes = Buffer.from(
    'Content-Type: message/delivery-status\r\n\r\n' +
    'Reporting-MTA: dns; mx\r\n' +
    'Original-Envelope-Id: attempt-17\r\n\r\n' +
    'Final-Recipient: rfc822; second@local.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n' +
    'Final-Recipient: rfc822; second@local.invalid\r\nAction: delayed\r\nStatus: 4.2.0\r\n');
  const parsed = parseDsn(bytes);
  const context = { originalEnvelopeId: parsed.report.originalEnvelopeId,
    messageId: parsed.originalMessage.messageId };
  const correlated = parsed.recipients.map(block =>
    correlateRecipient(block, context, attempts));
  assert.deepEqual(correlated.map(item => item.state), ['matched', 'matched']);
  const contradictions = noticeLevelContradictions(correlated.map((item, index) => ({
    ...item, action: parsed.recipients[index].action })));
  assert.equal(contradictions.length, 1);
  assert.deepEqual(contradictions[0].actions, ['failed', 'delayed']);
});

test('解析与台账串联：未知动作的失败通知不产生任何终态结论', () => {
  const notices = [
    noticeOf('n1', 0, [
      { ...ledgerBlock({ attemptId: 'attempt-17', recipient: 'second@local.invalid',
        action: 'bounced', actionVerified: false, terminal: false,
        status: '5.1.1', doubts: ['unknown_action'] }) },
    ]),
  ];
  const ledger = buildLedger(notices, attempts);
  const entry = ledger.entries.find(e => e.recipient === 'second@local.invalid');
  assert.equal(entry.terminal, null);
  assert.equal(entry.currentAction, 'bounced');
  assert.ok(entry.doubts.includes('unknown_action'));
  assert.ok(entry.doubts.includes('unverified_action'));
});
