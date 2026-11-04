// Excel in the browser (ExcelJS is passed in), so large files never go through the server's size limit.
//   readRows(ExcelJS, arrayBuffer)              -> { sheet, headerRow, columns, rows: [{ r, username, page_name, profile, post_url }] }
//   buildWorkbook(ExcelJS, templateBuf, outputs) -> ArrayBuffer of the filled template
import { COLUMNS, COLORS } from './assemble.mjs';

const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const WANT = { username: 'username', pagename: 'page_name', profile: 'profile', posturl: 'post_url' };

export function cellText(c) {
  const v = c.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('text' in v || 'hyperlink' in v) {
      const t = typeof v.text === 'object' ? (v.text?.richText || []).map((x) => x.text).join('') : String(v.text ?? '');
      return /^\s*(https?:\/\/|www\.)/i.test(t) || !v.hyperlink ? t : v.hyperlink;
    }
    if ('result' in v) return String(v.result ?? '');
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

// Rows keep their position: output row = row number counted from the header (header = row 1).
export async function readRows(ExcelJS, buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  for (const ws of wb.worksheets) {
    for (let h = 1; h <= Math.min(10, ws.rowCount); h++) {
      const map = {};
      ws.getRow(h).eachCell({ includeEmpty: false }, (c, col) => { const k = WANT[norm(cellText(c))]; if (k && !map[k]) map[k] = col; });
      if (!map.post_url && !map.profile) continue;
      const rows = [];
      let last = 0;
      for (let r = h + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const o = { r: r - h + 1 };
        for (const k of Object.values(WANT)) o[k] = map[k] ? cellText(row.getCell(map[k])).trim() : '';
        rows.push(o);
        if (o.username || o.page_name || o.profile || o.post_url) last = rows.length;
      }
      return { sheet: ws.name, headerRow: h, columns: Object.keys(map), rows: rows.slice(0, last) };
    }
  }
  throw new Error('No header row with Profile / Post_url found in the first 10 rows');
}

export async function buildWorkbook(ExcelJS, templateBuf, outputs) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuf);
  const ws = wb.worksheets[0];
  const head = COLUMNS.map((_, i) => ws.getRow(1).getCell(i + 1).value);
  if (JSON.stringify(head) !== JSON.stringify(COLUMNS)) throw new Error('Template header does not match the 15 columns');
  const bodyStyle = COLUMNS.map((_, i) => JSON.parse(JSON.stringify(ws.getRow(2).getCell(i + 1).style || {})));
  if (ws.rowCount > 1) ws.spliceRows(2, ws.rowCount - 1);
  for (const o of outputs) {
    const row = ws.getRow(o.r);
    COLUMNS.forEach((col, i) => {
      const c = row.getCell(i + 1);
      c.style = JSON.parse(JSON.stringify(bodyStyle[i]));
      const v = o.values[col];
      // Profile / Post_url are clickable links in the template, everything else plain text or a number
      c.value = v == null ? null : (col === 'Profile' || col === 'Post_url') && /^https?:\/\//i.test(v) ? { text: v, hyperlink: v } : v;
      const m = o.marks?.[col];
      if (m?.color && COLORS[m.color]) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + COLORS[m.color] } };
      if (m?.note) c.note = m.note;
    });
    row.commit();
  }
  return wb.xlsx.writeBuffer();
}
