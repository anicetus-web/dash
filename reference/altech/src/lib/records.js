export function valueOf(record, keys, fallback = undefined) {
  for (const key of keys) {
    if (record && record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return record[key];
    }
  }
  return fallback;
}

export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const clean = value.split('|')[0].replace(/\s/g, '').replace(',', '.');
    const parsed = Number(clean);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function dateOrNull(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}
