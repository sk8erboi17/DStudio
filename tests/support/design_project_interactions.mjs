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
  const heading = visible(popup.getByRole('columnheader', {name: exact(name)}));
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
    await step('unique queue, actual order and current identity survive reordering', async () => {
      const library = await region(s, /library/i);
      for (const title of ['Night lines', 'Paper satellites', 'Second sunrise']) await action(library, 'Add to queue', title);
      const queue = await region(s, /^(?:Listening )?queue$/i);
      await ordered(queue, ['Night lines', 'Paper satellites', 'Second sunrise']);
      await selectEntry(queue, 'Paper satellites'); await withinText(await item(queue, 'Paper satellites'), /Current/);
      await action(queue, 'Move up', 'Paper satellites'); await ordered(queue, ['Paper satellites', 'Night lines', 'Second sunrise']);
      await withinText(await item(queue, 'Paper satellites'), /Current/);
      await dialog(s, p, 'Queue details', popup => ordered(popup, ['Paper satellites', 'Night lines', 'Second sunrise']));
      await action(queue, 'Move down', 'Paper satellites'); await ordered(queue, ['Night lines', 'Paper satellites', 'Second sunrise']);
      await action(queue, 'Remove', 'Paper satellites'); await absent(queue, 'Paper satellites');
      const current = await queue.innerText(); assert.doesNotMatch(current, /Current\s*:?\s*Paper satellites|Paper satellites\s*Current/i);
    });
    await step('clear leaves an honest empty demo, not audio playback', async () => {
      await click(s, 'Clear queue'); await dialog(s, p, 'Queue details', async popup => { await absent(popup, 'Night lines'); await shown(popup, /empty|no tracks/i); });
      await shown(s, /No audio playback in this demo/);
    });
  },
  async 'schedule-conflicts'(s, p, step) {
    await step('conflicting session is rejected without replacing saved choice', async () => {
      await action(s, 'Add to my day', 'Sound walks');
      const conflicting = button(await item(s, 'Poster room'), /^Add to my day\b/i);
      if (await conflicting.isEnabled()) await conflicting.click();
      await assertText(s, /conflict|same time|already.*10:00/i);
      await action(s, 'Add to my day', 'Light studies');
      await dialog(s, p, 'Review my day', async popup => { await ordered(popup, ['Sound walks', 'Light studies']); await absent(popup, 'Poster room'); });
      await choose(s, 'Afternoon'); await absent(s, 'Sound walks'); await shown(s, 'Light studies'); await choose(s, 'All');
      await action(s, 'Remove', 'Sound walks'); await action(s, 'Add to my day', 'Poster room');
      await dialog(s, p, 'Review my day', async popup => { await ordered(popup, ['Poster room', 'Light studies']); await absent(popup, 'Sound walks'); });
    });
    await step('removal empties the day and finish does not claim real reservations', async () => {
      await action(s, 'Remove', 'Poster room'); await action(s, 'Remove', 'Light studies');
      await dialog(s, p, 'Review my day', popup => shown(popup, /empty|no sessions/i));
      await click(s, 'Finish demo'); await shown(s, /No tickets were reserved/);
    });
  },
  async 'catalog-compare-price-order'(s, p, step) {
    await step('size/search combine; price sort changes rendered product order', async () => {
      await choose(s, 'Small', /Size/i); await search(s, 'wrap'); for (const name of ['Pocket strap', 'Canvas wrap', 'Lens pouch']) await absent(s, name);
      await search(s, ''); await shown(s, 'Pocket strap'); await shown(s, 'Lens pouch'); await choose(s, 'All', /Size/i);
      await choose(s, 'Low to high', /Sort by price/i); await ordered(s, ['Pocket strap', 'Lens pouch', 'Canvas wrap']);
      await choose(s, 'High to low', /Sort by price/i); await ordered(s, ['Canvas wrap', 'Lens pouch', 'Pocket strap']);
    });
    await step('compare keeps two exact products and dialog removal updates selection', async () => {
      const toggle = async name => {
        const row = await item(s, name), choice = visible(row.getByRole('checkbox', {name: /^Compare/i}));
        if (await choice.count()) { if (await choice.isEnabled()) await choice.click(); }
        else { const control = button(row, /^Compare\b/i); if (await control.isEnabled()) await control.click(); }
      };
      await toggle('Pocket strap'); await toggle('Canvas wrap'); await toggle('Lens pouch');
      await assertText(s, /(?:two|2).*(?:products|compare)|compare.*(?:two|2)|limit/i);
      await dialog(s, p, 'Compare selected', async popup => {
        for (const [name, price, size] of [['Pocket strap', 18, 'Small'], ['Canvas wrap', 32, 'Large']]) {
          const values = await comparedProduct(popup, name);
          assert.match(values, new RegExp('(?:€\\s*' + price + '|' + price + '\\s*€)')); assert.match(values, new RegExp('\\b' + size + '\\b'));
        }
        await absent(popup, 'Lens pouch'); await action(popup, 'Remove', 'Pocket strap'); await absent(popup, 'Pocket strap');
      });
      await toggle('Lens pouch'); await dialog(s, p, 'Compare selected', async popup => { await shown(popup, 'Lens pouch'); await shown(popup, 'Canvas wrap'); await absent(popup, 'Pocket strap'); });
    });
  },
  async 'variant-basket-totals'(s, p, step) {
    await step('variant unit prices, quantities and merge identity determine exact totals', async () => {
      await choose(s, 'Chalk', /colou?r|finish/i); await (await field(s, /Long cable/i)).check(); await (await field(s, /^Quantity$/i)).fill('2');
      const config = await region(s, /configuration|configure.*lamp/i); await withinText(config, /(?:€\s*68|68\s*€)/); await withinText(config, /(?:€\s*136|136\s*€)/);
      await click(s, 'Add to basket'); await click(s, 'Add to basket');
      await choose(s, 'Ink', /colou?r|finish/i); await (await field(s, /Long cable/i)).uncheck(); await (await field(s, /^Quantity$/i)).fill('1'); await click(s, 'Add to basket');
      const basket = await region(s, /^Basket$/i); await withinText(basket, /(?:€\s*337|337\s*€)/);
      await dialog(s, p, 'Review order', async popup => { await shown(popup, /Chalk/); await shown(popup, /Ink/); await withinText(popup, /(?:€\s*337|337\s*€)/); });
      await choose(s, 'Chalk', /colou?r|finish/i); await (await field(s, /Long cable/i)).check();
      const add = button(s, 'Add to basket'); if (await add.isEnabled()) await add.click();
      await withinText(basket, /(?:€\s*337|337\s*€)/); await assertText(s, /(?:maximum|max|limit|up to|four|4).*(?:four|4|units|variant)/i);
    });
    await step('basket quantity changes/removal recalculate independently; confirmation is local only', async () => {
      const basket = await region(s, /^Basket$/i);
      const ink = await item(basket, /Ink/);
      await click(ink, /^\+$|increase|add one/i); await withinText(basket, /(?:€\s*402|402\s*€)/);
      await click(ink, /^[-−]$|decrease|remove one/i); await withinText(basket, /(?:€\s*337|337\s*€)/);
      await click(await item(basket, /Chalk/), /^Remove\b/i); await withinText(basket, /(?:€\s*65|65\s*€)/); await absent(basket, /Chalk/);
      await dialog(s, p, 'Review order', async popup => { await click(popup, /^(Confirm|Complete|Finish|Place)\b/i); await shown(s, /No order was placed/); });
    });
    await step('clear basket removes all variants and restores empty state', async () => {
      await click(s, 'Clear basket'); const basket = await region(s, /^Basket$/i);
      await withinText(basket, /empty|no items/i); await absent(basket, /Chalk/); await absent(basket, /Ink/);
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
    await step('route order survives filtering; map path changes on reorder/removal', async () => {
      const places = await region(s, /available places/i), route = await region(s, /^(?:Your )?(?:route|itinerary)$/i), map = await region(s, /map/i);
      const names = ['Old kiosk', 'Glass hall', 'Willow court', 'East steps'];
      for (const name of names) await action(places, 'Add stop', name);
      await ordered(route, names);
      const strokes = () => map.locator('svg path,svg polyline,svg line').evaluateAll(nodes => nodes.filter(e => {
        const r = e.getBoundingClientRect(); return r.width > 1 || r.height > 1;
      }).map(e => ({tag: e.tagName, d: e.getAttribute('d'), points: e.getAttribute('points'), x1: e.getAttribute('x1'), y1: e.getAttribute('y1'), x2: e.getAttribute('x2'), y2: e.getAttribute('y2')})));
      const before = await strokes(); assert.ok(before.length, 'no visible schematic route');
      await search(s, 'Old'); await ordered(route, names); await search(s, '');
      await action(route, 'Move up', 'Glass hall'); await ordered(route, ['Glass hall', 'Old kiosk', 'Willow court', 'East steps']);
      assert.notDeepEqual(await strokes(), before, 'map connecting path did not change with the route');
      await dialog(s, p, 'Review route', popup => ordered(popup, ['Glass hall', 'Old kiosk', 'Willow court', 'East steps']));
      const reordered = await strokes(); await action(route, 'Remove', 'Old kiosk'); assert.notDeepEqual(await strokes(), reordered, 'removed stop remains in connecting path');
      await click(s, 'Reset route'); await withinText(route, /empty|no stops|add.*stop/i); for (const name of names) await absent(route, name);
    });
  },
  async 'object-selection-edit-history'(s, p, step) {
    await step('notes are independently selected and literal edits undo/redo', async () => {
      const board = await region(s, /artboard/i), notes = visible(board.getByRole('button'));
      const count = await notes.count(); await click(s, 'Add note'); assert.equal(await notes.count(), count + 1);
      await click(s, 'Add note'); const second = await (await field(s, 'Text')).inputValue(); assert.equal(await notes.count(), count + 2);
      const identities = await notes.evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') || n.textContent.trim()));
      assert.equal(new Set(identities).size, identities.length, 'notes require distinct accessible identities');
      await (await field(s, 'Text')).fill(noteText); const apply = button(s, /^(Apply|Save)(?: changes| text)?$/i); if (await apply.count()) await apply.click(); else await (await field(s, 'Text')).blur();
      await literal(board, noteText);
      await click(s, 'Undo'); assert.equal(await (await field(s, 'Text')).inputValue(), second); await click(s, 'Redo'); assert.equal(await (await field(s, 'Text')).inputValue(), noteText);
      await click(s, 'Delete selected'); await absent(board, noteText); await click(s, 'Undo'); await literal(board, noteText);
      await click(s, 'Undo'); await click(s, 'Add note'); assert.equal(await button(s, 'Redo').isDisabled(), true);
    });
    await step('keyboard movement, coordinate export, capacity and history remain bounded', async () => {
      const board = await region(s, /artboard/i); const notes = visible(board.getByRole('button'));
      const node = notes.last(); await node.focus(); const before = await node.boundingBox(); await p.keyboard.press('ArrowRight'); const moved = await node.boundingBox(); assert.ok(moved.x > before.x);
      await click(s, 'Undo'); assert.ok(Math.abs((await node.boundingBox()).x - before.x) <= 1); await click(s, 'Redo');
      await dialog(s, p, 'Export preview', popup => withinText(popup, /\b\d+(?:\.\d+)?\b/));
      while (await button(s, 'Add note').isEnabled() && await notes.count() < 8) await click(s, 'Add note');
      assert.equal(await notes.count(), 6); assert.equal(await button(s, 'Add note').isDisabled(), true);
      await notes.last().focus(); const origin = await notes.last().boundingBox();
      for (let i = 0; i < 20; i++) await p.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight');
      for (let i = 0; i < 20; i++) await click(s, 'Undo');
      assert.ok(Math.abs((await notes.last().boundingBox()).x - origin.x) <= 1, 'twenty actions did not restore initial coordinates');
    });
  },
  async 'layer-order-visibility-history'(s, p, step) {
    await step('layer selection, rename, visibility and delete preserve other objects', async () => {
      const layers = await region(s, /^Layers$/i); await selectEntry(layers, 'Title');
      assert.equal(await (await field(s, 'Object name')).inputValue(), 'Title');
      await (await field(s, 'Object name')).fill('Local title'); const apply = button(s, /^(Apply|Save)(?: changes| name)?$/i); if (await apply.count()) await apply.click(); else await (await field(s, 'Object name')).blur();
      await shown(layers, 'Local title'); await shown(layers, 'Circle'); await click(s, 'Undo'); await shown(layers, 'Title'); await click(s, 'Redo'); await shown(layers, 'Local title');
      const board = await region(s, /poster|artboard/i); await artboardObject(board, 'Local title');
      await action(layers, 'Hide', 'Local title'); assert.equal(await visible(board.getByRole('button', {name: /Local title/})).count(), 0);
      await shown(layers, 'Local title'); await click(s, 'Undo'); await artboardObject(board, 'Local title');
      await action(layers, 'Delete', 'Local title'); await absent(layers, 'Local title'); await shown(layers, 'Circle'); await click(s, 'Undo'); await shown(layers, 'Local title');
    });
    await step('reorder changes visible stacking, undo branches and six-object capacity', async () => {
      const layers = await region(s, /^Layers$/i), board = await region(s, /poster|artboard/i);
      const before = await layers.innerText(), beforePaint = await paintOrder(board);
      const down = await itemAction(layers, 'Move layer down', 'Local title');
      await (await down.isEnabled() ? down : await itemAction(layers, 'Move layer up', 'Local title')).click();
      assert.notEqual(await layers.innerText(), before); assert.notDeepEqual(await paintOrder(board), beforePaint, 'only the Layers list moved, not actual artboard stacking');
      await dialog(s, p, 'Review layers', async popup => { await shown(popup, /Local title/); await shown(popup, /Circle/); await shown(popup, /visible|shown/i); });
      await click(s, 'Undo'); assert.equal(await layers.innerText(), before); assert.deepEqual(await paintOrder(board), beforePaint);
      await click(s, 'Add shape'); assert.equal(await button(s, 'Redo').isDisabled(), true);
      let count = 3; while (await button(s, 'Add shape').isEnabled() && count < 8) { await click(s, 'Add shape'); count++; }
      assert.equal(count, 6); assert.equal(await button(s, 'Add shape').isDisabled(), true);
      await click(s, 'Undo'); assert.equal(await button(s, 'Add shape').isEnabled(), true);
    });
  },
};

export async function exerciseDesignProject(caseSpec, scope, page, step) {
  const scenario = designProjectScenarios[caseSpec.interaction];
  assert.equal(typeof scenario, 'function', `No interaction oracle for ${caseSpec.interaction}`);
  await scenario(scope, page, step);
}
