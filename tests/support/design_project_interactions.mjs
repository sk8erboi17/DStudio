// Independent browser scenarios for the eighteen frozen generation briefs.
// Only user-observable controls, rendered content, geometry and focus are used.
// No generated source parsing, model self-ratings or project-specific CSS IDs.
import assert from 'node:assert/strict';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp('^' + escape(value) + '$', 'i');
const visible = locator => locator.filter({visible: true});
const text = (scope, value) => visible(scope.getByText(value, {exact: typeof value === 'string'}));
const button = (scope, value) => visible(scope.getByRole('button', {name: typeof value === 'string' ? exact(value) : value}));

async function one(locator, description) {
  assert.equal(await locator.count(), 1, `Expected one accessible ${description}`);
  return locator;
}
async function shown(scope, value) {
  assert.ok(await text(scope, value).count(), `Missing visible content: ${value}`);
}
async function absent(scope, value) {
  assert.equal(await text(scope, value).count(), 0, `Unexpected visible content: ${value}`);
}
async function click(scope, value) { await (await one(button(scope, value), `button ${value}`)).click(); }
const FORM_CONTROLS = 'input,select,textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"]';
async function field(scope, name) {
  // A label may mark the field as required ("Project name (required)", "Project name *").
  const pattern = typeof name === 'string' ? new RegExp('^' + escape(name) + '(?:\\s*(?:\\*|\\(required\\)))?$', 'i') : name;
  // A select nested in its label can have the correct accessible name while
  // getByLabel's label-text matching includes its option text. Use the actual
  // control name too; the union deduplicates one control, not distinct fields.
  // getByLabel also matches any element carrying a matching aria-label, such
  // as a row button named after the variant it removes: keep form controls only.
  let controls = scope.getByLabel(pattern).and(scope.locator(FORM_CONTROLS));
  for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio'])
    controls = controls.or(scope.getByRole(role, {name: pattern}));
  return one(visible(controls), `field ${name}`);
}
async function item(scope, title) {
  const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
  // `has` and `hasNot` are evaluated relative to each row. A text locator built
  // from a region or dialog scope carries that scope, so a row would have to
  // contain the region that contains it and no page could ever match
  // (qualification on November 11, 2026: the queue and basket oracles rejected
  // every implementation). Build the inner locators from the page or frame.
  const root = typeof scope.page === 'function' ? scope.page() : scope;
  const containing = visible(root.locator(rowSelector)).filter({has: text(root, title)});
  // Prefer the innermost semantic item, never a containing list with other rows.
  const leaves = visible(scope.locator(rowSelector)).filter({has: text(root, title)}).filter({hasNot: containing});
  return one(leaves, `item containing ${title}`);
}
async function region(scope, name) {
  return one(visible(scope.getByRole('region', {name})), `region ${name}`);
}
async function itemAction(scope, name, title) {
  const named = button(scope, new RegExp('^(?:' + escape(name) + ')\\b.*' + escape(title) + '|^' + escape(title) + '.*\\b' + escape(name) + '\\b', 'i'));
  if (await named.count() === 1) return named;
  return one(button(await item(scope, title), new RegExp('^' + escape(name) + '\\b', 'i')), `${name} on ${title}`);
}
async function action(scope, name, title) { await (await itemAction(scope, name, title)).click(); }
async function selectEntry(scope, title) {
  const control = visible(scope.getByRole('button', {name: new RegExp('^(?:Open |Select |Read |View )?' + escape(title) + '$', 'i')})
    .or(scope.getByRole('link', {name: exact(title)})).or(scope.getByRole('tab', {name: exact(title)})));
  if (await control.count() === 1) return control.click();
  const row = await item(scope, title);
  const inner = button(row, /^(open|select|read|view|details)\b/i);
  if (await inner.count() === 1) return inner.click();
  await (await one(text(row, title), title)).click();
}
async function choose(scope, label, group) {
  if (group) {
    const select = visible(scope.getByRole('combobox', {name: group}));
    if (await select.count() === 1) {
      const option = await one(select.locator('option').filter({hasText: new RegExp('^' + escape(label) + '(?:$|\\s|[(:])', 'i')}), `option ${label}`);
      return select.selectOption(await option.getAttribute('value') ?? await option.innerText());
    }
  }
  const radio = visible(scope.getByRole('radio', {name: new RegExp('^' + escape(label) + '(?:$|\\s|[(:])', 'i')}));
  if (await radio.count() === 1) return radio.check();
  const tab = visible(scope.getByRole('tab', {name: exact(label)}));
  if (await tab.count() === 1) return tab.click();
  if (typeof label !== 'string' || await button(scope, label).count() === 1) return click(scope, label);
  // A filter button may carry its count ("Resolved (1)"), as options and radios may.
  return (await one(button(scope, new RegExp('^' + escape(label) + '(?:$|\\s|[(:])', 'i')), `button ${label}`)).click();
}
async function search(scope, query) { await (await field(scope, /^Search\b/i)).fill(query); }
async function readText(scope) { return (await scope.locator('body').innerText()).replace(/\s+/g, ' ').trim(); }
async function assertText(scope, pattern) { assert.match(await readText(scope), pattern); }
async function withinText(scope, pattern) { assert.match((await scope.innerText()).replace(/\s+/g, ' '), pattern); }
async function dialog(scope, page, opener, verify, closeWithButton = false) {
  const control = await one(button(scope, opener), `dialog opener ${opener}`);
  await control.focus(); await page.keyboard.press('Enter');
  // A dialog usually lives outside the article containing its opener. Resolve
  // the opener's own document, also inside an opaque iframe; not the host page.
  const owner = control.locator('xpath=ancestor::body');
  const popup = await one(visible(owner.getByRole('dialog')), 'native dialog');
  assert.equal(await popup.evaluate(node => node.tagName), 'DIALOG', 'brief requires a native dialog');
  assert.equal(await popup.evaluate(node => node.contains(node.ownerDocument.activeElement)), true, 'dialog must own focus');
  await verify(popup);
  if (await popup.isVisible()) {
    if (closeWithButton) await click(popup, /^close\b/i);
    else await page.keyboard.press('Escape');
  }
  // Key dispatch completion is not dialog-close completion in every browser.
  // Await the observable state inside the existing 3 s action budget; a
  // cancelled Escape or permanently open dialog still fails that same bound.
  await popup.waitFor({state:'hidden',timeout:3000});
  assert.equal(await visible(owner.getByRole('dialog')).count(), 0, 'dialog did not close');
  assert.equal(await control.evaluate(node => node === node.ownerDocument.activeElement), true, 'dialog did not restore focus');
}
async function ordered(scope, names) {
  const positions = [];
  for (const name of names) {
    const node = await one(text(scope, name), `ordered entry ${name}`);
    const box = await node.boundingBox(); assert.ok(box, `No rendered entry ${name}`);
    positions.push({name, top: box.y, left: box.x});
  }
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1], b = positions[i];
    assert.ok(b.top > a.top + 1 || Math.abs(b.top - a.top) <= 1 && b.left > a.left, `Rendered order mismatch: ${names.join(' → ')}`);
  }
  return positions;
}
async function literal(scope, value) {
  await shown(scope, value);
  assert.equal(await scope.locator('img[src="x"],b').filter({hasText: 'literal'}).count(), 0, 'saved text became markup');
}
const noteText = '<b>literal & note</b>';

async function comparedProduct(popup, name) {
  // Comparison tables may put products in columns; semantic product articles
  // are equally valid. Do not require a specific DOM topology from the model.
  // A column header may also hold that product's Remove control, which then
  // follows the product name in the header's accessible name.
  let heading = visible(popup.getByRole('columnheader', {name: exact(name)}));
  if (await heading.count() !== 1) heading = visible(popup.getByRole('columnheader', {name: new RegExp('^' + escape(name) + '\\b', 'i')}));
  if (await heading.count() === 1) {
    const column = await heading.evaluate(el => [...el.parentElement.children].indexOf(el));
    const table = heading.locator('xpath=ancestor::table');
    return (await Promise.all((await table.getByRole('row').all()).map(async row => {
      const cells = row.locator('th,td'); return await cells.count() > column ? await cells.nth(column).innerText() : '';
    }))).join(' ');
  }
  return (await (await item(popup, name)).innerText()).replace(/\s+/g, ' ');
}

async function artboardObject(board, name) {
  return one(visible(board.getByRole('button', {name: new RegExp('^(?:Select )?' + escape(name) + '$', 'i')})), `artboard object ${name}`);
}
async function paintOrder(board) {
  // Shared-parent DOM order and computed z-index are the actual browser paint
  // inputs for these HTML/SVG objects. More complex stacking is unverified,
  // never inferred from the Layers list or accepted as a visual pass.
  return board.getByRole('button').evaluateAll(nodes => {
    if (nodes.length < 2 || nodes.some(n => n.parentElement !== nodes[0].parentElement)) throw Error('Cannot establish shared-parent artboard paint order');
    return nodes.map((node, index) => ({name: node.getAttribute('aria-label') || node.textContent.trim(),
      z: Number.parseInt(getComputedStyle(node).zIndex) || 0, index})).sort((a, b) => a.z - b.z || a.index - b.index).map(n => n.name);
  });
}

// Every exported scenario must finish all of its steps. The caller records an
// exception as FAIL and the remaining scenarios as NOT RUN, never as a pass.
export const designProjectScenarios = {
  async 'editorial-search-dialog'(s, p, step) {
    const titles = ['Footbridge 12', 'Canal crossing', 'Railway span'];
    await step('search, empty state and Clear restore exact entries', async () => {
      for (const title of titles) await shown(s, title);
      await search(s, 'Railway'); await shown(s, titles[2]);
      for (const title of titles.slice(0, 2)) await absent(s, title);
      await search(s, 'unmatched-bridge-9031'); await shown(s, 'No entries found');
      for (const title of titles) await absent(s, title);
      await click(s, 'Clear'); for (const title of titles) await shown(s, title);
    });
    await step('each field note is distinct; Close/Escape restore invoking focus', async () => {
      const bodies = [];
      for (const [index, title] of titles.entries()) {
        const row = await item(s, title);
        await dialog(row, p, /^Read field note\b/i, async popup => {
          await shown(popup, title);
          const body = (await popup.innerText()).replaceAll(title, '').replace(/close/ig, '').trim();
          assert.ok(body.length > 30, 'field note must contain actual illustrative text'); bodies.push(body);
        }, index === 0);
      }
      assert.equal(new Set(bodies).size, titles.length, 'different entries have identical notes');
    });
  },
  async 'reading-list-notes'(s, p, step) {
    await step('contents rail renders three distinct essays, not just different titles', async () => {
      const bodies=[];
      for(const title of ['Morning walk','Borrowed tools','Open windows']) {
        await selectEntry(s,title);
        const heading=await one(visible(s.getByRole('heading',{name:exact(title)})),`essay heading ${title}`);
        const container=heading.locator('xpath=ancestor::*[self::article or self::section or self::main or @role="region"][1]');
        let body=(await container.innerText()).trim();
        for(const name of ['Morning walk','Borrowed tools','Open windows'])body=body.replaceAll(name,'');
        assert.ok(body.length>30,'Selected essay has no actual text');bodies.push(body);
      }
      assert.equal(new Set(bodies).size,3,'Different essays have identical bodies');
      await selectEntry(s,'Morning walk');
    });
    await step('read state belongs to each essay and progress counts unique essays', async () => {
      await assertText(s, /0\s*(?:of|\/)\s*3/);
      await selectEntry(s, 'Morning walk'); await click(s, 'Mark as read'); await assertText(s, /1\s*(?:of|\/)\s*3/);
      await selectEntry(s, 'Borrowed tools'); await click(s, 'Mark as read'); await assertText(s, /2\s*(?:of|\/)\s*3/);
      await selectEntry(s, 'Morning walk'); await click(s, 'Mark unread'); await assertText(s, /1\s*(?:of|\/)\s*3/);
      await selectEntry(s, 'Open windows'); await click(s, 'Mark as read'); await assertText(s, /2\s*(?:of|\/)\s*3/);
      await selectEntry(s, 'Morning walk'); await click(s, 'Mark as read'); await assertText(s, /3\s*(?:of|\/)\s*3/);
      for(const title of ['Morning walk','Borrowed tools','Open windows']) {await selectEntry(s,title);await click(s,'Mark unread');}
      await assertText(s,/0\s*(?:of|\/)\s*3/);await selectEntry(s,'Morning walk');
    });
    await step('empty note rejected; literal notes remain independent across essays', async () => {
      await (await field(s, 'Note')).fill('');
      const save = button(s, 'Save note');
      if (await save.isEnabled()) await save.click();
      const read = button(s, 'Read saved note');
      if (await read.count()) assert.equal(await read.isEnabled(), false, 'an empty note cannot create a saved note');
      await (await field(s, 'Note')).fill(noteText); await click(s, 'Save note');
      await selectEntry(s, 'Borrowed tools'); await (await field(s, 'Note')).fill('Second independent note'); await click(s, 'Save note');
      await selectEntry(s, 'Morning walk');
      await dialog(s, p, 'Read saved note', popup => literal(popup, noteText));
      await selectEntry(s, 'Borrowed tools');
      await dialog(s, p, 'Read saved note', async popup => { await shown(popup, 'Second independent note'); await absent(popup, noteText); });
    });
  },
  async 'repair-search-states'(s, p, step) {
    await step('search and explicit loading/empty/error states hide stale rows', async () => {
      await search(s, 'radio'); await shown(s, 'Portable radio'); await absent(s, 'Desk lamp');
      await search(s,'no-match-9031');
      for(const title of ['Desk lamp','Portable radio','Kitchen scale'])await absent(s,title);
      await shown(s,/no .*(?:repairs|items|matches|results)|nothing (?:found|here)/i);
      await search(s, '');
      for (const state of ['Loading', 'Empty', 'Error']) {
        await choose(s, state, /View state/i); await absent(s, 'Desk lamp'); await absent(s, 'Portable radio');
        if (state === 'Loading') assert.ok(await visible(s.getByRole('progressbar').or(s.locator('[aria-busy="true"]')).or(s.getByRole('status'))).count(), 'loading feedback missing');
      }
      await click(s, 'Retry'); await shown(s, 'Desk lamp'); await shown(s, 'Portable radio');
    });
    await step('actual table owner and status appear in each item dialog', async () => {
      assert.equal(await visible(s.getByRole('table')).count(), 1);
      for (const title of ['Desk lamp', 'Portable radio', 'Kitchen scale']) {
        const row = await item(s, title), cells = await row.getByRole('cell').allInnerTexts();
        assert.ok(cells.length >= 3, 'Item, Owner and Status are required');
        assert.ok(cells[1].trim() && cells[2].trim(),'Owner and status cannot be empty placeholders');
        const open = button(row, /^Details\b/i); await open.click();
        const popup = await one(visible(s.getByRole('dialog')), 'item dialog');
        for (const value of [title, cells[1].trim(), cells[2].trim()])
          assert.ok((await popup.innerText()).includes(value),`Dialog does not match its table row: ${value}`);
        await p.keyboard.press('Escape'); assert.equal(await open.evaluate(e => e === e.ownerDocument.activeElement), true);
      }
    });
  },
  async 'incident-assignment-resolution'(s, p, step) {
    const titles = ['Sensor offline', 'Door reader', 'Display cable'];
    const assigned = async (name, message = 'Incorrect incident assignee') => {
      const select = await field(s, 'Assignee');
      // Missing option[value] is valid HTML. Check the actual selected label,
      // independent of whether a project uses names or internal IDs as values.
      assert.deepEqual(await select.evaluate(node => [...node.selectedOptions].map(option => option.label.trim())), [name], message);
    };
    const counts = async (open, resolved) => {
      const body = await readText(s);
      for (const [label, n] of [['Open', open], ['Resolved', resolved]])
        assert.match(body, new RegExp('(?:\\b' + label + '\\s*(?:incidents?\\s*)?[:(·—-]?\\s*' + n + '(?!\\d)|\\b' + n + '\\s+' + label + '\\b)', 'i'),
          `Incorrect incident count: ${label} must be ${n}`);
    };
    const filter = async label => {
      const name = new RegExp('^' + label + '(?:\\s*[:(·—-]?\\s*\\d+\\s*\\)?)?$', 'i');
      const radio = visible(s.getByRole('radio', {name}));
      if (await radio.count() === 1) return radio.check();
      await (await one(visible(s.getByRole('tab', {name}).or(s.getByRole('button', {name}))), `incident filter ${label}`)).click();
    };
    const history = [
      [titles[0], /assign(?:ed|ment)?\b/i, /Mira/],
      [titles[1], /assign(?:ed|ment)?\b/i, /Unassigned/],
      [titles[0], /\bresolv(?:e|ed)\b/i], [titles[0], /\breopen(?:ed)?\b|Resolved.*(?:→|->|to).*Open/i],
      ...titles.map(title => [title, /\bresolv(?:e|ed)\b/i]),
    ];
    const checkHistory = async popup => {
      let entries = visible(popup.locator('li,tr,article,[role="row"],[role="listitem"]'));
      entries = entries.filter({hasNot: entries});
      const actions = (await entries.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
        .filter(t => titles.some(title => t.includes(title)) && /\b(?:assign(?:ed|ment)?|resolv(?:e|ed)|reopen(?:ed)?)\b/i.test(t));
      assert.equal(actions.length, history.length, 'History actions are missing or duplicated');
      for (const [i, [title, ...patterns]] of history.entries()) {
        assert.ok(actions[i].includes(title) && patterns.every(pattern => pattern.test(actions[i])),
          `History action order/content mismatch at ${i + 1}: ${actions[i]}`);
      }
    };
    await step('assignment changes one incident only and survives filtering', async () => {
      await counts(3, 0);
      for (const [i, title] of titles.entries()) {
        await selectEntry(s, title); await assigned(['Unassigned', 'Mira', 'Ivo'][i]);
      }
      // Choosing a draft is not Apply. Switching away must not commit it.
      await selectEntry(s, titles[0]); await (await field(s, 'Assignee')).selectOption({label: 'Ivo'});
      await selectEntry(s, titles[1]); await selectEntry(s, titles[0]);
      await assigned('Unassigned', 'Draft assignment changed before Apply assignment');
      await selectEntry(s, 'Sensor offline'); await (await field(s, 'Assignee')).selectOption({label: 'Mira'}); await click(s, 'Apply assignment');
      await selectEntry(s, 'Door reader'); await assigned('Mira');
      await (await field(s, 'Assignee')).selectOption({label: 'Unassigned'}); await click(s, 'Apply assignment');
      await selectEntry(s, 'Display cable'); await assigned('Ivo');
      await selectEntry(s, 'Sensor offline'); await click(s, 'Resolve'); await counts(2, 1);
      await filter('Resolved'); await shown(s, 'Sensor offline'); await absent(s, 'Door reader'); await absent(s, 'Display cable');
      await selectEntry(s, 'Sensor offline'); await assigned('Mira');
      await click(s, 'Reopen'); await counts(3, 0); await filter('Open'); await shown(s, 'Sensor offline');
      await selectEntry(s, 'Door reader'); await assigned('Unassigned');
    });
    await step('resolving every record yields a recoverable empty state and ordered history', async () => {
      for (const [i, title] of titles.entries()) {
        await selectEntry(s, title); await click(s, 'Resolve'); await counts(2 - i, i + 1);
      }
      await assertText(s, /no open|no incidents|all (?:incidents )?resolved/i);
      await filter('Resolved'); for (const title of titles) await shown(s, title);
      await dialog(s, p, 'History', checkHistory);
      await selectEntry(s, 'Door reader'); await assigned('Unassigned'); await click(s, 'Reopen');
      await filter('Open'); await counts(1, 2); await shown(s, 'Door reader');
      await absent(s, 'Sensor offline'); await absent(s, 'Display cable');
      history.push(['Door reader', /\breopen(?:ed)?\b|Resolved.*(?:→|->|to).*Open/i]);
      await dialog(s, p, 'History', checkHistory);
    });
  },
  async 'settings-draft-commit'(s, p, step) {
    const focused = control => control.evaluate(node => node === node.ownerDocument.activeElement);
    // The saved summary is read from the region the page names so. The brief does
    // not require a region for it: a page that shows it elsewhere is read as a whole.
    const summary = async () => {
      const named = visible(s.getByRole('region', {name: /\bsaved\b|^(?:project |settings )?summary$/i}));
      return await named.count() === 1 ? named : null;
    };
    const summaryText = async () => (await (await summary() ?? s.locator('body')).innerText()).replace(/\s+/g, ' ').toLowerCase();
    // What a summary region exposes besides the project name: text, states and text alternatives.
    const summaryDetails = async () => {
      const region = await summary();
      return region ? (await region.ariaSnapshot()).replace(/studio notes|small studio/gi, '') : null;
    };
    // Rendered lines outside the form controls. Digits are ignored, so that a
    // character counter that follows the name is not read as an error message.
    const lines = async () => (await s.locator('body').innerText()).split('\n')
      .map(line => line.replace(/\s+/g, ' ').replace(/\d+/g, '#').trim()).filter(Boolean);
    // The browser's own message is the field's error when the page lets the browser
    // report it: an `invalid` event on the field that the page did not cancel.
    const watch = control => control.evaluateHandle(node => {
      const seen = {reported: false};
      node.addEventListener('invalid', event => setTimeout(() => { seen.reported = !event.defaultPrevented && Boolean(node.validationMessage); }), {once: true});
      return seen;
    });
    // A field-level error: a line the page did not show while the same draft was valid.
    const fieldError = async (valid, seen) => {
      const rest = [...valid];
      const added = (await lines()).filter(line => { const at = rest.indexOf(line); if (at >= 0) rest.splice(at, 1); return at < 0; });
      return added.length > 0 || await seen.evaluate(log => new Promise(done => setTimeout(() => done(log.reported))));
    };
    await step('draft edits across tabs can be cancelled without changing saved values', async () => {
      await choose(s, 'Basics'); assert.equal(await (await field(s, 'Project name')).inputValue(), 'Studio notes');
      await (await field(s, 'Project name')).fill('Draft only');
      const drafted = await summaryText();
      if (await summary()) assert.ok(!drafted.includes('draft only'), 'The saved summary shows the unsaved draft');
      assert.ok(drafted.includes('studio notes'), 'No visible saved summary shows the saved project name Studio notes');
      await choose(s, 'Notifications');
      const digest = await field(s, /daily digest/i), alerts = await field(s, /comment alerts/i);
      assert.equal(await digest.isChecked(), true); assert.equal(await alerts.isChecked(), false);
      await digest.uncheck(); await alerts.check(); await click(s, 'Cancel changes');
      assert.equal(await digest.isChecked(), true); assert.equal(await alerts.isChecked(), false);
      await choose(s, 'Basics'); assert.equal(await (await field(s, 'Project name')).inputValue(), 'Studio notes');
    });
    await step('invalid name is focused, review gives before/after and save commits once', async () => {
      const name = await field(s, 'Project name');
      await name.fill('Draft name'); const valid = await lines();
      await name.fill(''); let seen = await watch(name);
      if (await button(s, 'Save changes').isEnabled()) await click(s, 'Save changes');
      assert.equal(await focused(name), true);
      assert.ok(await name.evaluate(e => !e.validity.valid || e.getAttribute('aria-invalid') === 'true'), 'required field must expose invalidity');
      assert.ok(await fieldError(valid, seen), 'An empty project name shows no field-level error');
      await name.fill('x'.repeat(41));
      if ((await name.inputValue()).length > 40) {
        seen = await watch(name);
        if (await button(s, 'Save changes').isEnabled()) await click(s, 'Save changes');
        assert.ok(await name.evaluate(e => !e.validity.valid || e.getAttribute('aria-invalid') === 'true'), 'A project name over 40 characters must be marked invalid');
        assert.equal(await focused(name), true, 'A project name over 40 characters must be focused');
        assert.ok(await fieldError(valid, seen), 'A project name over 40 characters shows no field-level error');
      }
      await name.fill('Small studio');
      // Review changes is read three times: with the name changed, then with each
      // notification setting changed too. What it shows must change with each of them.
      let reviewed;
      const review = setting => dialog(s, p, 'Review changes', async popup => {
        await shown(popup, /Studio notes/); await shown(popup, /Small studio/);
        const shownNow = await popup.ariaSnapshot();
        if (setting) {
          assert.ok(await text(popup, new RegExp(escape(setting), 'i')).count(), `Review changes omits the changed setting ${setting}`);
          assert.notEqual(shownNow, reviewed, `Review changes does not show the change of ${setting}`);
        }
        reviewed = shownNow;
      });
      await review();
      await choose(s, 'Notifications');
      const digest = await field(s, /daily digest/i), alerts = await field(s, /comment alerts/i);
      await digest.uncheck(); await choose(s, 'Basics'); await review('Daily digest');
      await choose(s, 'Notifications'); await alerts.check(); await choose(s, 'Basics'); await review('Comment alerts');
      const earlier = await summaryDetails();
      await click(s, 'Save changes'); assert.equal(await button(s, 'Save changes').isDisabled(), true);
      assert.ok((await summaryText()).includes('small studio'), 'The visible saved summary was not updated to the saved project name Small studio');
      await name.fill('Uncommitted'); await click(s, 'Cancel changes'); assert.equal(await name.inputValue(), 'Small studio');
      // Save commits the whole draft: Cancel now returns to the saved Notifications values.
      await choose(s, 'Notifications');
      assert.deepEqual([await digest.isChecked(), await alerts.isChecked()], [false, true], 'Notifications do not show the saved values after Save changes and a cancelled edit');
      await digest.check();
      assert.equal(await button(s, 'Save changes').isEnabled(), true, 'Save changes must be enabled again by another edit');
      await click(s, 'Cancel changes');
      assert.deepEqual([await digest.isChecked(), await alerts.isChecked()], [false, true], 'Cancel changes did not restore the saved Notifications values');
      await choose(s, 'Basics');
      // A summary region that lists the notification settings must follow them too.
      if (earlier !== null && /digest|alerts/i.test(earlier))
        assert.notEqual(await summaryDetails(), earlier, 'The saved summary still shows the earlier notification settings');
    });
  },
  async 'room-wizard-validation'(s, p, step) {
    const rooms = ['Cedar', 'Birch'], times = ['09:00', '14:00'];
    const next = () => button(s, /^Continue\b/i), count = () => field(s, /participant/i);
    // What the page presents as chosen among `labels`, read from the kinds of control
    // choose() operates: a select named `group`, radios, or tabs and buttons that
    // expose a state. null when the controls expose none.
    const chosen = async (labels, group) => {
      const starting = name => new RegExp('^' + escape(name) + '(?:$|\\s|[(:])', 'i');
      const select = visible(s.getByRole('combobox', {name: group}));
      if (await select.count() === 1) {
        const label = await select.evaluate(node => (node.selectedOptions?.[0]?.label ?? '').trim());
        return labels.filter(name => starting(name).test(label));
      }
      const picked = []; let readable = false;
      for (const name of labels) {
        const radio = visible(s.getByRole('radio', {name: starting(name)}));
        if (await radio.count() === 1) { readable = true; if (await radio.isChecked()) picked.push(name); continue; }
        const other = visible(s.getByRole('tab', {name: starting(name)}).or(s.getByRole('button', {name: starting(name)})));
        if (await other.count() !== 1) continue;
        const state = await other.evaluate(node => ['aria-selected', 'aria-pressed', 'aria-checked'].map(attribute => node.getAttribute(attribute)).find(value => value !== null) ?? '');
        if (state) { readable = true; if (state === 'true') picked.push(name); }
      }
      return readable ? picked : null;
    };
    const timeStep = async () => ({time: await chosen(times, /Time/i), count: await (await count()).inputValue()});
    // Review is compared with itself. The words that differ between two Review steps
    // are what Review shows for the changed choice, whatever else on the page
    // mentions a room, a time, a capacity or a step number.
    const words = async () => (await readText(s)).toLowerCase().match(/\d{1,2}:\d{2}|\p{L}+|\d+(?:\.\d+)?/gu) || [];
    const only = (a, b) => { const rest = [...b]; return a.filter(word => { const at = rest.indexOf(word); if (at >= 0) rest.splice(at, 1); return at < 0; }); };
    const reviewChanged = (before, after, was, now, what) => {
      const gone = only(before, after), came = only(after, before);
      assert.ok(was.every(word => gone.includes(word)) && now.every(word => came.includes(word)),
        `Review does not show the exact ${what}: ${was.join(', ')} should have become ${now.join(', ')}`);
    };
    let initial; // The Time step as first shown, which Start over must restore.
    await step('capacity changes invalidate, but do not replace, the entered count', async () => {
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      await choose(s, 'Birch', /Room/i); await click(s, /^Continue\b/i);
      initial = await timeStep();
      if (initial.time && !initial.time.length) {
        if (await (await count()).isEditable()) await (await count()).fill('6');
        assert.equal(await next().isDisabled(), true, 'Continue must stay disabled until a time is chosen');
      }
      await choose(s, '09:00', /Time/i); await (await count()).fill('');
      assert.equal(await next().isDisabled(), true, 'Continue must stay disabled without a participant count');
      await (await count()).fill('6'); await click(s, /^Continue\b/i);
      const morning = await words();
      await click(s, /^Back\b/i);
      const kept = await timeStep();
      if (kept.time) assert.deepEqual(kept.time, ['09:00'], 'Back from Review did not preserve the chosen time');
      assert.equal(kept.count, '6', 'Back from Review did not preserve the participant count');
      await choose(s, '14:00', /Time/i); await click(s, /^Continue\b/i);
      const afternoon = await words(); reviewChanged(morning, afternoon, ['09:00'], ['14:00'], 'time');
      await click(s, /^Back\b/i); await (await field(s, /participant/i)).fill('7'); await click(s, /^Continue\b/i);
      const seven = await words(); reviewChanged(afternoon, seven, ['6'], ['7'], 'participant count');
      await assertText(s, /Birch/); await assertText(s, /14:00/); await assertText(s, /\b7\b/);
      await click(s, /^Back\b/i); await click(s, /^Back\b/i);
      const room = await chosen(rooms, /Room/i);
      if (room) assert.deepEqual(room, ['Birch'], 'Back did not preserve the chosen room');
      assert.equal(await next().isEnabled(), true, 'Back did not preserve the chosen room: Continue is disabled on the Room step');
      await choose(s, 'Cedar', /Room/i); await click(s, /^Continue\b/i);
      assert.equal(await (await field(s, /participant/i)).inputValue(), '7'); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      const time = await chosen(times, /Time/i);
      if (time) assert.deepEqual(time, ['14:00'], 'Back to the Room step did not preserve the chosen time');
      for (const value of ['0', '1.5']) { await (await field(s, /participant/i)).fill(value); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true); }
      await (await field(s, /participant/i)).fill('4'); await click(s, /^Continue\b/i); await assertText(s, /Cedar/); await assertText(s, /\b4\b/);
      // "4" alone is also Cedar's capacity; the count Review shows must have changed from 7.
      reviewChanged(seven, await words(), ['birch', '7'], ['cedar', '4'], 'room and participant count');
    });
    await step('confirmation is a local demo and Start over resets choices', async () => {
      const saying = () => text(s, /No room was booked/), earlier = await saying().elementHandles();
      await click(s, /^Confirm\b/i); await shown(s, /No room was booked/);
      assert.ok(await saying().evaluateAll((nodes, old) => nodes.some(node => !old.includes(node)), earlier),
        'Confirm did not open a completion panel saying No room was booked');
      await click(s, 'Start over');
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      // The Time step is hidden here: enter it again and compare it with its first state.
      await choose(s, 'Birch', /Room/i); await click(s, /^Continue\b/i);
      const again = await timeStep();
      assert.deepEqual(again.time, initial.time, 'Start over kept the chosen time');
      assert.equal(again.count, initial.count, 'Start over kept the participant count');
    });
  },
  async 'workshop-journey'(s, p, step) {
    const radio = name => s.getByRole('radio', {name: new RegExp('^' + escape(name) + '\\b', 'i')});
    // Review is compared with itself: the words that differ between two Review steps
    // are what Review shows, whatever else on the page names a workshop or a day.
    const words = async () => (await readText(s)).toLowerCase().match(/\p{L}+|\d+/gu) || [];
    const only = (a, b) => { const rest = [...b]; return a.filter(word => { const at = rest.indexOf(word); if (at >= 0) rest.splice(at, 1); return at < 0; }); };
    await step('radio keyboard selection admits the day step only after a choice', async () => {
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      const choices = visible(s.getByRole('radio')); assert.equal(await choices.count(), 3);
      assert.ok(await choices.evaluateAll(nodes => nodes.every(node => node.matches('input[type="radio"]'))), 'The brief requires real radio buttons for the workshops');
      await choices.first().focus(); await p.keyboard.press('Space'); await p.keyboard.press('ArrowDown');
      assert.equal(await s.getByRole('radio', {name: /^Bicycle care\b/i}).isChecked(), true);
      await click(s, /^Continue\b/i); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
    });
    await step('day selection, Back and review preserve exact choices', async () => {
      await s.getByRole('radio', {name: /^Thursday\b/i}).check(); await click(s, /^Continue\b/i);
      await shown(s, /Bicycle care/); await shown(s, /Thursday/); const first = await words();
      await click(s, /^Back\b/i); assert.equal(await s.getByRole('radio', {name: /^Thursday\b/i}).isChecked(), true);
      await click(s, /^Back\b/i); assert.equal(await s.getByRole('radio', {name: /^Bicycle care\b/i}).isChecked(), true);
      await click(s, /^Continue\b/i); await click(s, /^Continue\b/i);
      // A second Review with the other workshop and the other day.
      await click(s, /^Back\b/i); await click(s, /^Back\b/i);
      await radio('Urban sketching').check(); await click(s, /^Continue\b/i);
      await radio('Tuesday').check(); await click(s, /^Continue\b/i);
      const second = await words(), gone = only(first, second), came = only(second, first);
      assert.ok(['bicycle', 'care', 'thursday'].every(word => gone.includes(word)) && ['urban', 'sketching', 'tuesday'].every(word => came.includes(word)),
        'Review does not show the exact selections: Bicycle care on Thursday should have become Urban sketching on Tuesday');
    });
    await step('confirmation and restart are real state transitions', async () => {
      const saying = () => text(s, /No booking was made/), earlier = await saying().elementHandles();
      const before = await readText(s); await click(s, /^(Confirm|Complete|Finish)\b/i);
      await shown(s, /No booking was made/); assert.notEqual(await readText(s), before, 'confirmation did not change the interface');
      assert.ok(await saying().evaluateAll((nodes, old) => nodes.some(node => !old.includes(node)), earlier),
        'The final confirmation does not say No booking was made');
      await click(s, /^Start again\b/i); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      assert.equal(await visible(s.getByRole('radio', {checked: true})).count(), 0);
      // The day step is hidden here: enter it again to see whether its choice was reset too.
      await radio('Bookbinding').check(); await click(s, /^Continue\b/i);
      for (const day of ['Tuesday', 'Thursday']) assert.equal(await radio(day).isChecked(), false, `Start again kept the chosen day ${day}`);
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true, 'Start again kept a day: Continue is enabled on the day step');
    });
  },
  async 'tool-shortlist-limits'(s, p, step) {
    // Rendered lines of the page. Two states are compared line by line, so that a
    // check reads the text that came with a change and not any text on the page.
    const lines = async () => (await s.locator('body').innerText()).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const fresh = (before, after) => after.filter(line => !before.includes(line));
    const mentions = (line, n) => (line.toLowerCase().match(/\p{L}+|\d+/gu) || []).some(word => word === String(n) || word === ['zero', 'one', 'two'][n]);
    const counted = (before, after, n, when) =>
      assert.ok(fresh(before, after).some(line => mentions(line, n)), `The visible shortlist count does not show ${n} ${when}`);
    // Whether the demo request `act` makes the page say so in an element that did not
    // already say it. The page may answer in the dialog or, closing it, beside the list.
    const answers = async act => {
      const saying = () => text(s, /No borrowing request was sent/), earlier = await saying().elementHandles();
      await act(); await shown(s, /No borrowing request was sent/);
      return saying().evaluateAll((nodes, old) => nodes.some(node => !old.includes(node)), earlier);
    };
    await step('category and search combine and recover', async () => {
      await choose(s, 'Garden', /category/i); await search(s, 'drill'); await absent(s, 'Hand drill'); await absent(s, 'Garden fork');
      const unmatched = await lines();
      await search(s, ''); await shown(s, 'Garden fork');
      // The empty state is text shown only while nothing matches, not any "no tools" on the page.
      const emptyState = /\b(?:no|0|zero)\b[^.]*\b(?:tools?|results?|match(?:es|ing)?|items?)\b|\bnothing\b|\b(?:could ?n.t|could not|can.t|cannot) find\b|\bnot found\b|\bempty\b/i;
      assert.ok(fresh(await lines(), unmatched).some(line => emptyState.test(line)), 'No empty state is shown while no tool matches the category and search');
      await choose(s, 'All', /category/i);
    });
    await step('two-item bound, dialog removal and visible count remain synchronized', async () => {
      const none = await lines();
      await action(s, 'Add to shortlist', 'Hand drill');
      const single = await lines(); counted(none, single, 1, 'after the first tool was added');
      await action(s, 'Add to shortlist', 'Sewing kit');
      const third = button(await item(s, 'Garden fork'), /^Add to shortlist\b/i);
      // A full shortlist may also replace this action, for example by a disabled "Shortlist full".
      if (await third.count() === 1 && await third.isEnabled()) await third.click();
      const full = await lines(); counted(single, full, 2, 'after the second tool was added');
      assert.ok(fresh(none, single).filter(line => mentions(line, 1)).some(line => !full.includes(line)), 'The visible shortlist count still shows 1 after the second tool was added');
      // The reason is a line that states the limit. The count is not a reason ("2 of 2
      // tools" matches the same words): a line that only repeats the earlier count line
      // with another number is left out, unless it names the limit in words.
      const statesLimit = /(?:maximum|max|limit|up to|only|two|2).*(?:two|2|tools|shortlist)/i;
      const limitWords = /\b(?:max(?:imum)?|limit(?:ed)?|up to|at most|only|no more than|full|cannot|can(?:'|’)?t)\b/i;
      const shape = line => line.toLowerCase().replace(/\b(?:\d+|no|zero|one|two)\b/g, '#').replace(/(\p{L}{3,})s\b/gu, '$1');
      const isCount = line => !single.includes(line) && single.some(other => shape(other) === shape(line));
      assert.ok(full.some(line => !(isCount(line) && !limitWords.test(line)) && (statesLimit.test(line) || limitWords.test(line) && !single.includes(line))),
        'The page does not show why a third tool cannot be added');
      await dialog(s, p, 'Review shortlist', async popup => {
        await shown(popup, 'Hand drill'); await shown(popup, 'Sewing kit'); await absent(popup, 'Garden fork'); await action(popup, 'Remove', 'Hand drill'); await absent(popup, 'Hand drill');
      });
      const offered = await itemAction(s, 'Add to shortlist', 'Hand drill').catch(() => null);
      assert.ok(offered && await offered.isEnabled(), 'The list does not offer Hand drill again after its removal in the dialog');
      counted(full, await lines(), 1, 'after a removal in the dialog');
      await action(s, 'Add to shortlist', 'Garden fork');
      let requested = false;
      await dialog(s, p, 'Review shortlist', async popup => {
        await shown(popup, 'Sewing kit'); await shown(popup, 'Garden fork'); await absent(popup, 'Hand drill');
        if (await button(popup, /request/i).count() !== 1) return;
        requested = true;
        assert.ok(await answers(() => click(popup, /request/i)), 'The demo request action does not say No borrowing request was sent');
      });
      // The brief does not place the demo request action inside the dialog.
      if (!requested) assert.ok(await answers(() => click(s, /request/i)), 'The demo request action does not say No borrowing request was sent');
    });
    await step('Remove outside the dialog frees a place; dialog, list and count follow', async () => {
      const full = await lines();
      // Any Remove for this tool outside the dialog. A page may show a chosen tool twice, in
      // the tool list and in a shortlist panel: a button named after the tool, or the
      // Remove button of an innermost row that shows it.
      const rows = visible(s.locator('article,li,tr,[role="row"],[role="listitem"],[role="group"]')).filter({has: text(s, 'Garden fork')});
      const removal = button(s, /^Remove\b.*Garden fork|^Garden fork.*\bRemove\b/i).or(button(rows.filter({hasNot: rows}), /^Remove\b/i));
      assert.ok(await removal.count(), 'No Remove action for Garden fork outside the dialog');
      await removal.first().click();
      await dialog(s, p, 'Review shortlist', async popup => {
        await shown(popup, 'Sewing kit');
        assert.equal(await text(popup, 'Garden fork').count(), 0, 'Remove outside the dialog left Garden fork on the shortlist');
      });
      counted(full, await lines(), 1, 'after Remove outside the dialog');
      await action(s, 'Add to shortlist', 'Hand drill');
      await dialog(s, p, 'Review shortlist', async popup => { await shown(popup, 'Hand drill'); await shown(popup, 'Sewing kit'); await absent(popup, 'Garden fork'); });
    });
  },
  async 'queue-order-and-active-item'(s, p, step) {
    const titles = ['Night lines', 'Paper satellites', 'Second sunrise'];
    const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
    const queueName = /^(?:(?:your|my) )?(?:listening )?queue(?:\s*\(.*\))?$/i, details = /^Queue details\b/i;
    const emptyState = /empty|no (?:queued )?tracks|nothing/i, body = s.locator('body');
    // Rendered lines of a scope. Two lines that differ only in their numbers are
    // the same line, so an updated counter is never read as a new message.
    const lines = async scope => (await scope.innerText()).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const appeared = (before, after) => {
      const known = new Set(before.map(line => line.replace(/\d+/g, '#')));
      return after.filter(line => !known.has(line.replace(/\d+/g, '#')));
    };
    // Innermost semantic rows of `scope` that hold the exact title: item()
    // without its requirement that there is exactly one.
    const rows = (scope, title) => visible(scope.locator(rowSelector)).filter({has: text(p, title)})
      .filter({hasNot: visible(p.locator(rowSelector)).filter({has: text(p, title)})});
    // The entries of a title: its own element; or, when the page repeats the title
    // outside the list ("Current: <strong>Paper satellites</strong>"), the rows
    // that hold it; or, when no element is the bare title, the smallest elements
    // whose text contains it ("1. Paper satellites — Current").
    const entries = async (scope, title) => {
      const bare = text(scope, title), found = await bare.count();
      if (found === 1) return bare;
      if (!found) return visible(scope.getByText(title));
      return await rows(scope, title).count() ? rows(scope, title) : bare;
    };
    const count = async (scope, title) => (await entries(scope, title)).count();
    const entry = async (scope, title, where) => {
      const found = await entries(scope, title), times = await found.count();
      assert.equal(times, 1, `Expected ${title} once in ${where}, found ${times}`);
      return found;
    };
    // A row action may carry the title after, before or inside its name: "Move
    // up Paper satellites", "Paper satellites: move up", "Move Paper satellites up".
    const naming = (name, title) => {
      const words = name.split(' '), quoted = '["“‘\']?' + escape(title) + '["”’\']?';
      return new RegExp(['^' + name + '\\b.*' + escape(title), '^' + escape(title) + '.*\\b' + name + '\\b',
        ...words.slice(1).map((_, i) => '^' + [...words.slice(0, i + 1), quoted, ...words.slice(i + 1)].join('\\s+') + '\\b')].join('|'), 'i');
    };
    const act = async (scope, name, title) => {
      const direct = button(scope, naming(name, title));
      await (await direct.count() === 1 ? direct : await itemAction(scope, name, title)).click();
    };
    // The geometric rule of ordered(), applied to those entries. Like is compared
    // with like: when one title has to be located by its row, all of them are.
    const order = async (scope, names, where) => {
      let found = [];
      for (const name of names) found.push(await entry(scope, name, where));
      const bare = [], held = [];
      for (const name of names) { bare.push(await text(scope, name).count()); held.push(await rows(scope, name).count()); }
      if (bare.some(times => times !== 1) && held.every(times => times === 1)) found = names.map(name => rows(scope, name));
      const boxes = [];
      for (const [index, name] of names.entries()) {
        const box = await found[index].boundingBox(); assert.ok(box, `No rendered entry ${name}`); boxes.push(box);
      }
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1], b = boxes[i];
        assert.ok(b.y > a.y + 1 || Math.abs(b.y - a.y) <= 1 && b.x > a.x, `Rendered order mismatch: ${names.join(' → ')}`);
      }
    };
    let listedDetails = [];
    await step('unique queue, actual order and current identity survive reordering', async () => {
      const library = await region(s, /library/i);
      // A queued track stays single whether its Add to queue control refuses the
      // second request, is disabled or is withdrawn.
      const addAgain = async title => {
        let control = button(library, naming('Add to queue', title));
        if (await control.count() !== 1) control = button(rows(library, title), /^Add to queue\b/i);
        if (await control.count() === 1 && await control.isEnabled()) await control.click();
      };
      await act(library, 'Add to queue', 'Night lines');
      const queue = await region(s, queueName);
      await addAgain('Night lines');
      assert.equal(await count(queue, 'Night lines'), 1, 'Add to queue put Night lines in the queue more than once');
      for (const title of titles.slice(1)) await act(library, 'Add to queue', title);
      // Each repeated request is for the last queued track, so a page that moves a
      // repeated track to the end keeps the same order as one that ignores it.
      await addAgain('Second sunrise');
      for (const title of titles) assert.equal(await count(queue, title), 1, `Add to queue put ${title} in the queue more than once`);
      await order(queue, titles, 'the queue');
      // Selection may be the title itself, a control such as "Make current", or
      // the row's radio. selectEntry() needs the bare title once in its row; when
      // the labels of the row's buttons repeat it, the first one is the title.
      const select = async title => {
        const holder = await item(queue, title), setter = button(holder, /^(?:make|set|mark|choose|select)\b.*\bcurrent\b/i);
        if (await setter.count() === 1) return setter.click();
        const radio = visible(holder.getByRole('radio'));
        if (await radio.count() === 1) return radio.check();
        try { await selectEntry(queue, title); } catch { await text(holder, title).first().click(); }
      };
      // How a row says Current: its rendered text nodes that hold the word, without
      // the title and numbers, and its checked or true ARIA states. It is learned
      // from the selected row, because an unselected row may show "Make current"
      // or an unchecked radio labelled Current.
      const marks = async title => (await item(queue, title)).evaluate((row, name) => {
        const found = [], walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const range = row.ownerDocument.createRange(); range.selectNodeContents(node);
          if (/current/i.test(node.nodeValue) && range.getClientRects().length && getComputedStyle(node.parentElement).visibility !== 'hidden')
            found.push(node.nodeValue.replace(name, ' ').toLowerCase().replace(/[^a-z]+/g, ' ').trim());
        }
        for (const node of [row, ...row.querySelectorAll('*')]) {
          if (node.matches('input') && node.checked) found.push('checked');
          for (const state of ['aria-current', 'aria-pressed', 'aria-selected', 'aria-checked'])
            if (node.hasAttribute(state) && node.getAttribute(state) !== 'false') found.push(state);
        }
        return found.sort().join('|');
      }, title);
      // innerText follows text-transform, so an upper-case badge reads "CURRENT".
      await select('Paper satellites'); await withinText(await item(queue, 'Paper satellites'), /Current/i);
      const marked = await marks('Paper satellites');
      for (const other of ['Night lines', 'Second sunrise'])
        assert.notEqual(await marks(other), marked, `${other} is marked Current exactly like the selected Paper satellites`);
      await act(queue, 'Move up', 'Paper satellites'); await order(queue, ['Paper satellites', 'Night lines', 'Second sunrise'], 'the queue');
      await withinText(await item(queue, 'Paper satellites'), /Current/i);
      await dialog(s, p, details, async popup => {
        await order(popup, ['Paper satellites', 'Night lines', 'Second sunrise'], 'Queue details'); listedDetails = await lines(popup);
      });
      await act(queue, 'Move down', 'Paper satellites'); await order(queue, titles, 'the queue');
      assert.equal(await marks('Paper satellites'), marked, 'Move down changed how Paper satellites is marked Current');
      await act(queue, 'Remove', 'Paper satellites'); await absent(queue, 'Paper satellites');
      const current = await queue.innerText(); assert.doesNotMatch(current, /Current\s*:?\s*Paper satellites|Paper satellites\s*Current/i);
      for (const other of ['Night lines', 'Second sunrise'])
        assert.notEqual(await marks(other), marked, `Removing the current track made ${other} Current instead of clearing Current`);
    });
    await step('clear leaves an honest empty demo, not audio playback', async () => {
      const queue = await region(s, queueName), before = await lines(body);
      await click(s, 'Clear queue');
      for (const title of titles) await absent(queue, title);
      // The empty state is text that Clear queue made appear, wherever the page puts it.
      assert.ok(appeared(before, await lines(body)).some(line => emptyState.test(line)), 'Clear queue left no explicit empty state on the page');
      await dialog(s, p, details, async popup => {
        for (const title of titles) assert.equal(await visible(popup.getByText(title)).count(), 0, `Unexpected visible content: ${title}`);
        assert.ok(appeared(listedDetails, await lines(popup)).some(line => emptyState.test(line)), 'Queue details shows no empty message for a cleared queue');
      });
      await shown(s, /No audio playback in this demo/);
    });
  },
  async 'schedule-conflicts'(s, p, step) {
    const sessions = ['Sound walks', 'Poster room', 'Light studies'];
    const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
    const review = /^Review my day\b/i, body = s.locator('body');
    const emptyDay = /empty|no sessions?\b|nothing|\bnone\b|not (?:chosen|selected|added|picked)/i;
    // Why the 10:00 slot is refused: a conflict word, or the time or slot said to
    // be taken. A programme row that only starts with its time ("10:00 Sound
    // walks Already added") is not an explanation.
    const reason = /conflict|clash|overlap|same (?:time|slot|hour)|already\b.*\b10:00|(?:10:00|slot) (?:slot )?(?:is )?(?:already )?(?:taken|occupied|full)|(?:taken|occupied) by|one session (?:per|at)/i;
    // Rendered lines of a scope. Two lines that differ only in their numbers are
    // the same line, so an updated counter is never read as a new message.
    const lines = async scope => (await scope.innerText()).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const appeared = (before, after) => {
      const known = new Set(before.map(line => line.replace(/\d+/g, '#')));
      return after.filter(line => !known.has(line.replace(/\d+/g, '#')));
    };
    // Innermost semantic rows that hold the exact title. A chosen session may
    // have two: its programme row and its entry in a "My day" list.
    const rows = (title, scope = s) => visible(scope.locator(rowSelector)).filter({has: text(p, title)})
      .filter({hasNot: visible(p.locator(rowSelector)).filter({has: text(p, title)})});
    const listed = title => text(s, title).count();
    // A row action may carry the title after, before or inside its name: "Add to
    // my day: Sound walks", "Sound walks: add to my day", "Add Sound walks to my day".
    const naming = (name, title) => {
      const words = name.split(' '), quoted = '["“‘\']?' + escape(title) + '["”’\']?';
      return new RegExp(['^' + name + '\\b.*' + escape(title), '^' + escape(title) + '.*\\b' + name + '\\b',
        ...words.slice(1).map((_, i) => '^' + [...words.slice(0, i + 1), quoted, ...words.slice(i + 1)].join('\\s+') + '\\b')].join('|'), 'i');
    };
    // The dialog entries of a session: the element that is its bare title; or its
    // rows, when the labels of a row's buttons repeat the title; or, when no element
    // is the bare title, the smallest elements whose text contains it ("10:00 —
    // Sound walks").
    const entries = async (popup, title) => {
      const bare = text(popup, title), found = await bare.count();
      if (found === 1) return bare;
      if (!found) return visible(popup.getByText(title));
      return await rows(title, popup).count() ? rows(title, popup) : bare;
    };
    // The geometric rule of ordered(), applied to those entries.
    const order = async (popup, names) => {
      const boxes = [];
      for (const name of names) {
        const found = await entries(popup, name);
        assert.equal(await found.count(), 1, `Expected one accessible ordered entry ${name}`);
        const box = await found.boundingBox(); assert.ok(box, `No rendered entry ${name}`); boxes.push(box);
      }
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1], b = boxes[i];
        assert.ok(b.y > a.y + 1 || Math.abs(b.y - a.y) <= 1 && b.x > a.x, `Rendered order mismatch: ${names.join(' → ')}`);
      }
    };
    const unlisted = async (popup, title) => assert.equal(await (await entries(popup, title)).count(), 0, `Unexpected visible content: ${title}`);
    // The parts of the day may be buttons, tabs, radios or the options of one select.
    const filter = async label => {
      const offers = new RegExp('^\\s*' + label + '(?:$|\\s|[(:])', 'i');
      const select = visible(s.getByRole('combobox')).filter({has: p.locator('option').filter({hasText: offers})});
      if (await select.count() !== 1) return choose(s, label);
      const option = select.locator('option').filter({hasText: offers}).first();
      await select.selectOption(await option.getAttribute('value') ?? await option.innerText());
    };
    // The Add to my day control of a session, or null when the page withdrew it.
    const offer = async title => {
      let control = button(s, naming('Add to my day', title));
      if (await control.count() !== 1) control = button(rows(title), /^Add to my day\b/i);
      return await control.count() === 1 ? control : null;
    };
    const add = async title => {
      const control = await offer(title);
      assert.ok(control, `Expected one accessible Add to my day on ${title}`);
      await control.click();
    };
    // The programme row and a "My day" list may each offer Remove for one
    // session; either frees the slot.
    const remove = async title => {
      let control = button(s, naming('Remove', title));
      if (!await control.count()) control = button(rows(title), /^Remove\b/i);
      assert.ok(await control.count(), `Expected one accessible Remove on ${title}`);
      await control.first().click();
    };
    let listedDay = [];
    await step('All, Morning and Afternoon list the sessions of that part of the day', async () => {
      // Nothing is chosen yet, so every rendering of a title belongs to the programme.
      const full = {};
      for (const title of sessions) { full[title] = await listed(title); assert.ok(full[title], `Missing visible content: ${title}`); }
      for (const [label, kept] of [['Morning', ['Sound walks', 'Poster room']], ['Afternoon', ['Light studies']], ['All', sessions]]) {
        await filter(label);
        for (const title of sessions) {
          const now = await listed(title);
          if (kept.includes(title)) assert.equal(now, full[title], `${label} filter hides ${title}`);
          else assert.ok(now < full[title], `${label} filter still lists ${title}`);
        }
      }
    });
    await step('conflicting session is rejected without replacing saved choice', async () => {
      const before = await lines(body);
      await add('Sound walks');
      const conflicting = await offer('Poster room'), attempted = conflicting !== null && await conflicting.isEnabled();
      if (attempted) await conflicting.click();
      // A refused click must be answered by text that was not on the page before
      // the 10:00 slot was taken; a disabled or withdrawn control must be explained.
      const now = await lines(body);
      assert.ok((attempted ? appeared(before, now) : now).some(line => reason.test(line)),
        attempted ? 'Adding Poster room to the taken 10:00 slot produced no explanation of the conflict'
          : 'Poster room cannot be added, but no visible text explains the 10:00 conflict');
      await add('Light studies');
      await dialog(s, p, review, async popup => { await order(popup, ['Sound walks', 'Light studies']); await unlisted(popup, 'Poster room'); });
      // A chosen session may stay visible in a "My day" list; its programme row must go.
      const morning = await listed('Sound walks'), afternoon = await listed('Light studies');
      await filter('Afternoon');
      assert.ok(await listed('Sound walks') < morning, 'Afternoon filter still lists the chosen 10:00 session Sound walks in the programme');
      await shown(s, 'Light studies');
      assert.equal(await listed('Light studies'), afternoon, 'Afternoon filter hides the chosen 14:00 session Light studies');
      await dialog(s, p, review, async popup => {
        for (const title of ['Sound walks', 'Light studies'])
          assert.ok(await (await entries(popup, title)).count(), `The Afternoon filter dropped the saved choice ${title}`);
        await order(popup, ['Sound walks', 'Light studies']);
      });
      await filter('All');
      await remove('Sound walks'); await add('Poster room');
      await dialog(s, p, review, async popup => {
        await order(popup, ['Poster room', 'Light studies']); await unlisted(popup, 'Sound walks'); listedDay = await lines(popup);
      });
    });
    await step('removal empties the day and finish does not claim real reservations', async () => {
      await remove('Poster room'); await remove('Light studies');
      await dialog(s, p, review, async popup => {
        for (const title of sessions) await unlisted(popup, title);
        // The message belongs to the empty day: it was not shown while sessions were listed.
        assert.ok(appeared(listedDay, await lines(popup)).some(line => emptyDay.test(line)), 'Review my day shows no empty message that appears when no session is selected');
      });
      const before = await lines(body);
      await click(s, 'Finish demo');
      assert.ok(appeared(before, await lines(body)).some(line => /no tickets were reserved/i.test(line)), 'Finish demo did not state that No tickets were reserved');
    });
  },
  async 'catalog-compare-price-order'(s, p, step) {
    const names = ['Pocket strap', 'Canvas wrap', 'Lens pouch'];
    const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
    const opener = /^Compare selected\b/i, body = s.locator('body');
    // Rendered lines of a scope. Two lines that differ only in their numbers are
    // the same line, so an updated counter is never read as a new message.
    const fold = line => line.replace(/\d+/g, '#');
    const lines = async scope => (await scope.innerText()).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const appeared = (before, after) => { const known = new Set(before.map(fold)); return after.filter(line => !known.has(fold(line))); };
    // Innermost semantic rows that hold the exact name. A selected product may
    // have two: its shelf row and its entry in a list of the selection.
    const rows = name => visible(s.locator(rowSelector)).filter({has: text(p, name)})
      .filter({hasNot: visible(p.locator(rowSelector)).filter({has: text(p, name)})});
    const listing = async (expected, when) => {
      for (const name of names) assert.equal(await text(s, name).count() > 0, expected.includes(name),
        `${when}: ${name} is ${expected.includes(name) ? 'missing' : 'still listed'}`);
    };
    // The geometric rule of ordered(). A product's entry is the element that is
    // its name, or its row when the row's controls repeat the name in their
    // labels ("Compare <span>Pocket strap</span>").
    const order = async expected => {
      const boxes = [], bare = [];
      for (const name of expected) bare.push(await text(s, name).count());
      for (const name of expected) {
        // Like is compared with like: all names by their element, or all by their row.
        const found = bare.every(times => times === 1) ? text(s, name) : rows(name);
        assert.equal(await found.count(), 1, `Expected one accessible ordered entry ${name}`);
        const box = await found.boundingBox(); assert.ok(box, `No rendered entry ${name}`); boxes.push(box);
      }
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1], b = boxes[i];
        assert.ok(b.y > a.y + 1 || Math.abs(b.y - a.y) <= 1 && b.x > a.x, `Rendered order mismatch: ${expected.join(' → ')}`);
      }
    };
    await step('size/search combine; price sort changes rendered product order', async () => {
      await choose(s, 'Small', /Size/i); await search(s, 'wrap'); await listing([], 'Small with the search "wrap"');
      await search(s, 'pouch'); await listing(['Lens pouch'], 'Small with the search "pouch"');
      await search(s, ''); await listing(['Pocket strap', 'Lens pouch'], 'Small');
      await choose(s, 'Large', /Size/i); await listing(['Canvas wrap'], 'Large');
      await choose(s, 'All', /Size/i); await listing(names, 'All sizes');
      await choose(s, 'Low to high', /Sort by price/i); await order(['Pocket strap', 'Lens pouch', 'Canvas wrap']);
      await choose(s, 'High to low', /Sort by price/i); await order(['Canvas wrap', 'Lens pouch', 'Pocket strap']);
    });
    await step('compare keeps two exact products and dialog removal updates selection', async () => {
      // The shelf toggle of a product: a checkbox or a button in the product's row,
      // named Compare or with other words for it ("Add to comparison").
      const toggleOf = async name => {
        const choice = visible(rows(name).getByRole('checkbox', {name: /compar/i}));
        return await choice.count() ? choice : button(rows(name), /compar/i);
      };
      // Returns whether the toggle accepted a click; a page may disable it instead.
      const toggle = async name => {
        const control = await one(await toggleOf(name), `Compare toggle of ${name}`), enabled = await control.isEnabled();
        if (enabled) await control.click();
        return enabled;
      };
      // Checked or pressed when the toggle exposes it; null when it cannot be read
      // (hidden by a filter, or a button that states its selection in words only).
      const selected = async name => {
        const control = await toggleOf(name);
        if (await control.count() !== 1) return null;
        return control.evaluate(node => node.matches('input') ? node.checked
          : node.hasAttribute('aria-checked') ? node.getAttribute('aria-checked') === 'true'
          : node.hasAttribute('aria-pressed') ? node.getAttribute('aria-pressed') === 'true' : null);
      };
      const selection = async (expected, when) => {
        for (const [name, on] of Object.entries(expected)) {
          const state = await selected(name);
          if (state !== null) assert.equal(state, on, `${when}: the Compare toggle of ${name} is ${state ? 'on' : 'off'}`);
        }
      };
      // A selection counter is a line that keeps its wording while only its numbers
      // change between zero, one and two selected products ("1 of 2 selected",
      // "Compare selected (1)"). It is learned here and read again after each change.
      const counters = async () => {
        const seen = new Map();
        for (const line of await lines(body)) seen.set(fold(line), seen.has(fold(line)) ? null : line);
        return seen;
      };
      // A compared product is named by its own element, or leads a column header
      // that also holds its Remove control.
      const compared = async (popup, name) => await text(popup, name).count() > 0
        || await visible(popup.getByRole('columnheader', {name: new RegExp('^' + escape(name) + '\\b', 'i')})).count() > 0;
      const start = await lines(body), none = await counters();
      await toggle('Pocket strap'); const single = await counters();
      await toggle('Canvas wrap'); const pair = await counters();
      const counting = [...pair.keys()].filter(key => none.get(key) && single.get(key) && pair.get(key)
        && new Set([none.get(key), single.get(key), pair.get(key)]).size === 3);
      const counted = async (state, when) => {
        const now = await counters();
        // A line whose wording changed is no longer that counter; a stale one keeps its wording.
        for (const key of counting) if (now.get(key))
          assert.equal(now.get(key), state.get(key), `${when}: the selection count reads "${now.get(key)}" instead of "${state.get(key)}"`);
      };
      const full = await lines(body), attempted = await toggle('Lens pouch');
      await selection({'Pocket strap': true, 'Canvas wrap': true, 'Lens pouch': false}, 'After a third product was chosen');
      // A refused click must be answered by text it made appear, or by a limit
      // that the page announced once two were selected; the selection count is
      // neither. A disabled toggle must be explained by visible text.
      const limit = /\b(?:only|at most|maximum|max|up to|limit\w*|no more than|cannot|can't|full|too many|remove one|deselect)\b/i;
      const stated = line => limit.test(line) || /(?:two|2).*(?:products|compare)|compare.*(?:two|2)/i.test(line);
      const now = await lines(body);
      assert.ok(attempted ? appeared(full, now).some(stated) || appeared(start, now).some(line => limit.test(line)) : now.some(stated),
        attempted ? 'The third product was refused without an explicit message' : 'A third product cannot be chosen, but no visible text states the limit of two');
      await dialog(s, p, opener, async popup => {
        for (const [name, price, size] of [['Pocket strap', 18, 'Small'], ['Canvas wrap', 32, 'Large']]) {
          const values = await comparedProduct(popup, name);
          assert.match(values, new RegExp('(?:€\\s*' + price + '|' + price + '\\s*€)'), `Compare selected does not show €${price} for ${name}`);
          // innerText follows text-transform, so an upper-case size reads "SMALL".
          assert.match(values, new RegExp('\\b' + size + '\\b', 'i'), `Compare selected does not show the size ${size} for ${name}`);
        }
        assert.ok(!await compared(popup, 'Lens pouch'), 'Compare selected lists the refused third product Lens pouch');
      });
      // Filtering changes what the shelf lists, never what is selected.
      await choose(s, 'Large', /Size/i); await selection({'Canvas wrap': true}, 'With the Large filter');
      await choose(s, 'All', /Size/i);
      await selection({'Pocket strap': true, 'Canvas wrap': true, 'Lens pouch': false}, 'After filtering by size'); await counted(pair, 'After filtering by size');
      await dialog(s, p, opener, async popup => {
        for (const name of ['Pocket strap', 'Canvas wrap']) assert.ok(await compared(popup, name), `Filtering by size dropped ${name} from the comparison`);
        await action(popup, 'Remove', 'Pocket strap');
        assert.ok(!await compared(popup, 'Pocket strap'), 'Remove in the dialog left Pocket strap in the comparison');
      });
      await selection({'Pocket strap': false, 'Canvas wrap': true, 'Lens pouch': false}, 'After Remove in the dialog'); await counted(single, 'After Remove in the dialog');
      await toggle('Lens pouch');
      await dialog(s, p, opener, async popup => {
        for (const name of ['Lens pouch', 'Canvas wrap']) assert.ok(await compared(popup, name), `Missing visible content: ${name}`);
        assert.ok(!await compared(popup, 'Pocket strap'), 'Unexpected visible content: Pocket strap');
      });
    });
  },
  async 'variant-basket-totals'(s, p, step) {
    const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
    const basketName = /^(?:(?:your|my) )?basket(?:\s*\(.*\))?$/i, reviewOrder = /^Review order\b/i, body = s.locator('body');
    const chalk = /\bChalk\b/i, ink = /\bInk\b/i, more = /^\+$|increase|add one/i, fewer = /^[-−]$|decrease|remove one/i;
    // Rendered lines of a scope. Two lines that differ only in their numbers are
    // the same line, so an updated total is never read as a new message.
    const lines = async scope => (await scope.innerText()).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const appeared = (before, after) => {
      const known = new Set(before.map(line => line.replace(/\d+/g, '#')));
      return after.filter(line => !known.has(line.replace(/\d+/g, '#')));
    };
    const flat = async scope => (await scope.innerText()).replace(/\s+/g, ' ');
    // €68, €68.00 or 68,00 €; never the beginning or the end of another amount.
    const money = amount => new RegExp('(?:€\\s*' + amount + '(?!\\d|[.,]\\d*[1-9])|(?<![\\d.,])' + amount + '(?:[.,]0+)?\\s*€)');
    const colour = name => choose(s, name, /colou?r|finish/i);
    // The Long cable may be a checkbox or switch, or one of two radios.
    const cable = async wanted => {
      const control = await field(s, /Long cable/i);
      if (!await control.evaluate(node => node.type === 'radio' || node.getAttribute('role') === 'radio')) return wanted ? control.check() : control.uncheck();
      if (await control.isChecked() === wanted) return;
      if (wanted) return control.check();
      const pair = control.locator('xpath=ancestor::*[self::fieldset or @role="radiogroup"][1]').getByRole('radio');
      assert.equal(await pair.count(), 2, 'The Long cable radio has no single alternative in its group');
      for (const radio of await pair.all()) if (!await radio.isChecked()) return radio.check();
    };
    // The brief does not name the panel: it is the region called configuration,
    // or else the innermost region that holds Add to basket, or else the page.
    const configuration = async () => {
      const named = visible(s.getByRole('region', {name: /configuration|configure.*lamp/i}));
      if (await named.count() === 1) return named;
      const holds = {has: button(p, 'Add to basket')};
      const around = visible(s.getByRole('region')).filter(holds).filter({hasNot: visible(p.getByRole('region')).filter(holds)});
      return await around.count() === 1 ? around : body;
    };
    // The quantity may be a number field, a select of the allowed values, or a
    // stepper of two buttons around a value. Returns false when the control
    // cannot express the value; every loop is bounded by the range 1 to 4.
    const setQuantity = async value => {
      // The field of the configuration panel; basket rows may have quantity fields too.
      let control = null, missing = null;
      for (const scope of [await configuration(), s]) {
        try { control = await field(scope, /^Quantity$/i); break; } catch (error) { missing = error; }
      }
      const kind = control === null ? 'stepper' : await control.evaluate(node => node.tagName === 'SELECT' ? 'select'
        : node.matches('input:not([readonly]),textarea') ? 'input' : 'stepper');
      if (kind === 'input') { await control.fill(String(value)); return true; }
      if (kind === 'select') {
        if (!(await control.locator('option').allTextContents()).some(label => label.trim() === String(value))) return false;
        await control.selectOption(String(value)); return true;
      }
      const panel = await configuration();
      const less = button(panel, /^[-−–]$|decrease|fewer|minus|reduce/i), up = button(panel, /^\+$|increase|plus/i);
      if (await less.count() !== 1 || await up.count() !== 1) throw missing ?? new Error('Expected one decrease and one increase control for the quantity');
      for (let i = 0; i < 3 && await less.isEnabled(); i++) await less.click();
      for (let i = 1; i < value && await up.isEnabled(); i++) await up.click();
      return true;
    };
    const quantity = async value => assert.ok(await setQuantity(value), `The quantity control does not offer ${value}`);
    // Basket rows are found by what the brief requires them to show: the colour
    // and the exact subtotal. The innermost semantic rows that name the colour.
    const named = (basket, name) => visible(basket.locator(rowSelector)).filter({hasText: name}).filter({hasNot: p.locator(rowSelector).filter({hasText: name})});
    const basketRows = async (basket, name, amount) => {
      const candidates = named(basket, name), found = [], all = await candidates.count();
      assert.ok(all <= 24, `The basket holds ${all} rows that name one colour; at most four variants exist`);
      for (let i = 0; i < all; i++) if (money(amount).test(await flat(candidates.nth(i)))) found.push(candidates.nth(i));
      return found;
    };
    const row = async (basket, name, amount, why) => {
      const found = await basketRows(basket, name, amount);
      assert.equal(found.length, 1, why);
      return found[0];
    };
    // Every expected grand total differs from all row amounts on show, so it can
    // only be the total; the amount it replaces must be gone.
    const total = async (basket, amount, stale, when) => {
      const rendered = await flat(basket);
      assert.match(rendered, money(amount), `The basket does not show the grand total €${amount} ${when}`);
      if (stale) assert.doesNotMatch(rendered, money(stale), `The basket still shows the previous total €${stale} ${when}`);
    };
    await step('variant unit prices, quantities and merge identity determine exact totals', async () => {
      await colour('Chalk'); await cable(true); await quantity(2);
      const config = await flat(await configuration());
      assert.match(config, money(68), 'The configuration does not show the unit price €68 for Chalk with the Long cable');
      assert.match(config, money(136), 'The configuration does not show the total €136 for two');
      await click(s, 'Add to basket'); await click(s, 'Add to basket');
      const basket = await region(s, basketName);
      await row(basket, chalk, 272, 'Adding the same Chalk and Long cable variant twice should give one row with the subtotal €272');
      await colour('Ink'); await cable(false); await quantity(1); await click(s, 'Add to basket');
      await row(basket, ink, 65, 'Ink without the cable should be one row with the subtotal €65');
      await total(basket, 337, 0, 'for four Chalk with the Long cable and one Ink');
      await dialog(s, p, reviewOrder, async popup => {
        await shown(popup, /Chalk/); await shown(popup, /Ink/);
        assert.match(await flat(popup), money(337), 'Review order does not show the grand total €337');
      });
      await colour('Chalk'); await cable(true);
      const before = await lines(body), add = button(s, 'Add to basket'), attempted = await add.isEnabled();
      if (attempted) await add.click();
      await total(basket, 337, 0, 'after a fifth Chalk with the Long cable was refused');
      // The brief caps a variant at four and asks for no particular feedback: a
      // limit stated anywhere on the page counts, and so does a message that the
      // refused click made appear. Row quantities and prices are never a statement.
      const now = await lines(body);
      assert.ok(now.some(line => /\b(?:maximum|max|limit\w*|up to|at most|no more than|capped)\b/i.test(line))
        || appeared(before, now).some(line => /\b(?:only|cannot|can't|could not|couldn't|not added|already|full|reached)\b/i.test(line)),
        'A fifth unit of one variant was refused, but nothing visible states the limit of four');
      // Same colour, other cable: a different variant and a separate row.
      await colour('Chalk'); await cable(false); await quantity(3); await click(s, 'Add to basket');
      await row(basket, chalk, 180, 'Chalk without the Long cable should be its own row with the subtotal €180, not merged by colour');
      await row(basket, chalk, 272, 'The Chalk row with the Long cable should keep its subtotal €272');
      await total(basket, 517, 337, 'after adding three Chalk without the Long cable');
    });
    await step('basket quantity changes/removal recalculate independently; confirmation is local only', async () => {
      const basket = await region(s, basketName);
      await click(await row(basket, ink, 65, 'Expected one Ink row with the subtotal €65'), more);
      await row(basket, ink, 130, 'The Ink row should show the subtotal €130 for two'); await total(basket, 582, 517, 'after increasing the Ink row');
      await click(await row(basket, ink, 130, 'Expected one Ink row with the subtotal €130'), fewer);
      await row(basket, ink, 65, 'The Ink row should return to the subtotal €65'); await total(basket, 517, 582, 'after decreasing the Ink row');
      await click(await row(basket, chalk, 180, 'Expected one Chalk row with the subtotal €180'), more);
      const full = await row(basket, chalk, 240, 'The Chalk row without the cable should show the subtotal €240 for four');
      await total(basket, 577, 517, 'after increasing the Chalk row without the cable');
      // The cap of four also holds in the basket: + on a full row is disabled or changes nothing.
      const extra = button(full, more);
      if (await extra.count() === 1 && await extra.isEnabled()) await extra.click();
      await row(basket, chalk, 240, 'The increase control raised a basket row above four units');
      await total(basket, 577, 0, 'after increasing a row that already holds four');
      await click(await row(basket, chalk, 272, 'Expected one Chalk row with the subtotal €272'), /^Remove\b/i);
      assert.equal((await basketRows(basket, chalk, 272)).length, 0, 'Remove left the Chalk row with the Long cable in the basket');
      await row(basket, chalk, 240, 'Remove on the Chalk row with the Long cable removed another Chalk row');
      await row(basket, ink, 65, 'Remove on the Chalk row with the Long cable removed the Ink row');
      await total(basket, 305, 577, 'after removing the Chalk row with the Long cable');
      await dialog(s, p, reviewOrder, async popup => {
        const before = await lines(body);
        await click(popup, /^(Confirm|Complete|Finish|Place|Submit|Send|Checkout|Check out|Order)\b/i);
        assert.ok(appeared(before, await lines(body)).some(line => /no order was placed/i.test(line)), 'Completing the review did not say that No order was placed');
      });
    });
    await step('clear basket removes all variants and restores empty state', async () => {
      const basket = await region(s, basketName), before = await lines(basket);
      await click(s, 'Clear basket');
      // The empty state is text that Clear basket made appear in the basket.
      assert.ok(appeared(before, await lines(basket)).some(line => /empty|no items|nothing/i.test(line)), 'Clear basket did not restore a visible empty state in the basket');
      // A status line of the basket may still name what was removed; its rows may not.
      for (const [name, colourName] of [['Chalk', chalk], ['Ink', ink]])
        assert.equal(await named(basket, colourName).count(), 0, `Clear basket left a ${name} row in the basket`);
    });
    await step('a quantity above four never reaches the basket', async () => {
      const basket = await region(s, basketName);
      await colour('Ink'); await cable(false);
      // A select or a stepper may be unable to express five: nothing to refuse then.
      if (!await setQuantity(5)) return;
      const add = button(s, 'Add to basket');
      if (await add.isEnabled()) await add.click();
      assert.doesNotMatch(await flat(basket), money(325), 'Add to basket put five units of one variant (€325) in the basket');
    });
  },
  async 'thread-replies-literal-text'(s, p, step) {
    const first = 'What are you reading?';
    // The brief's own words name these controls ("Post" a "Reply", "Follow",
    // "Unfollow"). Another usual name is accepted when no control has that one.
    const postName = /^(?:(?:Post|Add|Send|Submit)(?: reply)?|Reply)$/i, followName = /^Follow(?:$|\s)/i, unfollowName = /^Unfollow(?:$|\s)/i;
    const named = async (usual, other) => await button(s, usual).count() === 1 ? button(s, usual) : button(s, other);
    const post = () => named(/^(Post|Add) reply$/i, postName), follow = () => named(exact('Follow'), followName), unfollow = () => named(exact('Unfollow'), unfollowName);
    const press = async (control, description) => (await one(await control, description)).click();
    const replyField = () => field(s, /^(?:Your |Write a |Add a )?reply\b/i);
    // "Return to the feed" names the destination, not the control: a button or
    // a link called Back, Back to feed or All threads, possibly after an arrow.
    const feedName = /^\W*(?:(?:Back|Return)(?: to (?:the )?(?:all )?(?:threads?|feed|discussions?|list))?|All (?:threads|feed|discussions))$/i;
    const back = async () => (await one(visible(s.getByRole('button', {name: feedName}).or(s.getByRole('link', {name: feedName}))), 'control returning to the feed')).click();
    // A reply may share its element with a byline ("You: text"). Its literal
    // characters must be rendered either way and none of them as markup; in
    // another thread no element may contain them at all.
    const literalReply = async value => {
      assert.ok(await visible(s.getByText(value)).count(), `Missing visible content: ${value}`);
      assert.equal(await s.locator('img[src="x"],b').filter({hasText: 'literal'}).count(), 0, 'saved text became markup');
    };
    const noReply = async value => assert.equal(await visible(s.getByText(value)).count(), 0, `Unexpected visible content: ${value}`);
    // A thread may start with sample replies: read the number ("2 replies",
    // "Replies: 2", "Replies (2)"), never assume zero. Only a thread without
    // replies may show no number at all ("No replies yet"), so only the first
    // reading may lack one.
    const replyCount = async (title, withoutNumber) => {
      const entry = (await (await item(s, title)).innerText()).replace(/\s+/g, ' ');
      const counted = /\b(\d+)\s+repl(?:y|ies)\b/i.exec(entry) || /\brepl(?:y|ies)\s*[:(]\s*(\d+)\b/i.exec(entry);
      if (!counted && withoutNumber !== undefined) return withoutNumber;
      assert.ok(counted, `The feed entry of ${title} shows no reply count such as "2 replies"`);
      return Number(counted[1]);
    };
    await step('literal reply belongs to one thread and survives return to feed', async () => {
      await search(s, 'Weekend'); await shown(s, 'Weekend swap'); await absent(s, 'Quiet recommendations'); await search(s, '');
      const before = await replyCount(first, 0);
      await selectEntry(s, first); const reply = await replyField(), send = await one(await post(), 'button posting the reply');
      await reply.fill(''); if (await send.isEnabled()) await send.click();
      await reply.fill(noteText); await send.click(); await literalReply(noteText);
      await back(); const after = await replyCount(first);
      assert.equal(after, before + 1, `The feed counted ${before} replies before one reply was posted and ${after} after it`);
      await selectEntry(s, 'Weekend swap'); await noReply(noteText);
      await (await replyField()).fill('Different thread reply'); await press(post(), 'button posting the reply');
      await back(); await selectEntry(s, first); await literalReply(noteText); await noReply('Different thread reply');
    });
    await step('a reply over 200 characters is never posted in full', async () => {
      // Words, not one unbroken token: the layout check after this step must
      // not fail for a string no reader would type. A field limited with
      // maxlength keeps the first 200 characters, which is a valid reply.
      const over = 'slow pages and long evenings '.repeat(7).slice(0, 201);
      await back(); await selectEntry(s, 'Quiet recommendations'); await (await replyField()).fill(over);
      const send = await post(); if (await send.count() === 1 && await send.isEnabled()) await send.click();
      assert.equal(await visible(s.getByText(over)).count(), 0, 'A reply longer than 200 characters was posted');
    });
    await step('follow/unfollow is thread-specific and profile dialog is operable', async () => {
      const buttonNames = () => visible(s.getByRole('button')).evaluateAll(nodes =>
        nodes.map(node => (node.getAttribute('aria-label') || node.innerText || '').replace(/\s+/g, ' ').trim()));
      // The Following filter may be a checkbox or a switch. Checking one twice
      // is harmless; a second click on a toggle button would switch it off.
      const followingBox = visible(s.getByRole('checkbox', {name: /following|followed/i}).or(s.getByRole('switch', {name: /following|followed/i})));
      const onlyFollowing = async () => await followingBox.count() === 1 ? followingBox.check() : choose(s, 'Following');
      await back(); await selectEntry(s, first); await press(follow(), 'button Follow');
      // The third thread, so that neither title read under the filter below
      // can come from the thread opened last instead of from the feed.
      await back(); await selectEntry(s, 'Quiet recommendations');
      assert.deepEqual([await (await follow()).count(), await (await unfollow()).count()], [1, 0], 'Following one thread changed the follow control of another thread');
      await back(); const inFeed = await buttonNames(); await onlyFollowing();
      await shown(s, first); await absent(s, 'Weekend swap'); await selectEntry(s, first);
      let author = button(s, /profile|author/i);
      if (await author.count() === 0) {
        // "The author name opens a native profile dialog": the button may be
        // named by the name alone. It is then the one button of the open
        // thread that this scenario does not use and the feed does not show;
        // when the feed names authors too, the one the thread credits ("by NAME").
        const unused = (await buttonNames()).filter(name => name && ![followName, unfollowName, postName, feedName].some(used => used.test(name)));
        const fresh = unused.filter(name => !inFeed.includes(name)), page = await readText(s);
        const found = fresh.length === 1 ? fresh : (fresh.length ? fresh : unused).filter(name =>
          new RegExp('\\b(?:by|author|from)\\b[:\\s]+' + escape(name), 'i').test(page));
        assert.equal(found.length, 1, `Expected one author name button in the open thread, found: ${found.join(' | ') || 'none'}`);
        author = button(s, exact(found[0]));
      }
      const name = await (await one(author, 'author profile')).getAttribute('aria-label') || await author.innerText();
      await dialog(s, p, exact(name), popup => shown(popup, /profile|member|joined/i));
      await press(unfollow(), 'button Unfollow'); await back();
      // A feed that reset its filter lists the thread never followed: apply the filter again.
      if (await text(s, 'Weekend swap').count()) await onlyFollowing();
      assert.equal(await text(s, first).count(), 0, 'An unfollowed thread is still listed under the Following filter');
    });
  },
  async 'review-reason-and-undo'(s, p, step) {
    const [first, second, third] = ['Missing event details', 'Duplicate introduction', 'Broken resource link'];
    // A filter may be a tab that carries its count ("Resolved (1)"), as the
    // buttons, radios and options that `choose` accepts may.
    const filterName = status => new RegExp('^' + status + '(?:$|\\s|[(:])', 'i');
    const filter = async status => {
      const tab = visible(s.getByRole('tab', {name: filterName(status)}));
      return await tab.count() === 1 ? tab.click() : choose(s, status);
    };
    // A filter control that carries its count ("Resolved (1)") is read alone.
    // Otherwise the count is a number beside its status word in the rendered
    // text: a summary ("Resolved: 1", "1 resolved") or a small table.
    const count = async (status, expected, when) => {
      const control = visible(s.getByRole('tab', {name: filterName(status)}).or(s.getByRole('button', {name: filterName(status)})));
      const own = await control.count() === 1 ? /\d+/.exec(await control.evaluate(node => node.getAttribute('aria-label') || node.innerText)) : null;
      const body = await readText(s), beside = own ? [own[0]] : [];
      if (!own) for (const found of body.matchAll(new RegExp('\\b' + status + '\\b', 'gi')))
        beside.push(...(body.slice(Math.max(0, found.index - 12), found.index) + ' ' + body.slice(found.index + status.length, found.index + status.length + 12)).match(/\d+/g) || []);
      assert.ok(beside.map(Number).includes(expected), `${status} count is not ${expected} ${when}`);
    };
    // One Details button for the open report ("Details", else "View details"),
    // or one in each report row, named with the report or inside its row.
    const detailsOpener = async title => {
      const opener = '(?:(?:View|Show|Open|Report) )?details', inRow = new RegExp('^' + opener + '\\b', 'i');
      for (const name of [exact('Details'), new RegExp('^' + opener + '$', 'i'),
        new RegExp('^' + opener + '\\b.*' + escape(title) + '|^' + escape(title) + '.*\\bdetails\\b', 'i')])
        if (await button(s, name).count() === 1) return [s, name];
      const row = await item(s, title).catch(() => null);
      return row && await button(row, inRow).count() === 1 ? [row, inRow] : null;
    };
    const details = async (title, verify) => {
      const opener = await detailsOpener(title);
      assert.ok(opener, `Expected one accessible Details button for ${title}`);
      await dialog(opener[0], p, opener[1], verify);
    };
    // "A required Reason textarea": the label may say more ("Reason for resolving (required)").
    const reason = () => field(s, /^(?:Resolution )?reason\b/i);
    // The dialog may show the reason after a label in the same element ("Last
    // reason: text"). Its characters must be rendered and none as markup.
    const literalReason = async popup => {
      assert.ok(await visible(popup.getByText(noteText)).count(), `Missing visible content: ${noteText}`);
      assert.equal(await popup.locator('img[src="x"],b').filter({hasText: 'literal'}).count(), 0, 'saved text became markup');
    };
    await step('required reason, resolved filtering and literal reason belong to one report', async () => {
      await selectEntry(s, first); await (await reason()).fill(''); assert.equal(await button(s, 'Resolve').isDisabled(), true);
      await (await reason()).fill(noteText); await click(s, 'Resolve');
      // The page may start on Pending or on all reports, and a second click may
      // switch a toggle off: a filter is chosen only while the other one is active.
      // The open report repeats its own title. Open another report before
      // reading a list, so that only a list entry can show or hide a title.
      await filter('Resolved'); await filter('Pending'); await selectEntry(s, third);
      assert.ok(await text(s, second).count(), 'Resolving one report removed another report from Pending');
      assert.equal(await text(s, first).count(), 0, 'A resolved report is still listed under Pending');
      await count('Pending', 2, 'after one of three reports was resolved');
      await filter('Resolved'); await count('Resolved', 1, 'after one report was resolved');
      await shown(s, first); await absent(s, second); await selectEntry(s, first);
      await details(first, async popup => { await shown(popup, /Missing event details/); await literalReason(popup); });
      // Wherever else the page shows the reason, every character stays literal.
      const mentions = await visible(s.getByText('literal & note')).evaluateAll(nodes => nodes.map(node => node.textContent));
      assert.ok(mentions.every(value => value.includes(noteText)), 'The recorded reason is rendered as markup outside the Details dialog');
      await filter('Pending'); await selectEntry(s, second); assert.equal(await (await reason()).inputValue(), '');
      // A report that was never resolved may offer no Details; one that does must not show that reason.
      if (await detailsOpener(second)) await details(second, async popup => {
        await shown(popup, /Duplicate introduction/);
        assert.equal(await visible(popup.getByText('literal & note')).count(), 0, 'The reason recorded on one report is shown on another report');
      });
    });
    await step('Undo resolution restores only its own report', async () => {
      // A second resolved report makes "without changing others" observable.
      await selectEntry(s, third); await (await reason()).fill('Second reason'); await click(s, 'Resolve');
      await filter('Resolved'); await selectEntry(s, first);
      await details(first, async popup => assert.ok(await visible(popup.getByText(noteText)).count(), 'A later reason replaced the reason recorded on another report'));
      await click(s, 'Undo resolution'); await filter('Pending');
      await shown(s, second); await selectEntry(s, second);
      assert.ok(await text(s, first).count(), 'Undo resolution did not return the report to the Pending list');
      assert.equal(await text(s, third).count(), 0, 'Undo resolution also restored another resolved report');
      await count('Pending', 2, 'after Undo resolution on one of two resolved reports');
      assert.equal(await (await reason()).inputValue(), '');
      await filter('Resolved'); await count('Resolved', 1, 'after Undo resolution on one of two resolved reports');
      assert.equal(await text(s, first).count(), 0, 'A report restored by Undo resolution is still listed under Resolved');
      await shown(s, third);
    });
  },
  async 'map-list-selection-filter'(s, p, step) {
    const places = ['North garden', 'Paper house', 'River steps'];
    let map, list, details;
    // A numbered map button is named with its place, with or without a verb
    // ("Select 2: Paper house", "2: Paper house"), or sits in a container that
    // shows the place name. A place is on the map through either of them.
    const mapButtons = name => visible(map.getByRole('button', {name: new RegExp('\\b' + escape(name) + '\\b', 'i')}));
    const selectOnMap = async name => await mapButtons(name).count() === 1 ? mapButtons(name).click() : action(map, 'Select', name);
    const onMap = async name => await mapButtons(name).count() + await text(map, new RegExp(escape(name))).count();
    // The detail area may show the name inside a longer title ("2 · Paper
    // house"). Once cleared it may mention the hidden place in a sentence,
    // but may show it neither alone nor as a heading.
    const detailed = name => shown(details, new RegExp(escape(name)));
    const cleared = async (name, message) => assert.equal(await text(details, name).count()
      + await visible(details.getByRole('heading', {name: new RegExp(escape(name))})).count(), 0, message);
    // "Keyboard users must reach every place through the list": focus the
    // list's own control for the place and activate it with the keyboard.
    const selectByKeyboard = async name => {
      let control = visible(list.getByRole('button', {name: new RegExp('^(?:Open |Select |Read |View )?' + escape(name) + '$', 'i')})
        .or(list.getByRole('link', {name: exact(name)})).or(list.getByRole('tab', {name: exact(name)})));
      if (await control.count() !== 1) {
        // The row's action, its radio or link, or a row that takes focus itself.
        const row = control = await item(list, name);
        for (const inner of [button(row, /^(open|select|read|view|details)\b/i), visible(row.getByRole('radio')), visible(row.getByRole('link')), visible(row.getByRole('button'))])
          if (await inner.count() === 1) { control = inner; break; }
      }
      await control.focus();
      assert.equal(await control.evaluate(node => node === node.ownerDocument.activeElement), true, `Keyboard users cannot reach ${name} through the list`);
      await p.keyboard.press(await control.evaluate(node => /^(?:radio|checkbox|option)$/.test(node.getAttribute('role') || node.type || '') ? 'Space' : 'Enter'));
    };
    await step('map/list selection is synchronized; filtering clears stale details', async () => {
      // The map may be named after the places it shows ("Map of small places")
      // and the brief calls the third area a "detail area": the list is the
      // region named for places or a list that is none of the other areas.
      map = await region(s, /map/i); list = await region(s, /^(?!.*(?:map|detail|selected|filter|search)).*(?:places|list)/i);
      await selectOnMap('Paper house'); details = await region(s, /detail|selected place/i); await detailed('Paper house');
      await selectEntry(list, 'North garden'); await detailed('North garden');
      await choose(s, 'Indoors'); await absent(list, 'North garden'); await absent(map, /North garden/);
      assert.equal(await mapButtons('North garden').count(), 0, 'The map still offers a button for a place the filter hides');
      await cleared('North garden', 'Unexpected visible content: North garden'); await shown(list, 'Paper house');
      assert.ok(await onMap('Paper house'), 'The filter removed a matching place from the map');
      // No place is selected now. Notes may be unavailable; a dialog that
      // does open must not name the place whose selection was cleared.
      const notesName = await button(s, 'Place notes').count() === 1 ? exact('Place notes') : /^(?:(?:Open|View|Show|Read) )?place notes$/i;
      const notes = button(s, notesName);
      if (await notes.count() === 1 && await notes.isEnabled()) {
        await notes.focus(); await p.keyboard.press('Enter');
        const popup = visible(notes.locator('xpath=ancestor::body').getByRole('dialog'));
        if (await popup.count() === 1) {
          assert.equal(await text(popup, /North garden/).count(), 0, 'Place notes still name a place whose selection was cleared');
          await p.keyboard.press('Escape'); await popup.waitFor({state: 'hidden', timeout: 3000});
        }
      }
      await selectEntry(list, 'Paper house'); await dialog(s, p, notesName, popup => shown(popup, /Paper house/));
      await search(s, 'River'); await shown(s, 'No places found'); await absent(list, 'Paper house');
      await cleared('Paper house', 'Details still show a place that the search hides');
      await click(s, 'Clear filters');
      for (const name of places) { await shown(list, name); assert.ok(await onMap(name), `Clear filters did not restore ${name} on the map`); }
      for (const name of places) { await selectByKeyboard(name); await detailed(name); }
    });
    await step('search text and category combine; Outdoors and All update map and list', async () => {
      await search(s, 'River'); await shown(list, 'River steps'); await absent(list, 'North garden');
      await choose(s, 'Outdoors'); await shown(list, 'River steps');
      // A page may empty the search when the category changes. Text that the
      // field still shows must still narrow the chosen category.
      if (await (await field(s, /^Search\b/i)).inputValue() === 'River')
        assert.equal(await text(list, 'North garden').count(), 0, 'Search text that is still shown is ignored after choosing a category');
      await search(s, '');
      for (const name of ['North garden', 'River steps']) { await shown(list, name); assert.ok(await onMap(name), `The Outdoors filter removed ${name} from the map`); }
      assert.equal(await text(list, 'Paper house').count(), 0, 'The Outdoors filter lists an indoor place');
      assert.equal(await onMap('Paper house'), 0, 'The Outdoors filter leaves an indoor place on the map');
      await choose(s, 'All');
      for (const name of places) { await shown(list, name); assert.ok(await onMap(name), `The All filter did not restore ${name} on the map`); }
    });
  },
  async 'itinerary-order-map-path'(s, p, step) {
    const names = ['Old kiosk', 'Glass hall', 'Willow court', 'East steps'];
    const rowSelector = 'article,li,tr,[role="row"],[role="listitem"],[role="group"]';
    let places, route, map;
    // The connecting path and the stop numbers are told apart from the map's own drawing by what
    // the map shows while the itinerary is empty: `decor` holds those strokes, `plain` those numbers.
    let decor = [], plain = [];
    const regions = async () => { places = await region(s, /available places/i); route = await region(s, /^(?:Your )?(?:route|itinerary)$/i); map = await region(s, /map/i); };
    const strokes = () => map.locator('svg path,svg polyline,svg line').evaluateAll(nodes => nodes.filter(e => {
      const r = e.getBoundingClientRect(); return r.width > 1 || r.height > 1;
    }).map(e => ({tag: e.tagName, d: e.getAttribute('d'), points: e.getAttribute('points'), x1: e.getAttribute('x1'), y1: e.getAttribute('y1'), x2: e.getAttribute('x2'), y2: e.getAttribute('y2')})));
    // Where each place is listed inside a region or dialog. An entry is the element whose whole
    // text is the name, as the shared `ordered` requires; failing that, a visible mention outside
    // a control, so that "1. Glass hall" and "Glass hall → Old kiosk" are entries too. The position
    // is that of the rendered name itself, never of a container assumed around it.
    const listings = scope => scope.evaluate((root, wanted) => {
      const out = {}, nodes = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      for (const name of wanted) {
        const found = [], needle = name.toLowerCase();
        for (const node of nodes) {
          const parent = node.parentElement, value = node.nodeValue.toLowerCase();
          if (!parent || getComputedStyle(parent).visibility !== 'visible') continue;
          for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + needle.length)) {
            const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length);
            const box = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
            const whole = parent.textContent.replace(/\s+/g, ' ').trim() === name;
            if (box && (whole || !parent.closest('button,a,select,label,[role="button"],[role="link"]'))) found.push({top: box.top, left: box.left, whole});
          }
        }
        out[name] = found.some(entry => entry.whole) ? found.filter(entry => entry.whole) : found;
      }
      return out;
    }, names);
    // Exactly these stops, each once, in this rendered order.
    const stops = async (scope, order, where) => {
      const found = await listings(scope);
      for (const name of order) assert.equal(found[name].length, 1, `Expected one accessible ordered entry ${name}`);
      for (const name of names) if (!order.includes(name)) assert.equal(found[name].length, 0, `${where} lists ${name}, which is not in the itinerary`);
      for (let i = 1; i < order.length; i++) {
        const a = found[order[i - 1]][0], b = found[order[i]][0];
        assert.ok(b.top > a.top + 1 || Math.abs(b.top - a.top) <= 1 && b.left > a.left, `Rendered order mismatch: ${order.join(' → ')}`);
      }
    };
    // The semantic row of a stop, also when its number and name share one text ("1. Old kiosk").
    const row = async title => {
      const mention = visible(p.getByText(new RegExp(escape(title), 'i')));
      const containing = visible(p.locator(rowSelector)).filter({has: mention});
      return one(visible(route.locator(rowSelector)).filter({has: mention}).filter({hasNot: containing}), `item containing ${title}`);
    };
    const act = async (label, title) => {
      const named = button(route, new RegExp('^(?:' + escape(label) + ')\\b.*' + escape(title) + '|^' + escape(title) + '.*\\b' + escape(label) + '\\b', 'i'));
      if (await named.count() === 1) return named.click();
      await (await one(button(await row(title), new RegExp('^' + escape(label) + '\\b', 'i')), `${label} on ${title}`)).click();
    };
    // "route rows have ... numbered order": the number a row shows outside its controls, or the
    // ordinal of its native list marker. The row is the innermost row, list item or article around
    // the listed name that holds no other stop; without one, the smallest box that holds the name
    // and its Remove control. Numbers produced by a CSS counter cannot be read back; such a row is
    // accepted, because those counters follow the row order that `stops` checks.
    const rowNumber = title => route.evaluate((area, {title, wanted}) => {
      const mentions = [], walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const parent = text.parentElement;
        if (!parent || !text.nodeValue.toLowerCase().includes(title.toLowerCase()) || !parent.getClientRects().length || getComputedStyle(parent).visibility !== 'visible') continue;
        const whole = parent.textContent.replace(/\s+/g, ' ').trim() === title;
        if (whole || !parent.closest('button,a,select,label,[role="button"],[role="link"]')) mentions.push({parent, whole});
      }
      const entry = (mentions.find(mention => mention.whole) || mentions[0])?.parent;
      if (!entry) return {row: false};
      const others = wanted.filter(name => name !== title).map(name => name.toLowerCase());
      const alone = node => !others.some(name => node.textContent.toLowerCase().includes(name));
      let node = entry.closest('article,li,tr,[role="row"],[role="listitem"],[role="group"]');
      if (!node || node === area || !area.contains(node) || !alone(node)) {
        const removes = box => [...box.querySelectorAll('button,[role="button"]')].some(control => /^remove\b/i.test((control.getAttribute('aria-label') || control.textContent).trim()));
        for (node = entry; node !== area && !removes(node);) node = node.parentElement;
        if (node === area || !alone(node)) return {row: false};
      }
      let own = '';
      const inner = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = inner.nextNode(); text; text = inner.nextNode())
        if (!text.parentElement.closest('button,a,select,input,textarea,label,[role="button"]')) own += ' ' + text.nodeValue;
      for (const name of wanted) own = own.split(name).join(' ');
      own = own.replace(/[①-⑳]/g, digit => ' ' + (digit.charCodeAt(0) - 0x245F) + ' ');
      const list = node.parentElement, style = getComputedStyle(node);
      let marker = null;
      if (node.localName === 'li' && list && style.display === 'list-item' && /^decimal/.test(style.listStyleType)) {
        const items = [...list.children].filter(child => child.localName === 'li' && getComputedStyle(child).display !== 'none');
        const ordered = list.localName === 'ol', by = ordered && list.reversed ? -1 : 1;
        let n = ordered && list.hasAttribute('start') ? list.start : by < 0 ? items.length : 1;
        for (const child of items) { if (child.hasAttribute('value')) n = child.value; if (child === node) { marker = n; break; } n += by; }
      }
      const generated = [node, ...node.querySelectorAll('*')].slice(0, 64).some(el =>
        ['::before', '::after', '::marker'].some(pseudo => /counters?\(/.test(getComputedStyle(el, pseudo).content)));
      return {row: true, numbers: (own.match(/\d+/g) || []).map(Number), marker, generated};
    }, {title, wanted: names});
    const shownBefore = new Map();
    const numbered = async order => {
      const count = (list, n) => list.filter(value => value === n).length;
      for (const [index, name] of order.entries()) {
        const position = index + 1, now = await rowNumber(name), was = shownBefore.get(name);
        assert.ok(now.row, `route stop ${name} has no row of its own`);
        if (now.marker !== null) assert.equal(now.marker, position, `route row ${name} is numbered ${now.marker}, expected ${position}`);
        else if (now.numbers.length) {
          assert.ok(now.numbers.includes(position), `route row ${name} does not show its stop number ${position}`);
          // A row may show other digits ("Stop 2 of 4"). After a pure reorder its old number must be gone.
          if (was && was.stops === order.length && was.position !== position)
            assert.ok(count(now.numbers, was.position) < count(was.numbers, was.position), `route row ${name} still shows its previous stop number ${was.position}`);
        } else assert.ok(now.generated, `route row ${name} shows no stop number`);
        shownBefore.set(name, {position, numbers: now.numbers, stops: order.length});
      }
    };
    // What the map draws for an itinerary, read from rendered geometry only. A place is located by
    // the text or accessible name that names it inside the SVG's rectangle; a stop number is a text
    // that is only a number, alone or next to one place name; the connecting path is every stroke
    // that the empty map did not have, sampled along its length in screen coordinates.
    const mapMarks = order => map.evaluate((area, {wanted, order, decor, plain}) => {
      const svg = [...area.querySelectorAll('svg')].map(node => ({node, box: node.getBoundingClientRect()}))
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
      if (!svg || svg.box.width < 2 || svg.box.height < 2) return {svg: false};
      const box = svg.box, about = value => wanted.filter(name => value.toLowerCase().includes(name.toLowerCase()));
      const inside = r => r.width > 0 && r.height > 0 && r.left + r.width / 2 >= box.left && r.left + r.width / 2 <= box.right
        && r.top + r.height / 2 >= box.top && r.top + r.height / 2 <= box.bottom;
      const anchors = Object.fromEntries(wanted.map(name => [name, []]));
      let numbers = [];
      for (const node of area.querySelectorAll('*')) {
        if (node.contains(svg.node) || node.closest('title,desc,defs,script,style')) continue;
        const r = node.getBoundingClientRect(); if (!inside(r) || getComputedStyle(node).visibility !== 'visible') continue;
        const rect = {left: r.left, top: r.top, right: r.right, bottom: r.bottom};
        if ([...node.childNodes].some(child => child.nodeType === 3 && child.nodeValue.trim())) {
          const value = node.textContent.replace(/\s+/g, ' ').trim(), named = about(value);
          let rest = value.toLowerCase().replace(/[\u2460-\u2473]/g, digit => ' ' + (digit.charCodeAt(0) - 0x245F) + ' ');
          for (const name of named) rest = rest.split(name.toLowerCase()).join(' ');
          const number = named.length < 2 && rest.match(/^[\s#(·.:—–-]*(?:stop|no\.?)?\s*(\d{1,2})[\s.:)·—–-]*$/);
          if (number) numbers.push({value: Number(number[1]), rect, x: Math.round(r.left - box.left), y: Math.round(r.top - box.top)});
          if (named.length === 1) anchors[named[0]].push(rect);
        }
        const label = about(node.getAttribute('aria-label') || [...node.children].find(child => child.localName === 'title')?.textContent || '');
        if (label.length === 1) anchors[label[0]].push(rect);
      }
      numbers = numbers.filter(n => !plain.some(old => old.value === n.value && Math.abs(old.x - n.x) <= 1 && Math.abs(old.y - n.y) <= 1));
      const gap = (a, b) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
      const near = (rect, rects) => Math.min(...rects.map(other => gap(rect, other)));
      const reach = (point, rects) => Math.min(...rects.map(r => Math.hypot(Math.max(0, r.left - point.x, point.x - r.right), Math.max(0, r.top - point.y, point.y - r.bottom))));
      const located = wanted.filter(name => anchors[name].length);
      for (const n of numbers) n.place = [...located].sort((a, b) => near(n.rect, anchors[a]) - near(n.rect, anchors[b]))[0] ?? null;
      const samples = [];
      for (const el of [...area.querySelectorAll('svg path,svg polyline,svg line')].slice(0, 96)) {
        const r = el.getBoundingClientRect(); if (!(r.width > 1 || r.height > 1)) continue;
        if (decor.includes(JSON.stringify({tag: el.tagName, d: el.getAttribute('d'), points: el.getAttribute('points'), x1: el.getAttribute('x1'),
          y1: el.getAttribute('y1'), x2: el.getAttribute('x2'), y2: el.getAttribute('y2')}))) continue;
        let total = 0, matrix = null; try { total = el.getTotalLength(); matrix = el.getScreenCTM(); } catch { continue; }
        if (!matrix || !(total > 0)) continue;
        for (let i = 0, count = Math.min(240, Math.max(2, Math.ceil(total))); i <= count; i++) {
          const at = el.getPointAtLength(total * i / count);
          samples.push({x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f});
        }
      }
      // A stop is marked by its name and by the number drawn at it.
      const marks = Object.fromEntries(wanted.map(name => [name, [...anchors[name]]]));
      order.forEach((name, index) => { for (const n of numbers) if (n.value === index + 1) marks[name].push(n.rect); });
      return {svg: true, paths: samples.length, numbers: numbers.map(n => ({value: n.value, x: n.x, y: n.y})), stops: order.map((name, index) => {
        const own = anchors[name], position = index + 1;
        const closest = own.length && numbers.length ? Math.min(...numbers.map(n => near(n.rect, own))) : null;
        let path = null;
        if (samples.length && marks[name].length) {
          let best = samples[0], distance = Infinity, other = Infinity;
          for (const point of samples) { const far = reach(point, marks[name]); if (far < distance) { distance = far; best = point; } }
          for (const rival of wanted) if (rival !== name && marks[rival].length) other = Math.min(other, reach(best, marks[rival]));
          path = {distance, other};
        }
        return {name, position, located: own.length > 0, path,
          nearest: closest === null ? [] : numbers.filter(n => near(n.rect, own) <= closest + 0.5).map(n => n.value),
          at: numbers.filter(n => n.value === position).map(n => n.place)};
      })};
    }, {wanted: names, order, decor, plain});
    // "Map stop numbers and connecting path must follow the current itinerary".
    const mapFollows = async order => {
      const seen = await mapMarks(order);
      assert.ok(seen.svg, 'map region has no rendered SVG');
      if (order.length > 1) assert.ok(seen.paths > 0, 'map shows no connecting path between the stops');
      for (const n of seen.numbers) assert.ok(n.value <= order.length, `map still shows stop number ${n.value} with only ${order.length} stops`);
      for (const stop of seen.stops) {
        assert.ok(stop.at.length, `map does not show stop number ${stop.position}`);
        // Either reading may be confused on a crowded map; a stale number fails both.
        if (stop.located) assert.ok(stop.nearest.includes(stop.position) || stop.at.includes(stop.name),
          `map shows stop number ${stop.nearest[0]} at ${stop.name}, expected ${stop.position}`);
        // The path's closest approach to a stop it reaches is at that stop's own marks; a path that
        // stays away from them and comes closer to another place does not reach the stop.
        if (stop.path) assert.ok(stop.path.distance <= 16 || stop.path.other >= stop.path.distance, `map connecting path does not reach ${stop.name}`);
      }
    };
    const mapEmpty = async () => {
      const seen = await mapMarks([]);
      assert.equal(seen.paths, 0, 'map still shows a connecting path after Reset route');
      assert.equal(seen.numbers.length, 0, 'map still shows stop numbers after Reset route');
    };
    const follows = async order => { await stops(route, order, 'route'); await numbered(order); await mapFollows(order); };
    // "Add stop appends a unique place, maximum four": a place already in the itinerary cannot be
    // added again, whether its Add control is disabled, gone from the list, or refuses when pressed.
    // With four places and unique stops a fifth stop can only be a repeated one.
    const unique = async order => {
      for (const name of order) {
        let control = null;
        try { control = await itemAction(places, 'Add stop', name); } catch { /* the place left the available list */ }
        if (control && await control.isEnabled()) await control.click();
        const found = await listings(route);
        assert.ok(names.reduce((sum, each) => sum + found[each].length, 0) <= 4, 'itinerary accepted a fifth stop; the maximum is four');
        assert.equal(found[name].length, 1, `Add stop added ${name} to the itinerary twice`);
      }
      await stops(route, order, 'route');
    };
    await step('route order survives filtering; map path changes on reorder/removal', async () => {
      await regions();
      // The brief fixes no opening itinerary; a page may start with sample stops. Begin from an empty one.
      const listed = async () => { const found = await listings(route); return names.filter(name => found[name].length); };
      if ((await listed()).length) { await click(s, 'Reset route'); assert.deepEqual(await listed(), [], 'Reset route left stops in the opening itinerary'); }
      decor = (await strokes()).map(stroke => JSON.stringify(stroke)); plain = (await mapMarks([])).numbers || [];
      for (const name of names) await action(places, 'Add stop', name);
      await stops(route, names, 'route');
      const before = await strokes(); assert.ok(before.length, 'no visible schematic route');
      await mapFollows(names); // any stroke of the map satisfies the line above; this one reads the route's own path
      await search(s, 'Old'); await stops(route, names, 'route'); await search(s, '');
      await act('Move up', 'Glass hall'); await stops(route, ['Glass hall', 'Old kiosk', 'Willow court', 'East steps'], 'route');
      assert.notDeepEqual(await strokes(), before, 'map connecting path did not change with the route');
      await dialog(s, p, 'Review route', popup => stops(popup, ['Glass hall', 'Old kiosk', 'Willow court', 'East steps'], 'Review route'));
      const reordered = await strokes(); await act('Remove', 'Old kiosk'); assert.notDeepEqual(await strokes(), reordered, 'removed stop remains in connecting path');
      const kept = await listings(route); assert.equal(kept['Old kiosk'].length, 0, 'Remove Old kiosk left it in the route');
      for (const name of ['Glass hall', 'Willow court', 'East steps']) assert.equal(kept[name].length, 1, `Remove Old kiosk also removed ${name}`);
      // "Reset route clears only the itinerary": no stop is listed any more. The brief asks for no
      // empty-state sentence, so none is required.
      await click(s, 'Reset route'); for (const name of names) await absent(route, name);
      await stops(route, [], 'route'); await mapEmpty();
    });
    await step('unique stops, Move down and exact removal keep row numbers, map numbers and path in step', async () => {
      await regions();
      let order = ['Willow court', 'Old kiosk', 'East steps'];
      for (const name of order) await action(places, 'Add stop', name);
      await follows(order); await unique(order);
      const before = await strokes(); await act('Move down', 'Willow court'); order = ['Old kiosk', 'Willow court', 'East steps'];
      await follows(order); assert.notDeepEqual(await strokes(), before, 'map connecting path did not change after Move down');
      await action(places, 'Add stop', 'Glass hall'); order = [...order, 'Glass hall']; await follows(order); await unique(order);
      await act('Remove', 'Willow court'); order = order.filter(name => name !== 'Willow court');
      const kept = await listings(route); assert.equal(kept['Willow court'].length, 0, 'Remove Willow court left it in the route');
      for (const name of order) assert.equal(kept[name].length, 1, `Remove Willow court also removed ${name}`);
      await follows(order);
      await dialog(s, p, 'Review route', popup => stops(popup, order, 'Review route'));
      const again = await itemAction(places, 'Add stop', 'Willow court');
      assert.ok(await again.isEnabled(), 'a removed stop cannot be added again'); await again.click();
      order = [...order, 'Willow court']; await follows(order);
      await click(s, 'Reset route'); await stops(route, [], 'route'); await mapEmpty();
      for (const name of names) assert.ok(await text(places, name).count(), `Reset route removed ${name} from Available places`);
    });
  },
  async 'object-selection-edit-history'(s, p, step) {
    let board, notes, hops = 1;
    const input = () => field(s, 'Text');
    const identities = () => notes.evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') || n.textContent.trim()));
    // Notes are read relative to the surface that holds them, so that a scrolled page cannot look
    // like a moved note. The surface is the nearest ancestor that encloses every note; `hops` is
    // its distance above a note, which finds it again after the page rebuilds its board.
    const regions = async () => {
      board = await region(s, /artboard/i); notes = visible(board.getByRole('button'));
      if (await notes.count()) hops = await notes.evaluateAll((nodes, area) => {
        const holds = holder => { const a = holder.getBoundingClientRect(); return nodes.every(node => { const b = node.getBoundingClientRect();
          return holder.contains(node) && b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1; }); };
        let up = 1, holder = nodes[nodes.length - 1].parentElement;
        while (holder !== area && holder.parentElement && !holds(holder)) { holder = holder.parentElement; up++; }
        return up;
      }, await board.elementHandle());
    };
    const layout = () => notes.evaluateAll((nodes, up) => {
      if (!nodes.length) return {width: 0, height: 0, notes: []};
      let holder = nodes[nodes.length - 1]; for (let i = 0; i < up && holder.parentElement; i++) holder = holder.parentElement;
      const a = holder.getBoundingClientRect(), active = document.activeElement;
      return {width: a.width, height: a.height, notes: nodes.map(node => { const b = node.getBoundingClientRect();
        return {id: node.getAttribute('aria-label') || node.textContent.trim(), focused: node === active || node.contains(active),
          x: b.left - a.left, y: b.top - a.top, right: b.right - a.left, bottom: b.bottom - a.top}; })};
    }, hops);
    // The note that holds keyboard focus; `fallback` is its index if the page does not report focus on it.
    const spot = (state, fallback) => state.notes.find(note => note.focused) ?? state.notes.at(fallback);
    const commit = async control => { const apply = button(s, /^(Apply|Save)(?: changes| text)?$/i); if (await apply.count()) await apply.click(); else await control.blur(); };
    // The text a region or dialog renders, as written (a text-transform does not change it), with
    // what it shows inside a rendered read-only field.
    const said = scope => scope.evaluate(node => {
      const parts = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(text);
        if (text.nodeValue.trim() && range.getClientRects().length && getComputedStyle(text.parentElement).visibility === 'visible') parts.push(text.nodeValue);
      }
      for (const control of node.querySelectorAll('textarea,input,output')) if (control.getClientRects().length) parts.push(control.value || '');
      return parts.join(' ').replace(/\s+/g, ' ');
    });
    // The literal note text on the board: in an element of its own, as the shared `literal` requires,
    // or inside a longer text such as "#2 <b>literal & note</b>"; never as markup.
    const written = async () => {
      assert.ok(await text(board, noteText).count() || (await said(board)).includes(noteText), `Missing visible content: ${noteText}`);
      assert.equal(await board.locator('img[src="x"],b').filter({hasText: 'literal'}).count(), 0, 'saved text became markup');
    };
    const erased = async () => assert.ok(!await text(board, noteText).count() && !(await said(board)).includes(noteText), `Unexpected visible content: ${noteText}`);
    await step('notes are independently selected and literal edits undo/redo', async () => {
      await regions();
      const count = await notes.count(); await click(s, 'Add note'); assert.equal(await notes.count(), count + 1);
      const first = await (await input()).inputValue();
      await click(s, 'Add note'); const second = await (await input()).inputValue(); assert.equal(await notes.count(), count + 2);
      const named = await identities();
      assert.equal(new Set(named).size, named.length, 'notes require distinct accessible identities');
      // "Add note creates a uniquely numbered note".
      const numbers = await notes.evaluateAll(nodes => nodes.map(n => ((n.getAttribute('aria-label') || '') + ' ' + n.textContent).match(/\d+/g) || []));
      for (const own of numbers.slice(count)) assert.ok(own.length, 'a new note carries no number');
      assert.notDeepEqual(numbers[count], numbers[count + 1], 'two new notes carry the same number');
      // "Selecting or focusing a note updates Inspector".
      await notes.nth(count).focus(); assert.equal(await (await input()).inputValue(), first, 'focusing a note did not show its text in the Inspector');
      await notes.nth(count + 1).focus(); assert.equal(await (await input()).inputValue(), second, 'focusing a note did not show its text in the Inspector');
      await (await input()).fill(noteText); await commit(await input());
      await written();
      // "a labelled Text field edits only that note".
      assert.equal((await identities())[count], named[count], 'editing the Text field changed a note that was not selected');
      // "An Export preview native dialog lists each note's text": literally, as the board does.
      await dialog(s, p, 'Export preview', async popup => {
        assert.ok((await said(popup)).includes(noteText), 'Export preview does not list the literal note text');
        assert.equal(await popup.locator('b').filter({hasText: 'literal'}).count(), 0, 'Export preview turned the note text into markup');
      });
      await click(s, 'Undo'); assert.equal(await (await input()).inputValue(), second); await click(s, 'Redo'); assert.equal(await (await input()).inputValue(), noteText);
      const had = await notes.count(); await click(s, 'Delete selected'); await erased();
      // "Delete selected removes only the selection".
      assert.ok((await identities()).includes(named[count]), 'Delete selected removed a note that was not selected');
      assert.equal(await notes.count(), had - 1, 'Delete selected did not remove exactly one note');
      await click(s, 'Undo'); await written();
      assert.equal(await notes.count(), had, 'Undo did not bring back exactly the deleted note');
      // "Undo/Redo restores add, edit, move and delete operations, including selection".
      assert.equal(await (await input()).inputValue(), noteText, 'Undo of Delete selected did not restore the selection');
      await click(s, 'Undo'); await click(s, 'Add note'); assert.equal(await button(s, 'Redo').isDisabled(), true);
    });
    await step('keyboard movement, coordinate export, capacity and history remain bounded', async () => {
      await regions();
      const exported = async () => {
        let seen = '';
        await dialog(s, p, 'Export preview', async popup => { seen = await said(popup); assert.match(seen, /\b\d+(?:\.\d+)?\b/, 'Export preview shows no number'); });
        return seen;
      };
      const digits = value => value.match(/\d+(?:\.\d+)?/g) || [];
      // "move a focused note within the artboard": press towards an edge until the note stops; it must
      // stay inside the surface that holds the notes. Forty presses bound the walk; a page with a very
      // small step may not reach the edge, and is then not judged on it. Returns the moves made.
      const walk = async key => {
        await notes.last().focus(); let moves = 0;
        for (let was = spot(await layout(), -1); moves < 40; moves++) {
          await p.keyboard.press(key); const state = await layout(), now = spot(state, -1);
          assert.ok(now.x >= -1 && now.y >= -1 && now.right <= state.width + 1 && now.bottom <= state.height + 1, 'an arrow key moved the focused note outside the artboard');
          if (Math.abs(now.x - was.x) < 0.5 && Math.abs(now.y - was.y) < 0.5) break;
          was = now;
        }
        return moves;
      };
      // "lists each note's text": a note's text is what the Inspector shows when it is focused.
      const texts = [];
      for (let i = 0, total = await notes.count(); i < total; i++) { await notes.nth(i).focus(); texts.push(await (await input()).inputValue()); }
      const still = await exported();
      for (const value of texts) assert.ok(still.includes(value), `Export preview omits the note "${value}"`);
      const node = notes.last(); await node.focus(); const before = await node.boundingBox(), placed = await layout();
      await p.keyboard.press('ArrowRight'); const moved = await node.boundingBox(); assert.ok(moved.x > before.x);
      // "Arrow keys move a focused note ... without changing other notes".
      const shifted = await layout(), mover = spot(placed, -1);
      for (const other of placed.notes.filter(note => note !== mover)) {
        const now = shifted.notes.find(note => note.id === other.id);
        assert.ok(now && Math.abs(now.x - other.x) <= 1 && Math.abs(now.y - other.y) <= 1, 'an arrow key moved a note that was not focused');
      }
      await click(s, 'Undo'); assert.ok(Math.abs((await node.boundingBox()).x - before.x) <= 1); await click(s, 'Redo');
      // "lists each note's text and coordinates": a digit of "Note 1" is not a coordinate. The listed
      // numbers must change when a note has moved, along either axis.
      await walk('ArrowRight');
      const right = await exported(); assert.notDeepEqual(digits(right), digits(still), 'Export preview coordinates did not follow a note moved right');
      assert.ok(await walk('ArrowDown') || await walk('ArrowUp'), 'the up and down arrow keys did not move the focused note');
      const down = await exported(); assert.notDeepEqual(digits(down), digits(right), 'Export preview coordinates did not follow a note moved up or down');
      // "maximum six": fill the board, counting the notes that are actually on it. At six the Add
      // control is either disabled or stays enabled and adds nothing; the brief asks for no message.
      for (let i = 0; i < 6 && await notes.count() < 6; i++) {
        const had = await notes.count(); assert.ok(await button(s, 'Add note').isEnabled(), `Add note is disabled with ${had} of six notes`);
        await click(s, 'Add note'); assert.equal(await notes.count(), had + 1, `Add note added nothing with ${had} of six notes`);
      }
      assert.equal(await notes.count(), 6, 'the board does not hold exactly six notes at its maximum');
      if (await button(s, 'Add note').isEnabled()) { await click(s, 'Add note'); assert.equal(await notes.count(), 6, 'a seventh note was added; the maximum is six'); }
      // "at least 20 retained actions": twenty moves, taking turns between two notes so that a page
      // which merges repeated moves of one note still records twenty actions, then twenty Undo
      // presses. Each Undo must take back exactly one move; the notes do not return by themselves.
      await notes.last().focus(); const origin = await notes.last().boundingBox();
      const turn = (await layout()).notes.slice(-2).map(note => note.id), trail = [];
      for (let i = 0; i < 20; i++) {
        let index = (await layout()).notes.findIndex(note => note.id === turn[i % 2]); if (index < 0) index = 4 + i % 2;
        await notes.nth(index).focus(); const from = spot(await layout(), index);
        let to = from;
        for (const key of i % 4 < 2 ? ['ArrowLeft', 'ArrowRight'] : ['ArrowRight', 'ArrowLeft']) {
          await p.keyboard.press(key); to = spot(await layout(), index); if (Math.abs(to.x - from.x) >= 0.5) break;
        }
        assert.ok(Math.abs(to.x - from.x) >= 0.5, 'an arrow key did not move the focused note');
        trail.push(from);
      }
      for (let i = 19; i >= 0; i--) {
        assert.ok(await button(s, 'Undo').isEnabled(), `Undo is disabled after ${19 - i} of 20 actions`);
        await click(s, 'Undo'); const back = (await layout()).notes.filter(note => note.id === trail[i].id);
        assert.ok(back.length === 1 && Math.abs(back[0].x - trail[i].x) <= 1 && Math.abs(back[0].y - trail[i].y) <= 1, `Undo ${20 - i} of 20 did not take back one move`);
      }
      assert.ok(Math.abs((await notes.last().boundingBox()).x - origin.x) <= 1, 'twenty actions did not restore initial coordinates');
      // "maximum 32 characters": typed like a user, so that a length limit on the field applies.
      await notes.last().focus(); await (await input()).fill(''); await (await input()).pressSequentially('x'.repeat(40)); await commit(await input());
      assert.ok(!(await said(board)).replace(/\s+/g, '').includes('x'.repeat(33)), 'a note shows more than 32 characters');
      await notes.first().focus(); await notes.last().focus();
      assert.ok((await (await input()).inputValue()).length <= 32, 'the Inspector shows a note text of more than 32 characters');
    });
  },
  async 'layer-order-visibility-history'(s, p, step) {
    let layers, board, objects;
    const regions = async () => { layers = await region(s, /^Layers$/i); board = await region(s, /poster|artboard/i); objects = visible(board.getByRole('button')); };
    const nameField = () => field(s, 'Object name');
    // The object of that name on the poster: its accessible name may add words ("Select Circle",
    // "Circle shape") but is not the name of another object ("Circle 2").
    const onPoster = name => visible(board.getByRole('button', {name: new RegExp('(?:^|[^\\w-])' + escape(name) + '(?![\\w-]|\\s*\\d)', 'i')}));
    const posterNames = () => objects.evaluateAll(nodes => nodes.map(n => (n.getAttribute('aria-label') || n.textContent.trim()).replace(/^Select\s+/i, '')));
    // The given names in the order in which a region or dialog renders them, by the position of the
    // rendered name itself. A longer name is matched first, so "Circle 2" is not also a "Circle".
    const sequence = (scope, names) => scope.evaluate((root, wanted) => {
      const found = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement; if (!parent || getComputedStyle(parent).visibility !== 'visible') continue;
        const value = node.nodeValue.toLowerCase(), taken = [];
        for (const name of [...wanted].sort((a, b) => b.length - a.length)) {
          const needle = name.toLowerCase();
          for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + needle.length)) {
            if (taken.some(([from, to]) => at < to && at + needle.length > from)) continue;
            taken.push([at, at + needle.length]);
            const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length);
            const box = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
            if (box) found.push({name, top: box.top, left: box.left});
          }
        }
      }
      found.sort((a, b) => Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left);
      return found.map(entry => entry.name).filter((name, index, all) => all.indexOf(name) === index);
    }, names);
    const reviewed = async names => {
      let seen;
      await dialog(s, p, 'Review layers', async popup => { seen = {text: (await popup.innerText()).replace(/\s+/g, ' ').trim(), order: await sequence(popup, names)}; });
      return seen;
    };
    // The dialog may list front to back or back to front; it must keep to one of them.
    const facing = (told, list) => told.join('|') === list.join('|') ? 'as listed' : told.join('|') === [...list].reverse().join('|') ? 'reversed' : '';
    // "Hide/Show toggles": the control of a hidden object is named Show, or it keeps the name Hide
    // and reports its pressed state, as a toggle button does.
    const reveal = async name => {
      let control = null;
      try { control = await itemAction(layers, 'Show', name); } catch { /* no control named Show */ }
      if (!control) { control = await itemAction(layers, 'Hide', name); assert.equal(await control.getAttribute('aria-pressed'), 'true', `the hidden object ${name} offers no Show control`); }
      await control.click();
    };
    // A pointer press on a part of the object that nothing else covers, where a user would aim.
    const press = async target => {
      await target.scrollIntoViewIfNeeded();
      const point = await target.evaluate(node => {
        const r = node.getBoundingClientRect(), own = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === node || node.contains(hit)); };
        for (let j = 1; j < 8; j++) for (let i = 1; i < 8; i++) {
          const x = r.left + r.width * i / 8, y = r.top + r.height * j / 8;
          if ([[0, 0], [-3, -3], [3, -3], [-3, 3], [3, 3]].every(([dx, dy]) => own(x + dx, y + dy)))
            return {x: x - r.left - (node.clientLeft || 0), y: y - r.top - (node.clientTop || 0)};
        }
        return null;
      });
      assert.ok(point, 'an object on the poster is completely covered');
      await target.click({position: point});
    };
    await step('layer selection, rename, visibility and delete preserve other objects', async () => {
      await regions(); await selectEntry(layers, 'Title');
      assert.equal(await (await nameField()).inputValue(), 'Title');
      await (await nameField()).fill('Local title'); const apply = button(s, /^(Apply|Save)(?: changes| name)?$/i); if (await apply.count()) await apply.click(); else await (await nameField()).blur();
      await shown(layers, 'Local title'); await shown(layers, 'Circle'); await click(s, 'Undo'); await shown(layers, 'Title'); await click(s, 'Redo'); await shown(layers, 'Local title');
      await artboardObject(board, 'Local title');
      // "Selecting an object in the artboard or Layers synchronizes Inspector".
      await press(await one(onPoster('Circle'), 'artboard object Circle'));
      assert.equal(await (await nameField()).inputValue(), 'Circle', 'selecting an object on the poster did not update the Inspector');
      await selectEntry(layers, 'Local title'); assert.equal(await (await nameField()).inputValue(), 'Local title', 'selecting a layer did not update the Inspector');
      const whole = await reviewed(['Local title', 'Circle']);
      await action(layers, 'Hide', 'Local title'); assert.equal(await visible(board.getByRole('button', {name: /Local title/})).count(), 0);
      // "Hide/Show toggles only that object without deleting it".
      assert.equal(await onPoster('Circle').count(), 1, 'Hide removed another object from the poster');
      await shown(layers, 'Local title');
      // "A Review layers native dialog reports the exact order, names and visibility": what it says
      // about a hidden object differs from what it says while the object is visible. The brief fixes
      // no wording, so none is required ("visible", "shown", "on", "hidden: no" all report it).
      const partly = await reviewed(['Local title', 'Circle']);
      assert.notEqual(partly.text, whole.text, 'Review layers reports the same visibility for a hidden object');
      await click(s, 'Undo'); await artboardObject(board, 'Local title');
      await action(layers, 'Delete', 'Local title'); await absent(layers, 'Local title'); await shown(layers, 'Circle'); await click(s, 'Undo'); await shown(layers, 'Local title');
      // Show, after Hide: the object returns, and both changes are undoable and redoable.
      await action(layers, 'Hide', 'Local title'); await reveal('Local title');
      assert.equal(await onPoster('Local title').count(), 1, 'Show did not bring the hidden object back');
      assert.notEqual((await reviewed(['Local title', 'Circle'])).text, partly.text, 'Review layers still reports a shown object as hidden');
      await click(s, 'Undo'); assert.equal(await onPoster('Local title').count(), 0, 'Undo did not take back Show');
      await click(s, 'Redo'); assert.equal(await onPoster('Local title').count(), 1, 'Redo did not repeat Show');
    });
    await step('reorder changes visible stacking, undo branches and six-object capacity', async () => {
      await regions();
      const pair = ['Local title', 'Circle'];
      const before = await layers.innerText(), beforePaint = await paintOrder(board), listed = await sequence(layers, pair), told = await reviewed(pair);
      assert.ok(facing(told.order, listed), 'Review layers does not list the layers in their order');
      const down = await itemAction(layers, 'Move layer down', 'Local title');
      await (await down.isEnabled() ? down : await itemAction(layers, 'Move layer up', 'Local title')).click();
      assert.notEqual(await layers.innerText(), before); assert.notDeepEqual(await paintOrder(board), beforePaint, 'only the Layers list moved, not actual artboard stacking');
      const swapped = await sequence(layers, pair); assert.deepEqual(swapped, [...listed].reverse(), 'the moved layer did not change places in the Layers list');
      let retold;
      await dialog(s, p, 'Review layers', async popup => { await shown(popup, /Local title/); await shown(popup, /Circle/); retold = await sequence(popup, pair); });
      assert.equal(facing(retold, swapped), facing(told.order, listed), 'Review layers did not follow the reorder');
      await click(s, 'Undo'); assert.equal(await layers.innerText(), before, 'Undo did not take back the reorder in the Layers list');
      assert.deepEqual(await paintOrder(board), beforePaint, 'Undo did not take back the reorder on the poster');
      // "maximum six total objects": count the objects that are actually on the poster. At six the Add
      // control is either disabled or stays enabled and adds nothing; the brief asks for no message.
      const had = await objects.count(); await click(s, 'Add shape');
      assert.equal(await objects.count(), had + 1, 'Add shape added nothing');
      assert.equal(await button(s, 'Redo').isDisabled(), true);
      for (let i = 0; i < 6 && await objects.count() < 6; i++) {
        const now = await objects.count(); assert.ok(await button(s, 'Add shape').isEnabled(), `Add shape is disabled with ${now} of six objects`);
        await click(s, 'Add shape'); assert.equal(await objects.count(), now + 1, `Add shape added nothing with ${now} of six objects`);
      }
      assert.equal(await objects.count(), 6, 'the poster does not hold exactly six objects at its maximum');
      // "Add shape adds distinct named shapes".
      const names = await posterNames();
      assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length, 'added shapes share a name');
      if (await button(s, 'Add shape').isEnabled()) { await click(s, 'Add shape'); assert.equal(await objects.count(), 6, 'a seventh object was added; the maximum is six'); }
      await click(s, 'Undo'); assert.equal(await button(s, 'Add shape').isEnabled(), true);
      assert.equal(await objects.count(), 5, 'Undo did not remove the last added shape');
      // "Move layer up/down changes actual visual stacking and list order": the other direction too.
      const kept = await posterNames(), low = await sequence(layers, kept), lowText = await layers.innerText(), lowPaint = await paintOrder(board);
      const raised = await (await itemAction(layers, 'Move layer up', 'Circle')).isEnabled() ? 'Circle' : 'Local title';
      const up = await itemAction(layers, 'Move layer up', raised); assert.ok(await up.isEnabled(), 'neither starting object can move up'); await up.click();
      assert.ok(await layers.innerText() !== lowText || (await sequence(layers, kept)).join('|') !== low.join('|'), 'Move layer up did not change the Layers list');
      assert.notDeepEqual(await paintOrder(board), lowPaint, 'Move layer up did not change the stacking on the poster');
      await (await itemAction(layers, 'Move layer down', raised)).click();
      assert.deepEqual(await sequence(layers, kept), low, 'Move layer down did not take back Move layer up in the Layers list');
      assert.deepEqual(await paintOrder(board), lowPaint, 'Move layer down did not take back Move layer up on the poster');
      // "undoable/redoable, with at least 20 actions": twenty visibility changes, then twenty Undo
      // presses, each of which must take back exactly one of them.
      const seen = async () => await onPoster('Circle').count() === 1;
      for (let i = 0; i < 20; i++) {
        if (i % 2) await reveal('Circle'); else await action(layers, 'Hide', 'Circle');
        assert.equal(await seen(), i % 2 === 1, i % 2 ? 'Show did not bring the hidden object back' : 'Hide did not hide the object');
      }
      for (let i = 19; i >= 0; i--) {
        assert.ok(await button(s, 'Undo').isEnabled(), `Undo is disabled after ${19 - i} of 20 actions`);
        await click(s, 'Undo'); assert.equal(await seen(), i % 2 === 0, `Undo ${20 - i} of 20 did not take back one visibility change`);
      }
    });
  },
};

export async function exerciseDesignProject(caseSpec, scope, page, step) {
  const scenario = designProjectScenarios[caseSpec.interaction];
  assert.equal(typeof scenario, 'function', `No interaction oracle for ${caseSpec.interaction}`);
  await scenario(scope, page, step);
}
