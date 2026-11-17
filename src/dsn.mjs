// RFC 3464 子集解析：multipart/report 中的 message/delivery-status part，
// 或独立的 message/delivery-status。text/plain 与 message/rfc822 正文里的
// 同名字段不属于 DSN，绝不作为状态字段采集。

export const DSN_ACTIONS = new Set(['failed', 'delayed', 'delivered', 'relayed', 'expanded']);
const TERMINAL_ACTIONS = new Set(['failed', 'delivered', 'relayed', 'expanded']);
const BLANK_LINE = /\r?\n\r?\n/;
const STATUS_CODE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function strictHeaderPairs(text) {
  const headers = [];
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 1) throw new Error('dsn_header_line');
    headers.push([line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]);
  }
  return headers;
}

// DSN 字段块允许出现畸形行：保留疑点而不是整封拒收。
function fieldPairs(text) {
  const fields = [];
  const doubts = [];
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 1) { doubts.push('malformed_field_line'); continue; }
    fields.push([line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]);
  }
  return { fields, doubts };
}

const first = (fields, name) => fields.find(([key]) => key === name)?.[1] ?? null;
const all = (fields, name) => fields.filter(([key]) => key === name).map(([, value]) => value);

export function parseContentType(value) {
  if (!value) return { type: null, params: {} };
  const params = {};
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') { quoted = !quoted; current += char; }
    else if (char === ';' && !quoted) { tokens.push(current); current = ''; }
    else current += char;
  }
  tokens.push(current);
  const type = tokens.shift().trim().toLowerCase();
  for (const token of tokens) {
    const at = token.indexOf('=');
    if (at < 0) continue;
    const name = token.slice(0, at).trim().toLowerCase();
    const raw = token.slice(at + 1).trim();
    params[name] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return { type, params };
}

function splitMultipart(bodyText, boundary) {
  const marker = `--${boundary}`;
  const lines = bodyText.split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (current !== null) parts.push(current.join('\n'));
      current = [];
      if (line === `${marker}--`) break;
      continue;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

function splitHeadBody(text) {
  const separator = BLANK_LINE.exec(text);
  if (!separator) throw new Error('mail_header_separator');
  return { head: text.slice(0, separator.index),
    body: text.slice(separator.index + separator[0].length) };
}

function parseAddressField(raw) {
  if (raw === null) return null;
  const at = raw.indexOf(';');
  if (at < 0) return { type: null, address: raw.trim(), raw };
  return { type: raw.slice(0, at).trim().toLowerCase(),
    address: raw.slice(at + 1).trim(), raw };
}

function parseRecipientBlock(index, blockText) {
  const { fields, doubts } = fieldPairs(blockText);
  const action = first(fields, 'action');
  const status = first(fields, 'status');
  const actionValues = all(fields, 'action');
  const statusValues = all(fields, 'status');
  if (actionValues.length > 1 && new Set(actionValues).size > 1) doubts.push('contradictory_fields');
  if (statusValues.length > 1 && new Set(statusValues).size > 1) doubts.push('contradictory_fields');
  if (action === null) doubts.push('missing_action');
  else if (!DSN_ACTIONS.has(action.toLowerCase())) doubts.push('unknown_action');
  if (status === null) doubts.push('missing_status');
  else if (!STATUS_CODE.test(status)) doubts.push('malformed_status');
  const originalRecipient = parseAddressField(first(fields, 'original-recipient'));
  const finalRecipient = parseAddressField(first(fields, 'final-recipient'));
  if (!finalRecipient) doubts.push('missing_final_recipient');
  if (originalRecipient && finalRecipient &&
      originalRecipient.address.toLowerCase() !== finalRecipient.address.toLowerCase()) {
    doubts.push('recipient_rewritten');
  }
  return {
    index,
    originalRecipient,
    finalRecipient,
    action,
    actionVerified: action !== null && DSN_ACTIONS.has(action.toLowerCase()),
    terminal: action !== null && TERMINAL_ACTIONS.has(action.toLowerCase()),
    status,
    diagnosticCode: first(fields, 'diagnostic-code'),
    fields,
    doubts,
  };
}

function parseStatusContent(text) {
  const blockTexts = text.split(BLANK_LINE).map(block => block.trim()).filter(Boolean);
  const doubts = [];
  if (!blockTexts.length) throw new Error('dsn_empty_status');
  const reportText = blockTexts.shift();
  const reportFields = fieldPairs(reportText).fields;
  const recipients = blockTexts.map((block, index) => parseRecipientBlock(index, block));
  if (!recipients.length) doubts.push('no_recipient_blocks');
  return {
    reportingMta: first(reportFields, 'reporting-mta'),
    originalEnvelopeId: first(reportFields, 'original-envelope-id'),
    fields: reportFields,
    recipients,
    doubts,
  };
}

// 只读取 message/rfc822 part 的信头；原信正文里的 Action/Status 等同名行永不采集。
function parseOriginalMessage(partText) {
  try {
    const { head } = splitHeadBody(partText);
    const headers = strictHeaderPairs(head);
    return { present: true, messageId: first(headers, 'message-id') };
  } catch {
    return { present: true, messageId: null, unparsable: true };
  }
}

export function parseDsn(bytes) {
  const text = bytes.toString('utf8');
  const { head, body } = splitHeadBody(text);
  const headers = strictHeaderPairs(head);
  const contentTypeValue = first(headers, 'content-type');
  if (!contentTypeValue) throw new Error('mail_content_type');
  const contentType = parseContentType(contentTypeValue);
  const noticeDoubts = [];
  const statusTexts = [];
  let originalMessage = { present: false, messageId: null };

  if (contentType.type === 'message/delivery-status') {
    statusTexts.push(body);
  } else if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (!boundary) throw new Error('dsn_boundary_missing');
    for (const partText of splitMultipart(body, boundary)) {
      const separator = BLANK_LINE.exec(partText);
      if (!separator) { noticeDoubts.push('malformed_mime_part'); continue; }
      const partHeaders = strictHeaderPairs(partText.slice(0, separator.index));
      const partBody = partText.slice(separator.index + separator[0].length);
      const partType = parseContentType(first(partHeaders, 'content-type')).type;
      if (partType === 'message/delivery-status') statusTexts.push(partBody);
      else if (partType === 'message/rfc822') originalMessage = parseOriginalMessage(partBody);
      // text/plain 等其余 part 明确忽略
    }
  } else {
    throw new Error('not_delivery_status');
  }

  if (!statusTexts.length) throw new Error('not_delivery_status');
  if (statusTexts.length > 1) noticeDoubts.push('multiple_status_parts');
  const status = parseStatusContent(statusTexts[0]);
  if (originalMessage.present && originalMessage.unparsable) noticeDoubts.push('original_message_unparsable');

  return {
    format: contentType.type === 'message/delivery-status' ? 'delivery-status' : 'multipart-report',
    report: {
      reportingMta: status.reportingMta,
      originalEnvelopeId: status.originalEnvelopeId,
      fields: status.fields,
    },
    originalMessage,
    recipients: status.recipients,
    doubts: [...noticeDoubts, ...status.doubts],
  };
}
