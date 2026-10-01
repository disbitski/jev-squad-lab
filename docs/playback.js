export function frameAt(frames, time) {
  let low = 0, high = frames.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (frames[middle].time <= time) low = middle; else high = middle - 1; }
  return low;
}
export function decisionAt(decisions, frame) {
  return decisions.findLast(d => d.tick <= frame.tick && d.at <= frame.time);
}
export function derivativePayload(record) {
  const { checksum, sourceChecksum, exportFormat, ...payload } = record;
  return payload;
}
export async function verifyRecord(record, expected) {
  const bytes = new TextEncoder().encode(JSON.stringify(derivativePayload(record)));
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== record.checksum || digest !== expected.checksum || record.sourceChecksum !== expected.sourceChecksum || record.meta.id !== expected.id) throw new Error('Recording failed integrity check');
  if (!record.frames.length || !record.frames.at(-1).done) throw new Error('Recording is incomplete');
  return record;
}
