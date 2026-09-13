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
async function field(scope, name) {
  const options = {name, exact: typeof name === 'string'};
  // A select nested in its label can have the correct accessible name while
  // getByLabel's label-text matching includes its option text. Use the actual
  // control name too; the union deduplicates one control, not distinct fields.
  let controls = scope.getByLabel(name, {exact: options.exact});
  for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio'])
    controls = controls.or(scope.getByRole(role, options));
  return one(visible(controls), `field ${name}`);
}
async function item(scope, title) {
  const rows = visible(scope.locator('article,li,tr,[role="row"],[role="listitem"],[role="group"]'))
    .filter({has: text(scope, title)});
  // Prefer the innermost semantic item, never a containing list with other rows.
  const leaves = rows.filter({hasNot: rows});
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
  return click(scope, label);
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
    await step('draft edits across tabs can be cancelled without changing saved values', async () => {
      await choose(s, 'Basics'); assert.equal(await (await field(s, 'Project name')).inputValue(), 'Studio notes');
      await (await field(s, 'Project name')).fill('Draft only'); await choose(s, 'Notifications');
      const digest = await field(s, /daily digest/i), alerts = await field(s, /comment alerts/i);
      assert.equal(await digest.isChecked(), true); assert.equal(await alerts.isChecked(), false);
      await digest.uncheck(); await alerts.check(); await click(s, 'Cancel changes');
      assert.equal(await digest.isChecked(), true); assert.equal(await alerts.isChecked(), false);
      await choose(s, 'Basics'); assert.equal(await (await field(s, 'Project name')).inputValue(), 'Studio notes');
    });
    await step('invalid name is focused, review gives before/after and save commits once', async () => {
      const name = await field(s, 'Project name'); await name.fill('');
      if (await button(s, 'Save changes').isEnabled()) await click(s, 'Save changes');
      assert.equal(await name.evaluate(e => e === e.ownerDocument.activeElement), true);
      assert.ok(await name.evaluate(e => !e.validity.valid || e.getAttribute('aria-invalid') === 'true'), 'required field must expose invalidity');
      await name.fill('x'.repeat(41));
      if ((await name.inputValue()).length > 40) {
        if (await button(s, 'Save changes').isEnabled()) await click(s, 'Save changes');
        assert.ok(await name.evaluate(e => !e.validity.valid || e.getAttribute('aria-invalid') === 'true'));
      }
      await name.fill('Small studio');
      await dialog(s, p, 'Review changes', async popup => { await shown(popup, /Studio notes/); await shown(popup, /Small studio/); });
      await click(s, 'Save changes'); assert.equal(await button(s, 'Save changes').isDisabled(), true);
      await name.fill('Uncommitted'); await click(s, 'Cancel changes'); assert.equal(await name.inputValue(), 'Small studio');
    });
  },
  async 'room-wizard-validation'(s, p, step) {
    await step('capacity changes invalidate, but do not replace, the entered count', async () => {
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      await choose(s, 'Birch', /Room/i); await click(s, /^Continue\b/i);
      await choose(s, '14:00', /Time/i); await (await field(s, /participant/i)).fill('7'); await click(s, /^Continue\b/i);
      await assertText(s, /Birch/); await assertText(s, /14:00/); await assertText(s, /\b7\b/);
      await click(s, /^Back\b/i); await click(s, /^Back\b/i); await choose(s, 'Cedar', /Room/i); await click(s, /^Continue\b/i);
      assert.equal(await (await field(s, /participant/i)).inputValue(), '7'); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      for (const value of ['0', '1.5']) { await (await field(s, /participant/i)).fill(value); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true); }
      await (await field(s, /participant/i)).fill('4'); await click(s, /^Continue\b/i); await assertText(s, /Cedar/); await assertText(s, /\b4\b/);
    });
    await step('confirmation is a local demo and Start over resets choices', async () => {
      await click(s, /^Confirm\b/i); await shown(s, /No room was booked/); await click(s, 'Start over');
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
    });
  },
  async 'workshop-journey'(s, p, step) {
    await step('radio keyboard selection admits the day step only after a choice', async () => {
      assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      const choices = visible(s.getByRole('radio')); assert.equal(await choices.count(), 3);
      await choices.first().focus(); await p.keyboard.press('Space'); await p.keyboard.press('ArrowDown');
      assert.equal(await s.getByRole('radio', {name: /^Bicycle care\b/i}).isChecked(), true);
      await click(s, /^Continue\b/i); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
    });
    await step('day selection, Back and review preserve exact choices', async () => {
      await s.getByRole('radio', {name: /^Thursday\b/i}).check(); await click(s, /^Continue\b/i);
      await shown(s, /Bicycle care/); await shown(s, /Thursday/);
      await click(s, /^Back\b/i); assert.equal(await s.getByRole('radio', {name: /^Thursday\b/i}).isChecked(), true);
      await click(s, /^Back\b/i); assert.equal(await s.getByRole('radio', {name: /^Bicycle care\b/i}).isChecked(), true);
      await click(s, /^Continue\b/i); await click(s, /^Continue\b/i);
    });
    await step('confirmation and restart are real state transitions', async () => {
      const before = await readText(s); await click(s, /^(Confirm|Complete|Finish)\b/i);
      await shown(s, /No booking was made/); assert.notEqual(await readText(s), before, 'confirmation did not change the interface');
      await click(s, /^Start again\b/i); assert.equal(await button(s, /^Continue\b/i).isDisabled(), true);
      assert.equal(await visible(s.getByRole('radio', {checked: true})).count(), 0);
    });
  },
  async 'tool-shortlist-limits'(s, p, step) {
    await step('category and search combine and recover', async () => {
      await choose(s, 'Garden', /category/i); await search(s, 'drill'); await absent(s, 'Hand drill'); await absent(s, 'Garden fork');
      await assertText(s, /no (?:tools|results|matches)/i); await search(s, ''); await shown(s, 'Garden fork'); await choose(s, 'All', /category/i);
    });
    await step('two-item bound, dialog removal and visible count remain synchronized', async () => {
      await action(s, 'Add to shortlist', 'Hand drill'); await action(s, 'Add to shortlist', 'Sewing kit');
      const third = button(await item(s, 'Garden fork'), /^Add to shortlist\b/i);
      if (await third.isEnabled()) await third.click();
      await assertText(s, /(?:maximum|max|limit|up to|only|two|2).*(?:two|2|tools|shortlist)/i);
      await dialog(s, p, 'Review shortlist', async popup => {
        await shown(popup, 'Hand drill'); await shown(popup, 'Sewing kit'); await absent(popup, 'Garden fork'); await action(popup, 'Remove', 'Hand drill'); await absent(popup, 'Hand drill');
      });
      await action(s, 'Add to shortlist', 'Garden fork');
      await dialog(s, p, 'Review shortlist', async popup => {
        await shown(popup, 'Sewing kit'); await shown(popup, 'Garden fork'); await absent(popup, 'Hand drill');
        await click(popup, /request/i); await shown(popup, /No borrowing request was sent/);
      });
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
    await step('literal reply belongs to one thread and survives return to feed', async () => {
      await search(s, 'Weekend'); await shown(s, 'Weekend swap'); await absent(s, 'Quiet recommendations'); await search(s, '');
      await selectEntry(s, 'What are you reading?'); const reply = await field(s, /^Reply$/i);
      await reply.fill(''); const post = button(s, /^(Post|Add) reply$/i); if (await post.isEnabled()) await post.click();
      await reply.fill(noteText); await post.click(); await literal(s, noteText);
      await click(s, /^(?:Back to|All) (?:threads|feed|discussions)$/i); await withinText(await item(s, 'What are you reading?'), /1 repl(?:y|ies)/i);
      await selectEntry(s, 'Weekend swap'); await absent(s, noteText);
      await (await field(s, /^Reply$/i)).fill('Different thread reply'); await click(s, /^(Post|Add) reply$/i);
      await click(s, /^(?:Back to|All) (?:threads|feed|discussions)$/i); await selectEntry(s, 'What are you reading?'); await literal(s, noteText); await absent(s, 'Different thread reply');
    });
    await step('follow/unfollow is thread-specific and profile dialog is operable', async () => {
      await click(s, 'Follow'); await click(s, /^(?:Back to|All) (?:threads|feed|discussions)$/i); await choose(s, 'Following');
      await shown(s, 'What are you reading?'); await absent(s, 'Weekend swap'); await selectEntry(s, 'What are you reading?'); await click(s, 'Unfollow');
      const author = button(s, /profile|author/i); const name = await (await one(author, 'author profile')).getAttribute('aria-label') || await author.innerText();
      await dialog(s, p, exact(name), popup => shown(popup, /profile|member|joined/i));
    });
  },
  async 'review-reason-and-undo'(s, p, step) {
    await step('required reason, resolved filtering and literal reason belong to one report', async () => {
      await selectEntry(s, 'Missing event details'); await (await field(s, 'Reason')).fill(''); assert.equal(await button(s, 'Resolve').isDisabled(), true);
      await (await field(s, 'Reason')).fill(noteText); await click(s, 'Resolve'); await choose(s, 'Resolved');
      await shown(s, 'Missing event details'); await absent(s, 'Duplicate introduction'); await selectEntry(s, 'Missing event details');
      await dialog(s, p, 'Details', async popup => { await shown(popup, /Missing event details/); await literal(popup, noteText); });
      await click(s, 'Undo resolution'); await choose(s, 'Pending');
      for (const name of ['Missing event details', 'Duplicate introduction', 'Broken resource link']) await shown(s, name);
      await selectEntry(s, 'Duplicate introduction'); assert.equal(await (await field(s, 'Reason')).inputValue(), '');
    });
  },
  async 'map-list-selection-filter'(s, p, step) {
    await step('map/list selection is synchronized; filtering clears stale details', async () => {
      const map = await region(s, /map/i), list = await region(s, /places/i);
      await action(map, 'Select', 'Paper house'); const details = await region(s, /details/i); await shown(details, 'Paper house');
      await selectEntry(list, 'North garden'); await shown(details, 'North garden');
      await choose(s, 'Indoors'); await absent(list, 'North garden'); await absent(map, /North garden/); await absent(details, 'North garden'); await shown(list, 'Paper house');
      await selectEntry(list, 'Paper house'); await dialog(s, p, 'Place notes', popup => shown(popup, /Paper house/));
      await search(s, 'River'); await shown(s, 'No places found'); await absent(list, 'Paper house');
      await click(s, 'Clear filters'); for (const name of ['North garden', 'Paper house', 'River steps']) await shown(list, name);
      for (const name of ['North garden', 'Paper house', 'River steps']) { await selectEntry(list, name); await shown(details, name); }
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
