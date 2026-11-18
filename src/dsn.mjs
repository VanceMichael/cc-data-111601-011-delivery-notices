const TERMINAL_ACTIONS = new Set(['failed', 'delivered']);
const ACTION_RANK = new Map([['delayed', 1], ['relayed', 2], ['expanded', 2], ['failed', 3], ['delivered', 3]]);

function splitMessage(text) {
  const split = /\r?\n\r?\n/.exec(text);
  if (!split) throw new Error('mail_header_separator');
  return { headerText: text.slice(0, split.index), body: text.slice(split.index + split[0].length) };
}

function parseFields(section) {
  const fields = [];
  for (const line of section.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at < 1) throw new Error('dsn_field_line');
    fields.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return fields;
}

function contentTypeOf(fields) {
  const raw = fields.find(([name]) => name === 'content-type')?.[1];
  if (!raw) return null;
  const [type, ...rest] = raw.split(';');
  const parameters = {};
  for (const parameter of rest) {
    const at = parameter.indexOf('=');
    if (at < 1) continue;
    let value = parameter.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    parameters[parameter.slice(0, at).trim().toLowerCase()] = value;
  }
  return { type: type.trim().toLowerCase(), parameters };
}

function splitParts(body, boundary) {
  const delimiter = `--${boundary}`;
  const parts = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+$/, '');
    if (line === delimiter) {
      if (current !== null) parts.push(current.join('\n'));
      current = [];
      continue;
    }
    if (line === `${delimiter}--`) {
      if (current !== null) parts.push(current.join('\n'));
      current = null;
      break;
    }
    if (current !== null) current.push(rawLine);
  }
  if (current !== null) parts.push(current.join('\n'));
  return parts;
}

function parseBlocks(body) {
  return body.split(/\r?\n\r?\n/).map(block => block.trim()).filter(Boolean).map(block => parseFields(block));
}

function fieldValue(fields, name) {
  return fields.find(([field]) => field === name)?.[1] ?? null;
}

function addressField(value) {
  if (value === null || value === undefined) return null;
  const at = value.indexOf(';');
  if (at < 0) return { type: null, address: value.trim(), raw: value };
  return { type: value.slice(0, at).trim().toLowerCase() || null, address: value.slice(at + 1).trim(), raw: value };
}

function recipientResult(fields) {
  const finalRecipient = addressField(fieldValue(fields, 'final-recipient'));
  if (!finalRecipient || !finalRecipient.address) throw new Error('dsn_final_recipient_missing');
  const action = fieldValue(fields, 'action');
  if (!action) throw new Error('dsn_action_missing');
  return {
    originalRecipient: addressField(fieldValue(fields, 'original-recipient')),
    finalRecipient,
    action,
    status: fieldValue(fields, 'status'),
    diagnosticCode: fieldValue(fields, 'diagnostic-code'),
    fields,
  };
}

function embeddedMessageId(body) {
  try {
    let headerText;
    try { headerText = splitMessage(body).headerText; } catch { headerText = body; }
    return fieldValue(parseFields(headerText), 'message-id');
  } catch { return null; }
}

export function parseNotice(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const { headerText, body } = splitMessage(text);
  const headers = parseFields(headerText);
  const type = contentTypeOf(headers);
  if (!type) throw new Error('mail_content_type');
  const doubts = [];
  let statusBody = null;
  let originalMessageId = null;
  if (type.type === 'message/delivery-status') {
    statusBody = body;
  } else if (type.type === 'multipart/report') {
    const boundary = type.parameters.boundary;
    if (!boundary) throw new Error('multipart_boundary_missing');
    for (const part of splitParts(body, boundary)) {
      let message;
      try { message = splitMessage(part); } catch { continue; }
      const partType = contentTypeOf(parseFields(message.headerText))?.type ?? 'text/plain';
      if (partType === 'message/delivery-status') {
        if (statusBody === null) statusBody = message.body;
      } else if ((partType === 'message/rfc822' || partType === 'text/rfc822-headers') && originalMessageId === null) {
        originalMessageId = embeddedMessageId(message.body);
        if (originalMessageId === null) doubts.push('original-headers-unreadable');
      }
    }
    if (statusBody === null) throw new Error('dsn_part_missing');
  } else {
    throw new Error('not_delivery_status');
  }
  const [reportFields, ...recipientBlocks] = parseBlocks(statusBody);
  if (!reportFields) throw new Error('dsn_report_missing');
  if (recipientBlocks.length === 0) throw new Error('dsn_recipient_missing');
  return {
    kind: 'delivery-status',
    messageId: fieldValue(headers, 'message-id'),
    report: {
      reportingMta: fieldValue(reportFields, 'reporting-mta'),
      originalEnvelopeId: fieldValue(reportFields, 'original-envelope-id'),
      arrivalDate: fieldValue(reportFields, 'arrival-date'),
      fields: reportFields,
    },
    clues: {
      originalEnvelopeId: fieldValue(reportFields, 'original-envelope-id'),
      originalMessageId,
    },
    recipients: recipientBlocks.map(recipientResult),
    doubts,
  };
}

export function correlate(notice, attempts) {
  const clues = [];
  const envelopeId = notice.clues?.originalEnvelopeId;
  const messageId = notice.clues?.originalMessageId;
  if (envelopeId) clues.push({ kind: 'envelope-id', matches: attempts.filter(attempt => attempt?.id === envelopeId) });
  if (messageId) clues.push({ kind: 'message-id', matches: attempts.filter(attempt => attempt?.messageId === messageId) });
  const originals = [...new Set((notice.recipients ?? []).map(recipient => recipient.originalRecipient?.address).filter(Boolean))];
  if (originals.length > 0) {
    clues.push({ kind: 'original-recipient', matches: attempts.filter(attempt =>
      Array.isArray(attempt?.recipients) && originals.some(address => attempt.recipients.includes(address))) });
  }
  if (clues.length === 0) return { state: 'unmatched', reason: 'no-clues', attemptId: null, doubts: [] };
  const doubts = [];
  const usable = clues.filter(clue => clue.matches.length > 0);
  if (usable.length < clues.length) doubts.push('clue-without-attempt');
  if (usable.length === 0) return { state: 'unmatched', reason: 'no-matching-attempt', attemptId: null, doubts };
  let candidates = usable[0].matches;
  for (const clue of usable.slice(1)) candidates = candidates.filter(attempt => clue.matches.includes(attempt));
  if (candidates.length === 0) return { state: 'ambiguous', reason: 'conflicting-clues', attemptId: null, doubts };
  if (candidates.length > 1) return { state: 'ambiguous', reason: 'multiple-candidates', attemptId: null, doubts };
  return { state: 'matched', reason: null, attemptId: candidates[0].id ?? null, doubts };
}

export function assess(notice, attempts) {
  const available = Array.isArray(attempts);
  const correlation = available
    ? correlate(notice, attempts)
    : { state: 'unmatched', reason: 'attempts-unavailable', attemptId: null, doubts: ['attempts-unavailable'] };
  const attempt = available && correlation.attemptId !== null
    ? attempts.find(item => item?.id === correlation.attemptId) ?? null
    : null;
  const recipients = notice.recipients.map(recipient => {
    const doubts = [];
    if (recipient.originalRecipient &&
        recipient.originalRecipient.address.toLowerCase() !== recipient.finalRecipient.address.toLowerCase()) {
      doubts.push('recipient-changed');
    }
    if (attempt && Array.isArray(attempt.recipients)) {
      const known = [recipient.originalRecipient?.address, recipient.finalRecipient.address].filter(Boolean);
      if (!known.some(address => attempt.recipients.includes(address))) doubts.push('recipient-not-in-attempt');
    }
    return { ...recipient, doubts };
  });
  const groups = new Map();
  for (const recipient of recipients) {
    const key = recipient.finalRecipient.address.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(recipient);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > 1 && new Set(group.map(recipient => recipient.action.trim().toLowerCase())).size > 1) {
      for (const recipient of group) recipient.doubts.push('conflicting-actions');
    }
  }
  return { correlation, recipients };
}

export function buildLedger(notices) {
  const entries = new Map();
  for (const notice of notices) {
    const attemptId = notice.correlation?.attemptId ?? null;
    for (const recipient of notice.recipients ?? []) {
      const address = recipient.finalRecipient.address;
      const key = `${attemptId ?? ''}\n${address.toLowerCase()}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { attemptId, recipient: address, outcome: null, confirmed: null, observations: [], doubts: [] };
        entries.set(key, entry);
      }
      entry.observations.push({
        noticeId: notice.id ?? null,
        action: recipient.action,
        status: recipient.status,
        diagnosticCode: recipient.diagnosticCode,
        originalRecipient: recipient.originalRecipient?.address ?? null,
      });
      const doubts = [...(recipient.doubts ?? []), ...(notice.correlation?.doubts ?? [])];
      if (notice.correlation && notice.correlation.state !== 'matched') doubts.push(notice.correlation.state);
      for (const doubt of doubts) if (!entry.doubts.includes(doubt)) entry.doubts.push(doubt);
      const action = recipient.action.trim().toLowerCase();
      const rank = ACTION_RANK.get(action) ?? 0;
      const current = entry.outcome === null ? -1 : ACTION_RANK.get(entry.outcome.action.trim().toLowerCase()) ?? 0;
      if (entry.outcome === null || rank > current) {
        entry.outcome = { action: recipient.action, status: recipient.status, noticeId: notice.id ?? null };
      } else if (rank === current && entry.outcome.action.trim().toLowerCase() !== action &&
          !entry.doubts.includes('conflicting-actions')) {
        entry.doubts.push('conflicting-actions');
      }
      if (TERMINAL_ACTIONS.has(action)) {
        if (entry.confirmed === null) {
          entry.confirmed = { action: recipient.action, status: recipient.status,
            diagnosticCode: recipient.diagnosticCode, noticeId: notice.id ?? null };
        } else if (entry.confirmed.action.trim().toLowerCase() !== action && !entry.doubts.includes('conflicting-actions')) {
          entry.doubts.push('conflicting-actions');
        }
      }
    }
  }
  return [...entries.values()];
}
