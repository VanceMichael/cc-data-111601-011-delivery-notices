// 按实际可关联的发送尝试核对 DSN 结果。
// 线索不足或互相冲突时保留疑点（ambiguous/unmatched/doubtful），
// 绝不挑第一个候选，也绝不把疑点升级成“邮箱永久无效”。

const normalize = value => (value ?? '').toString().trim().toLowerCase();

function recipientCandidates(attempts, { originalEnvelopeId, messageId }) {
  const envelopeId = normalize(originalEnvelopeId);
  const id = normalize(messageId);
  const byEnvelope = envelopeId
    ? attempts.filter(attempt => normalize(attempt.id) === envelopeId) : [];
  const byMessage = id
    ? attempts.filter(attempt => normalize(attempt.messageId) === id) : [];
  if (!envelopeId && !id) return { candidates: [], idClue: false };
  const candidates = [...byEnvelope, ...byMessage]
    .filter((attempt, index, all) => all.findIndex(other => other.id === attempt.id) === index);
  return { candidates, idClue: true,
    idConflict: new Set(candidates.map(attempt => attempt.id)).size > 1 };
}

// 单个收件人块与发送尝试清单的关联。返回状态与疑点，不做推断式落锤。
export function correlateRecipient(block, context, attempts) {
  const doubts = [...block.doubts];
  const original = block.originalRecipient?.address?.toLowerCase() ?? null;
  const final = block.finalRecipient?.address?.toLowerCase() ?? null;
  const recipient = original ?? final;
  const { candidates, idClue, idConflict } = recipientCandidates(attempts, context);
  const candidateIds = candidates.map(attempt => attempt.id);

  if (idConflict) doubts.push('attempt_identifier_conflict');

  if (!idClue) {
    if (!recipient) {
      return { state: 'unmatched', attemptId: null, recipient: null,
        doubts: [...doubts, 'no_correlation_clue'], candidateIds: [] };
    }
    const containing = attempts.filter(attempt =>
      (attempt.recipients ?? []).some(address => normalize(address) === recipient));
    if (containing.length === 1) {
      if (!containing[0].recipients.map(normalize).includes(final)) {
        doubts.push('recipient_not_in_attempt');
      }
      return { state: 'doubtful', attemptId: containing[0].id, recipient,
        doubts: [...doubts, 'weak_recipient_only_match'], candidateIds: [containing[0].id] };
    }
    if (containing.length > 1) {
      return { state: 'ambiguous', attemptId: null, recipient,
        doubts: [...doubts, 'multiple_attempt_candidates'],
        candidateIds: containing.map(attempt => attempt.id) };
    }
    return { state: 'unmatched', attemptId: null, recipient,
      doubts: [...doubts, 'no_matching_attempt'], candidateIds: [] };
  }

  if (!candidates.length) {
    return { state: 'unmatched', attemptId: null, recipient,
      doubts: [...doubts, 'attempt_identifier_unknown'], candidateIds: [] };
  }
  if (candidates.length > 1 || idConflict) {
    return { state: 'ambiguous', attemptId: null, recipient,
      doubts: [...doubts, 'multiple_attempt_candidates'], candidateIds };
  }

  const attempt = candidates[0];
  const listed = (attempt.recipients ?? []).map(normalize);
  let effectiveRecipient = recipient;
  // Original/Final 不一致时，仅用同通知内已确认的改写线索提示别名，
  // 提示本身带疑点，不改变关联状态。
  if (original && final && original !== final) {
    doubts.push('original_final_mismatch');
    if (listed.includes(original)) effectiveRecipient = original;
    else if (listed.includes(final)) {
      doubts.push('matched_via_final_recipient');
      effectiveRecipient = final;
    }
  }
  if (effectiveRecipient && !listed.includes(effectiveRecipient)) {
    doubts.push('recipient_not_in_attempt');
  }
  // 唯一候选但带疑点（改写、块字段异常等）时标 doubtful；干净命中才是 matched。
  const state = doubts.length ? 'doubtful' : 'matched';
  return { state, attemptId: attempt.id, recipient: effectiveRecipient,
    doubts, candidateIds, aliasHint: original && final && original !== final ? { original, final } : null };
}

// 汇总同通知内各块之间是否自相矛盾（同一尝试同一收件人动作互斥）。
export function noticeLevelContradictions(correlated) {
  const doubts = [];
  const seen = new Map();
  for (const item of correlated) {
    if (!item.attemptId || !item.recipient) continue;
    const key = `${item.attemptId}|${item.recipient}`;
    const previous = seen.get(key);
    if (previous && previous.action !== item.action) {
      doubts.push({ key, actions: [previous.action, item.action] });
    }
    seen.set(key, { action: item.action });
  }
  return doubts;
}

// 跨通知构建逐（尝试, 收件人）台账。
// 已确认终态（failed/delivered/...）不被晚到的 delayed 覆盖；
// 终态互相冲突时保留双方事实并挂疑点，而不是推断地址永久无效。
export function buildLedger(notices, attempts) {
  const ordered = [...notices].sort((a, b) => a.sequence - b.sequence);
  const entries = new Map();
  const unresolved = [];

  const locate = (key, initial) => {
    if (!entries.has(key)) entries.set(key, initial());
    return entries.get(key);
  };

  for (const notice of ordered) {
    for (const block of notice.recipients) {
      const action = block.action?.toLowerCase() ?? null;
      const observation = {
        noticeId: notice.id,
        digest: notice.digest,
        sequence: notice.sequence,
        receivedAt: notice.receivedAt,
        action: block.action,
        status: block.status,
        diagnosticCode: block.diagnosticCode,
        state: block.state,
        doubts: [...block.doubts],
      };
      if (block.state === 'ambiguous' || block.state === 'unmatched' ||
          !block.attemptId || !block.recipient) {
        unresolved.push({ ...observation, recipient: block.recipient ?? null,
          candidateIds: block.candidateIds ?? [] });
        continue;
      }
      const key = `${block.attemptId}|${block.recipient}`;
      const entry = locate(key, () => ({
        attemptId: block.attemptId,
        recipient: block.recipient,
        observations: [],
        currentAction: null,
        terminal: null,
        doubts: new Set(),
        aliasHints: [],
      }));
      for (const doubt of block.doubts) entry.doubts.add(doubt);
      if (block.aliasHint &&
          !entry.aliasHints.some(hint => hint.original === block.aliasHint.original
            && hint.final === block.aliasHint.final)) {
        entry.aliasHints.push(block.aliasHint);
      }
      if (action === 'delayed') {
        if (entry.terminal !== null) entry.doubts.add('late_delayed_after_terminal');
        else if (entry.currentAction === null) entry.currentAction = block.action;
      } else if (block.actionVerified && block.terminal) {
        if (entry.terminal === null) {
          entry.terminal = block.action;
          entry.currentAction = block.action;
        } else if (entry.terminal !== block.action) {
          entry.doubts.add('terminal_conflict');
        }
      } else {
        entry.doubts.add('unverified_action');
        if (entry.terminal === null && entry.currentAction === null) {
          entry.currentAction = block.action;
        }
      }
      entry.observations.push(observation);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    attemptsCount: attempts.length,
    entries: [...entries.values()].map(entry => ({
      ...entry,
      doubts: [...entry.doubts],
    })),
    unresolved,
  };
}
