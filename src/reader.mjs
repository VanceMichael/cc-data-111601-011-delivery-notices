export function headerBlocks(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const headers = [];
    for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at < 1) throw new Error('mail_header_line');
      headers.push([line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]);
    }
    return headers;
  });
}
export function inspect(bytes) {
  const text = bytes.toString('utf8');
  const split = /\r?\n\r?\n/.exec(text);
  if (!split) throw new Error('mail_header_separator');
  const envelope = headerBlocks(text.slice(0, split.index))[0];
  if (!envelope.some(([key]) => key === 'content-type')) throw new Error('mail_content_type');
  return { kind: 'mail-envelope', headers: envelope, bodyOffset: Buffer.byteLength(text.slice(0, split.index + split[0].length)),
    bodyBytes: bytes.length - Buffer.byteLength(text.slice(0, split.index + split[0].length)) };
}
