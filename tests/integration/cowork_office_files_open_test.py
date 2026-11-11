"""Generated Cowork documents open in office readers without repair.

The production Office helper (src/harness/cowork/office_tool.py) is run the
way the native Cowork bridge runs it (--request-json/--workspace) to create a
DOCX, a PPTX, an XLSX (then edited and appended in place) and a PDF. Each
file is then opened by readers that share no code with the helper:

- macOS Quick Look (qlmanage), whose Office and PDF generators render the
  file headlessly. Quick Look is lenient (it renders a DOCX or XLSX whose XML
  is cut in half and can hang on such a PPTX), so it shows only that the
  content renders, not that no repair is needed.
- macOS textutil, the Cocoa Word importer TextEdit uses, for the DOCX text.
- poppler pdfinfo/pdftotext: no syntax error or warning (a broken
  cross-reference table is reported and reconstructed, i.e. repaired), the
  page count and the text.
- a strict OOXML package check written here: ZIP integrity, content types,
  relationships and the structures Office repairs when they are wrong (sheet
  names, row and cell order, style and shared-string indexes, slide ids, the
  slide/layout/master/theme chain). A negative control shows that it and
  textutil reject damaged copies of the generated files.

Microsoft Excel is installed on the maintainer's Mac but is a GUI application:
it cannot open a file headlessly, a repair prompt is a modal dialog, and
driving it would take over the desktop during unrelated GPU work. Word and
PowerPoint are not installed. This is therefore weaker evidence than opening
the files in Word, Excel and PowerPoint; that check is NOT RUN here.
No model is involved: the document contents are authored by this test.

  python3 tests/integration/cowork_office_files_open_test.py
"""
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import xml.parsers.expat
import zipfile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'src/harness/cowork/office_tool.py'
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
PML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
MAIN_TYPES = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
}


def helper(workspace, tool, **args):
    """One tool call through the helper's command line, as the bridge makes it."""
    request = Path(workspace).parent / f'request-{tool}.json'
    request.write_text(json.dumps({'protocol': 'ds4.cowork.tool.v1', 'tool': tool,
                                   'args': {k: str(v) for k, v in args.items()}}), encoding='utf-8')
    done = subprocess.run([sys.executable, str(HELPER), '--request-json', str(request), '--workspace', str(workspace)],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, (tool, done.stdout[-600:], done.stderr[-600:])
    return done.stdout


def part_rels_name(part):
    path = PurePosixPath(part)
    return str(path.parent / '_rels' / (path.name + '.rels')).lstrip('./')


def resolve(source, target):
    base = PurePosixPath(source).parent
    parts = []
    for piece in (PurePosixPath('/' + target) if target.startswith('/') else base / target).parts:
        if piece in ('', '/', '.'):
            continue
        if piece == '..':
            assert parts, f'{target} escapes the package from {source}'
            parts.pop()
        else:
            parts.append(piece)
    return '/'.join(parts)


def column_number(ref):
    letters = re.match(r'^([A-Z]+)(\d+)$', ref)
    assert letters, f'invalid cell reference {ref}'
    number = 0
    for c in letters.group(1):
        number = number * 26 + ord(c) - 64
    return number, int(letters.group(2))


def check_ooxml(path):
    """The package-level rules whose violation makes Office offer a repair."""
    facts = {}
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert archive.testzip() is None, 'a ZIP member fails its CRC'
        assert len(names) == len(set(names)), 'duplicate ZIP members'
        assert all(not n.startswith('/') and '..' not in PurePosixPath(n).parts and '\\' not in n for n in names)
        xml_parts = {}
        for name in names:
            if name.endswith('/'):
                continue
            data = archive.read(name)
            if name.endswith(('.xml', '.rels')):
                parser = xml.parsers.expat.ParserCreate()
                parser.Parse(data, True)  # raises on malformed XML
                xml_parts[name] = ET.fromstring(data)
        types = xml_parts.get('[Content_Types].xml')
        assert types is not None, 'missing [Content_Types].xml'
        defaults = {d.get('Extension').lower(): d.get('ContentType') for d in types.findall(f'{{{CT_NS}}}Default')}
        overrides = {o.get('PartName').lstrip('/'): o.get('ContentType') for o in types.findall(f'{{{CT_NS}}}Override')}
        for part in overrides:
            assert part in names, f'content type override for a missing part {part}'
        for name in names:
            if name.endswith('/') or name == '[Content_Types].xml':
                continue
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name.rsplit('/', 1)[-1] else ''
            assert name in overrides or ext in defaults, f'part without a content type: {name}'
        rels = {}
        for name, root in xml_parts.items():
            if not name.endswith('.rels'):
                continue
            source = '' if name == '_rels/.rels' else str(PurePosixPath(name).parent.parent / PurePosixPath(name).name[:-5])
            ids = set()
            for rel in root.findall(f'{{{REL_NS}}}Relationship'):
                rid = rel.get('Id')
                assert rid and rid not in ids, f'duplicate or missing relationship id in {name}'
                ids.add(rid)
                if rel.get('TargetMode') != 'External':
                    target = resolve(source or '_', rel.get('Target')) if source else rel.get('Target').lstrip('/')
                    assert target in names, f'{name}: {rid} targets missing part {target}'
            rels[source] = {rel.get('Id'): rel for rel in root.findall(f'{{{REL_NS}}}Relationship')}
        main = [r for r in rels.get('', {}).values() if r.get('Type') == f'{OFFICE_REL}/officeDocument']
        assert len(main) == 1, 'the package names one main document'
        main_part = main[0].get('Target').lstrip('/')
        suffix = path.suffix.lower()
        assert overrides.get(main_part) == MAIN_TYPES[suffix], f'main part type {overrides.get(main_part)}'
        # Every relationship id used inside a part exists in that part's relationships.
        for name, root in xml_parts.items():
            if name.endswith('.rels') or name == '[Content_Types].xml':
                continue
            own = rels.get(name, {})
            for element in root.iter():
                for key, value in element.attrib.items():
                    if key.startswith(f'{{{OFFICE_REL}}}'):
                        assert value in own, f'{name}: {key} {value} has no relationship'
        target_of = lambda source, rid: resolve(source, rels[source][rid].get('Target'))
        if suffix == '.xlsx':
            workbook = xml_parts[main_part]
            sheets = workbook.findall(f'{{{SML}}}sheets/{{{SML}}}sheet')
            assert sheets, 'a workbook needs at least one sheet'
            titles = [s.get('name') for s in sheets]
            assert len({t.lower() for t in titles}) == len(titles), 'duplicate sheet names'
            assert all(0 < len(t) <= 31 and not re.search(r'[\[\]:*?/\\]', t) for t in titles), titles
            assert len({s.get('sheetId') for s in sheets}) == len(sheets)
            styles = next((xml_parts[target_of(main_part, rid)] for rid, rel in rels[main_part].items()
                           if rel.get('Type').endswith('/styles')), None)
            xfs = len(styles.findall(f'{{{SML}}}cellXfs/{{{SML}}}xf')) if styles is not None else 1
            shared = next((xml_parts[target_of(main_part, rid)] for rid, rel in rels[main_part].items()
                           if rel.get('Type').endswith('/sharedStrings')), None)
            strings = len(shared.findall(f'{{{SML}}}si')) if shared is not None else 0
            cells = 0
            for sheet in sheets:
                part = target_of(main_part, sheet.get(f'{{{OFFICE_REL}}}id'))
                previous_row = 0
                for row in xml_parts[part].findall(f'{{{SML}}}sheetData/{{{SML}}}row'):
                    number = int(row.get('r'))
                    assert number > previous_row, f'{part}: rows out of order at {number}'
                    previous_row, previous_col = number, 0
                    for cell in row.findall(f'{{{SML}}}c'):
                        col, cell_row = column_number(cell.get('r'))
                        assert cell_row == number and col > previous_col, f'{part}: cell {cell.get("r")} out of order'
                        previous_col = col
                        cells += 1
                        assert int(cell.get('s', '0')) < xfs, f'{part}: style index {cell.get("s")} of {xfs}'
                        if cell.get('t') == 's':
                            assert int(cell.find(f'{{{SML}}}v').text) < strings, f'{part}: shared string out of range'
            facts.update(sheets=titles, cells=cells)
        elif suffix == '.pptx':
            presentation = xml_parts[main_part]
            masters = presentation.findall(f'{{{PML}}}sldMasterIdLst/{{{PML}}}sldMasterId')
            slides = presentation.findall(f'{{{PML}}}sldIdLst/{{{PML}}}sldId')
            assert masters and slides, 'a presentation needs a master and slides'
            ids = [int(s.get('id')) for s in slides]
            assert len(set(ids)) == len(ids) and all(256 <= i < 2147483648 for i in ids), ids
            for master in masters:
                part = target_of(main_part, master.get(f'{{{OFFICE_REL}}}id'))
                assert any(r.get('Type').endswith('/theme') for r in rels[part].values()), f'{part} has no theme'
            for slide in slides:
                part = target_of(main_part, slide.get(f'{{{OFFICE_REL}}}id'))
                layouts = [target_of(part, rid) for rid, r in rels[part].items() if r.get('Type').endswith('/slideLayout')]
                assert len(layouts) == 1, f'{part} needs one layout'
                assert any(r.get('Type').endswith('/slideMaster') for r in rels[layouts[0]].values())
            facts.update(slides=len(slides))
        else:
            body = xml_parts[main_part].find(f'{{{WML}}}body')
            assert body is not None, 'document.xml has no body'
            facts.update(paragraphs=len(body.findall(f'{{{WML}}}p')))
    return facts


def quick_look(path, out):
    """Quick Look's own generators render the file; returns the thumbnail."""
    out.mkdir(exist_ok=True)
    subprocess.run(['qlmanage', '-t', '-s', '512', '-o', str(out), str(path)], capture_output=True, timeout=90)
    thumb = out / (path.name + '.png')
    return thumb if thumb.is_file() and thumb.stat().st_size > 0 else None


def main():
    if sys.platform != 'darwin':
        print('cowork_office_files_open_test: NOT RUN (needs macOS Quick Look and textutil)')
        return 2
    artifacts = ROOT / 'tests/.artifacts/cowork-office-open'
    artifacts.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    workspace = run / 'workspace with spaces'
    workspace.mkdir()
    rows, failures = [], 0

    def case(name, function):
        nonlocal failures
        row = {'name': name}
        try:
            row.update(function() or {})
            row['status'] = 'PASS'
        except Exception as error:  # noqa: BLE001 - every failure is retained
            row.update(status='FAIL', error=f'{type(error).__name__}: {error}')
            failures += 1
        rows.append(row)
        print(f"{row['status']} {name}" + (f"\n  {row['error']}" if 'error' in row else ''), flush=True)

    helper(workspace, 'write_document', path='Quarterly brief.docx', title='Quarterly brief', content=(
        '# Quarterly brief\n\n## Decisions\n- Ship the local path\n- Verify qualità e accessibilità\n\n'
        '1. First step\n2. Second step\n\nOwner: Zoë Ångström — 東京 office.'))
    helper(workspace, 'presentation', path='Review deck.pptx', title='Q4 review', slides_json=json.dumps([
        {'title': 'Q4 plan', 'bullets': ['One source of truth', 'Local review ✓']},
        {'title': 'Quality gate', 'body': 'No regression\nMeasure before ship'},
        {'title': 'Città & costi', 'bullets': ['Ricavi < costi?', '"Quoted" <tag> & ampersand']},
    ], ensure_ascii=False))
    helper(workspace, 'spreadsheet', action='create', path='Budget 2027.xlsx', sheets_json=json.dumps([
        {'name': 'Budget 2027', 'rows': [['Item', 'Amount', 'Forecast', 'Approved'], ['Ricavi', 1200.5, '=B2*1.1', True],
                                         ['Costi', 500, '=B3*1.05', False]]},
        {'name': 'Note & stato', 'rows': [['Owner', 'Zoë'], ['Stato', 'Pronto ✓'], ['Literal', '  spaced  ']]},
    ], ensure_ascii=False))
    helper(workspace, 'spreadsheet', action='write', path='Budget 2027.xlsx', sheet='Budget 2027', range='B3',
           data_json=json.dumps([[650, '=B3*1.03']]))
    helper(workspace, 'spreadsheet', action='append', path='Budget 2027.xlsx', sheet='Budget 2027',
           data_json=json.dumps([['Margine', '=B2-B3', '=C2-C3', None]]))
    helper(workspace, 'write_pdf', path='Payroll recap.pdf', title='Payroll recap', content=(
        '# Recap\n\n## Totals\n- Ordinary hours: 164\n- Vacation: 8\n\n' +
        '\n'.join(f'{i}. Verified payroll line {i}' for i in range(1, 125))))
    docx, pptx, xlsx, pdf = (workspace / n for n in ('Quarterly brief.docx', 'Review deck.pptx', 'Budget 2027.xlsx', 'Payroll recap.pdf'))
    thumbs = run / 'quick-look'

    # Negative control: damaged copies of the generated files (the main XML
    # part cut in half; the package itself cut in half) must be rejected.
    damaged = run / 'damaged'
    damaged.mkdir()
    main_parts = {docx: 'word/document.xml', pptx: 'ppt/slides/slide1.xml', xlsx: 'xl/worksheets/sheet1.xml'}
    for source, part in main_parts.items():
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(damaged / ('xml ' + source.name), 'w', zipfile.ZIP_DEFLATED) as copy:
            for info in original.infolist():
                data = original.read(info.filename)
                copy.writestr(info, data[:len(data) // 2] if info.filename == part else data)
        data = source.read_bytes()
        (damaged / ('zip ' + source.name)).write_bytes(data[:len(data) // 2])

    def readers_reject_damaged_copies():
        rejected = {}
        for copy in sorted(damaged.iterdir()):
            try:
                check_ooxml(copy)
            except Exception as error:  # noqa: BLE001 - the expected outcome
                rejected[copy.name] = f'{type(error).__name__}: {error}'[:160]
            else:
                raise AssertionError(f'the package check accepted {copy.name}')
        for copy in (damaged / ('xml ' + docx.name), damaged / ('zip ' + docx.name)):
            done = subprocess.run(['textutil', '-convert', 'txt', '-stdout', str(copy)], capture_output=True, text=True, timeout=60)
            # textutil exits 0 even when it cannot read a file; it says so instead.
            assert 'Error reading' in done.stdout + done.stderr, (copy.name, done.stdout[:200], done.stderr[:200])
            rejected[copy.name + ' (textutil)'] = done.stderr.strip()[:160]
        return {'rejected': rejected}

    def docx_opens():
        facts = check_ooxml(docx)
        done = subprocess.run(['textutil', '-convert', 'txt', '-stdout', str(docx)], capture_output=True, text=True, timeout=60)
        assert done.returncode == 0 and not done.stderr.strip(), done.stderr
        text = done.stdout
        for expected in ('Quarterly brief', 'Decisions', 'Ship the local path', 'qualità e accessibilità',
                         'Second step', 'Zoë Ångström — 東京 office.'):
            assert expected in text, f'{expected!r} not read back: {text[:400]!r}'
        assert text.index('Decisions') < text.index('Ship the local path') < text.index('Second step')
        assert quick_look(docx, thumbs), 'Quick Look did not render the DOCX'
        return {**facts, 'textutilChars': len(text)}

    def pptx_opens():
        facts = check_ooxml(pptx)
        assert facts['slides'] == 3
        assert quick_look(pptx, thumbs), 'Quick Look did not render the PPTX'
        return facts

    def xlsx_opens():
        facts = check_ooxml(xlsx)
        assert facts['sheets'] == ['Budget 2027', 'Note & stato']
        assert quick_look(xlsx, thumbs), 'Quick Look did not render the edited XLSX'
        with zipfile.ZipFile(xlsx) as archive:
            sheet = archive.read('xl/worksheets/sheet1.xml').decode()
        assert '<f>B3*1.03</f>' in sheet and '<f>B2-B3</f>' in sheet, 'the edit and the appended row are in the file'
        return facts

    def pdf_opens():
        info = subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True, timeout=60)
        assert info.returncode == 0, info.stderr
        assert not info.stderr.strip(), f'poppler reported a problem: {info.stderr.strip()[:300]}'
        pages = int(re.search(r'^Pages:\s+(\d+)', info.stdout, re.M).group(1))
        assert pages >= 2, info.stdout
        text = subprocess.run(['pdftotext', '-layout', str(pdf), '-'], capture_output=True, text=True, timeout=60)
        assert text.returncode == 0 and not text.stderr.strip(), text.stderr
        assert 'Ordinary hours: 164' in text.stdout and 'Verified payroll line 124' in text.stdout
        assert quick_look(pdf, thumbs), 'Quick Look did not render the PDF'
        return {'pages': pages}

    case('negative control: the package check and textutil reject damaged copies', readers_reject_damaged_copies)
    case('the generated DOCX passes the package check and opens in textutil and Quick Look', docx_opens)
    case('the generated PPTX passes the package check and opens in Quick Look', pptx_opens)
    case('the edited and appended XLSX passes the package check and opens in Quick Look', xlsx_opens)
    case('the generated PDF opens in poppler without a syntax warning or repair, and in Quick Look', pdf_opens)
    (run / 'results.json').write_text(json.dumps({
        'scope': 'production Office helper via its command line; Quick Look, textutil, poppler and a strict OOXML '
                 'package check as independent readers; Word/Excel/PowerPoint NOT RUN (GUI only); no model',
        'cases': rows}, indent=1, ensure_ascii=False))
    print(f'cowork_office_files_open_test: {len(rows) - failures}/{len(rows)} passed; receipts: {run}')
    return 1 if failures or not rows else 0


if __name__ == '__main__':
    sys.exit(main())
