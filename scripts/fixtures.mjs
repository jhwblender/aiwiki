// Small sample files for the end-to-end check, built in memory so the repo needs no binaries.

import zlib from 'node:zlib';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';

// Assemble a PDF from object bodies, working out the cross-reference offsets.
function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let pos = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const tail = Buffer.from('\nendobj\n');
    const part = Buffer.concat([head, Buffer.isBuffer(body) ? body : Buffer.from(body), tail]);
    chunks.push(part);
    pos += part.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

function stream(dict, data) {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

// A one-page PDF with real text on it
export function textPdf(lines) {
  const ops = ['BT', '/F1 12 Tf', '50 760 Td', '16 TL', ...lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`), 'ET'].join('\n');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream('', Buffer.from(ops)),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

// A PDF whose pages are only pictures, like a scan with no text layer
export function scannedPdf(pageCount = 2) {
  const w = 60;
  const h = 80;
  const pixels = Buffer.alloc(w * h * 3, 0xee);
  const image = stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(pixels));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  // object 3 is the shared image; each page adds a page object and a content stream
  objects.push(image);
  for (let i = 0; i < pageCount; i++) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(stream('', Buffer.from('q 612 0 0 792 0 0 cm /Im1 Do Q')));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  return buildPdf(objects);
}

// A minimal Word document with the given paragraphs
export async function docx(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// A small photo-like PNG
export function photo() {
  const canvas = createCanvas(200, 120);
  const g = canvas.getContext('2d');
  g.fillStyle = '#334455';
  g.fillRect(0, 0, 200, 120);
  g.fillStyle = '#ffffff';
  g.font = 'bold 28px sans-serif';
  g.fillText('RACK-7', 40, 70);
  return canvas.toBuffer('image/png');
}
