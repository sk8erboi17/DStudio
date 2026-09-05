// Deterministic PDF inputs for reader tests, not user-facing authored files.
// Each line is placed explicitly; Poppler supplies the independent extraction.
export function pdfFixture(pages) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids = [];
  for (const page of pages) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page.rotate ? '/Rotate 90' : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    let stream = page.lines.map((line, i) => `BT /F1 9 Tf 30 ${760 - i * 12} Td (${line.replace(/([\\()])/g, '\\$1')}) Tj ET`).join('\n');
    if (page.image) stream += '\nq 40 0 0 40 520 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000> EI Q';
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const compactPages = [
  { lines: ['Chapter 1 Expedition handover', 'Equipment log: field station ALPHA-27.'] },
  { lines: [
    'Section 2 Verified observations',
    ...Array.from({length: 48}, (_, i) => `Sample ${String(i + 1).padStart(2, '0')}: pressure 1013.25 hPa; temperature -12.50 C; status recorded.`),
    'Final calibration code: ZEBRA-7319.',
    'Remaining battery capacity: 37.25 percent.',
    'Caf\u00e9 supply: 1.234,50 EUR. Reference: Table 4.',
  ] },
];
