// Browser operations on the sixteen supplied original packs. No inference,
// clipboard mutation, external requests or source-inspection assertions.
import assert from 'node:assert/strict';
export const additionalDesignIds = [
  'ledger','relay','docket','tempo','transit','hearth','manual','larder',
  'depot','roster','pipeline','tally','letter','datasheet','walkthrough','counter',
];

export async function exerciseAdditionalDesign(id, s, page, {limits=false}={}) {
  const text = q => s.locator(q).textContent();
  const literal='<b>Local text</b> & a second value';
  switch(id) {
  case 'ledger': {
    const old=await text('#ledger-cleared');
    await s.locator('#ledger-category').selectOption('groceries');
    assert.equal(await s.locator('#ledger-book li:visible').count(),3);
    assert.equal(await text('#ledger-count'),'Showing 3 of 10 entries');
    const box=s.getByRole('checkbox',{name:'Reconciled: Corner Grocer, 18 Oct',exact:true});
    await box.check();assert.notEqual(await text('#ledger-cleared'),old);
    assert.match(await text('#ledger-recon'),/^2 entries still/);
    await box.uncheck();assert.equal(await text('#ledger-cleared'),old);
    await s.locator('#ledger-category').selectOption('all');
    assert.equal(await s.locator('#ledger-book li:visible').count(),10);break;
  }
  case 'relay': {
    await s.locator('#rl-search').fill('nothing-matches');
    assert.equal(await s.locator('#rl-convos li').count(),0);
    assert.equal(await s.locator('#rl-empty').isVisible(),true);
    await s.locator('#rl-search').fill('');
    await s.getByRole('button',{name:/^Open conversation with Jonas Weber/}).click();
    assert.equal(await text('#rl-title'),'Jonas Weber');
    const count=await s.locator('#rl-transcript .msg').count();
    await s.locator('#rl-compose button[type=submit]').click();
    assert.equal(await s.locator('#rl-transcript .msg').count(),count);
    assert.equal(await s.locator('#rl-text').getAttribute('aria-invalid'),'true');
    if(limits){
      const tooLong='x'.repeat(1001),before=await text('#rl-transcript');
      await s.locator('#rl-text').fill(tooLong);await s.locator('#rl-compose button[type=submit]').click();
      assert.equal(await text('#rl-transcript'),before);
      assert.equal(await s.locator('#rl-text').inputValue(),tooLong,'oversized reply retains its draft');
      assert.match(await text('#rl-error'),/1000/);
    }
    await s.locator('#rl-text').fill(literal);
    await s.locator('#rl-compose button[type=submit]').click();
    assert.equal(await s.locator('#rl-transcript .msg-body').last().textContent(),literal);
    assert.equal(await s.locator('#rl-transcript .msg-body b').count(),0);
    await s.locator('#rl-mark').click();assert.match(await text('#rl-count'),/1 unread/);
    await s.getByRole('button',{name:/^Open conversation with Mira Okafor/}).click();
    assert.equal(await s.locator('#rl-transcript .msg-body').filter({hasText:literal}).count(),0);
    await s.getByRole('button',{name:/^Open conversation with Jonas Weber/}).click();
    assert.equal(await s.locator('#rl-transcript .msg-body').last().textContent(),literal);
    if(limits){
      for(let i=1;i<20;i++){await s.locator('#rl-text').fill('Reply '+i);await s.locator('#rl-compose button[type=submit]').click();}
      const before=await text('#rl-transcript');
      await s.locator('#rl-text').fill('Keep this draft');await s.locator('#rl-compose button[type=submit]').click();
      assert.equal(await text('#rl-transcript'),before,'reply admission preserves earlier content');
      assert.equal(await s.locator('#rl-text').inputValue(),'Keep this draft');
      assert.match(await text('#rl-error'),/20/);
    }break;
  }
  case 'docket': {
    await s.locator('input[name=dk-status][value=doing]').check();
    assert.match(await text('#lane-doing'),/3 of 3.*full/);
    await s.getByRole('button',{name:'Book the print slot',exact:true}).click();
    assert.equal(await s.locator('input[name=dk-status][value=doing]').isDisabled(),true);
    assert.equal(await s.locator('input[name=dk-status][value=todo]').isChecked(),true);
    await s.locator('#dk-check input').first().check();assert.match(await text('#dk-progress'),/^1 of 2/);
    await s.getByRole('button',{name:'Proof the cover copy',exact:true}).click();
    await s.locator('input[name=dk-status][value=done]').check();
    await s.getByRole('button',{name:'Book the print slot',exact:true}).click();
    assert.equal(await s.locator('input[name=dk-status][value=doing]').isEnabled(),true);
    assert.equal(await s.locator('#dk-check input').first().isChecked(),true);break;
  }
  case 'tempo': {
    await s.getByRole('button',{name:'Play Last Train Home',exact:true}).click();
    assert.equal(await text('#tp-now'),'Last Train Home');
    await s.locator('#tp-next').click();assert.equal(await text('#tp-now'),'Last Train Home');
    assert.match(await text('#tp-status'),/End of the album/);
    await s.locator('#tp-repeat').click();await s.locator('#tp-next').click();
    assert.equal(await text('#tp-now'),'Low Light');
    await s.locator('#tp-seek').focus();await page.keyboard.press('End');
    assert.equal(await text('#tp-elapsed'),'3:34');
    await s.locator('#tp-prev').click();assert.equal(await text('#tp-elapsed'),'0:00');
    await s.locator('#tp-play').click();assert.equal(await text('#tp-play-label'),'Play');
    await s.locator('#tp-volume').focus();await page.keyboard.press('End');
    assert.equal(await text('#tp-volume-out'),'10 of 10');break;
  }
  case 'transit': {
    const before=await text('#tr-detail-title'),from=await s.locator('#tr-from').inputValue(),to=await s.locator('#tr-to').inputValue();
    await s.locator('#tr-to').fill(from);await s.locator('#tr-form button[type=submit]').click();
    assert.equal(await text('#tr-detail-title'),before);assert.equal(await s.locator('#tr-error').isVisible(),true);
    await s.locator('#tr-to').fill(to);await s.locator('#tr-swap').click();
    assert.equal(await text('#tr-route-from'),to);assert.equal(await text('#tr-route-to'),from);
    await s.locator('#tr-journeys button').nth(1).click();
    assert.match(await text('#tr-detail-sub'),/31 min.*4 min late/);
    const fare=s.locator('input[name=tr-fare]').last();await fare.check();
    assert.equal(await text('#tr-total'),'€'+(Number(await fare.inputValue())/100).toFixed(2));break;
  }
  case 'hearth': {
    const lamp=s.getByRole('switch',{name:'Floor lamp',exact:true});await lamp.click();
    assert.equal(await lamp.getAttribute('aria-checked'),'false');assert.equal(await s.locator('#dim-lamp').isVisible(),false);
    await s.locator('[data-room=kitchen]').click();await s.locator('[data-room=living]').click();
    assert.equal(await lamp.getAttribute('aria-checked'),'false');await lamp.click();
    await s.locator('#dim-lamp').focus();await page.keyboard.press('End');
    assert.match(await s.locator('#ht-devices .device').filter({hasText:'Floor lamp'}).textContent(),/100% brightness/);
    for(let i=0;i<6;i++)await s.locator('#ht-raise').press('Enter');
    assert.equal(await text('#ht-target'),'24.0');await s.locator('#ht-raise').press('Enter');
    assert.equal(await text('#ht-target'),'24.0');assert.match(await text('#ht-msg'),/highest/);
    await s.locator('input[name=ht-scene][value=away]').check();await s.locator('[data-room=bedroom]').click();
    assert.equal(await text('#ht-target'),'16.0');
    assert.equal(await s.locator('#ht-devices [role=switch][aria-checked=true]').count(),1,'scene preserves non-light sockets');break;
  }
  case 'manual': {
    await s.locator('[data-lang=py]').click();assert.match(await text('#mn-code'),/import os, requests/);
    await s.locator('#mn-select').click();
    assert.equal(await s.locator('body').evaluate(()=>window.getSelection().toString()),await text('#mn-code'));
    assert.match(await text('#mn-code-status'),/Code selected/);
    await s.locator('#mn-search').fill('nothing-matches');
    assert.equal(await s.locator('#mn-nav-list li:visible').count(),0);
    assert.match(await text('#mn-nav-count'),/No section matches/);
    await s.locator('#mn-search').fill('');assert.ok(await s.locator('#mn-nav-list li:visible').count()>1);
    await s.locator('[data-useful=yes]').click();assert.match(await text('#mn-feedback'),/nothing was sent/);break;
  }
  case 'larder': {
    await s.locator('#ld-list input').first().check();
    await s.locator('#ld-more').click();assert.equal(await text('#ld-servings'),'5');
    assert.match(await s.locator('#ld-list li').first().textContent(),/500 g/);
    assert.equal(await s.locator('#ld-list input').first().isChecked(),true);
    await s.getByRole('checkbox',{name:'Step 1 done',exact:true}).check();
    assert.match(await text('#ld-progress'),/1 of 6.*step 2/);
    await s.getByRole('checkbox',{name:'Step 1 done',exact:true}).uncheck();
    assert.match(await text('#ld-progress'),/0 of 6.*step 1/);
    if(limits){for(let i=0;i<10;i++)await s.locator('#ld-more').press('Enter');
      assert.equal(await text('#ld-servings'),'12');assert.match(await text('#ld-serv-msg'),/largest/);
    }break;
  }
  case 'depot': {
    await s.locator('#dp-search').fill('nothing-matches');assert.equal(await s.locator('#dp-list li').count(),0);
    await s.locator('#dp-search').fill('');await s.locator('#dp-show').selectOption('attention');
    assert.equal(await s.locator('#dp-list li').count(),3);
    const before=await text('#dp-onhand'),history=await text('#dp-moves');
    for(const bad of ['-13','999999999999999999999']){
      await s.locator('#dp-delta').fill(bad);await s.locator('#dp-form button[type=submit]').click();
      assert.equal(await text('#dp-onhand'),before);assert.equal(await text('#dp-moves'),history);
      assert.equal(await s.locator('#dp-error').isVisible(),true);
    }
    await s.locator('#dp-delta').fill('8');await s.locator('#dp-form button[type=submit]').click();
    assert.equal(await text('#dp-onhand'),'20 boxes · in stock');
    assert.equal(await s.locator('#dp-list li').count(),2);
    assert.match(await text('#dp-moves'),/\+8/);
    if(limits){
      const rows=await s.locator('#dp-moves li').count();
      for(let i=rows;i<32;i++){await s.locator('#dp-delta').fill('1');await s.locator('#dp-form button[type=submit]').click();}
      assert.equal(await s.locator('#dp-moves li').count(),32);
      const previousStock=await text('#dp-onhand'),previousMoves=await text('#dp-moves');
      await s.locator('#dp-delta').fill('1');await s.locator('#dp-form button[type=submit]').click();
      assert.equal(await text('#dp-onhand'),previousStock,'history admission cannot change stock');
      assert.equal(await text('#dp-moves'),previousMoves,'history admission preserves earlier movements');
      assert.equal(await s.locator('#dp-delta').inputValue(),'1');assert.match(await text('#dp-error'),/32/);
    }break;
  }
  case 'roster': {
    await s.locator('input[name=rs-shift][value=off]').check();
    assert.match(await s.locator('.person').filter({hasText:'Sam Achebe'}).textContent(),/32 h/);
    await s.getByRole('button',{name:/^Jonah Reyes, Tue 14:/}).click();
    assert.equal(await s.locator('input[name=rs-shift][value=early]').isDisabled(),true);
    assert.equal(await s.locator('input[name=rs-shift][value=late]').isDisabled(),true,'night ending at 07 cannot precede 15:00 with eleven-hour rest');
    await s.getByRole('button',{name:/^Mira Costa, Tue 14:/}).click();
    assert.equal(await s.locator('input[name=rs-shift][value=early]').isDisabled(),true,'23:00 to 07:00 gives only eight hours');
    await s.getByRole('button',{name:/^Ines Varga, Tue 14:/}).click();
    assert.equal(await s.locator('input[name=rs-shift][value=late]').isDisabled(),true,'candidate ending at 23:00 cannot precede 07:00');
    assert.equal(await s.locator('input[name=rs-shift][value=night]').isDisabled(),true,'candidate ending at 07:00 cannot precede 07:00');
    const gaps=await text('#rs-summary');await s.getByRole('button',{name:'Approve leave for Mira Costa',exact:true}).click();
    assert.match(await s.getByRole('button',{name:/^Mira Costa, Fri 17:/}).textContent(),/Leave/);
    assert.notEqual(await text('#rs-summary'),gaps);break;
  }
  case 'pipeline': {
    const initial=await text('#pl-co'),logs=await s.locator('#pl-timeline li').count();
    await s.locator('#pl-form button[type=submit]').click();assert.equal(await s.locator('#pl-timeline li').count(),logs);
    if(limits){
      const tooLong='x'.repeat(1001),before=await text('#pl-timeline');
      await s.locator('#pl-note').fill(tooLong);await s.locator('#pl-form button[type=submit]').click();
      assert.equal(await text('#pl-timeline'),before);
      assert.equal(await s.locator('#pl-note').inputValue(),tooLong,'oversized activity retains its draft');
    }
    await s.locator('#pl-note').fill(literal);await s.locator('#pl-form button[type=submit]').click();
    assert.equal(await s.locator('#pl-timeline p').first().textContent(),literal);
    assert.equal(await s.locator('#pl-timeline b').count(),0);
    if(limits){for(let i=1;i<20;i++){await s.locator('#pl-note').fill('Activity '+i);await s.locator('#pl-form button[type=submit]').click();}
      const before=await text('#pl-timeline');await s.locator('#pl-note').fill('Keep this activity');await s.locator('#pl-form button[type=submit]').click();
      assert.equal(await text('#pl-timeline'),before);assert.equal(await s.locator('#pl-note').inputValue(),'Keep this activity');
    }
    for(let i=0;i<4&&await s.locator('#pl-advance').isEnabled();i++)await s.locator('#pl-advance').click();
    assert.match(await text('#pl-eyebrow'),/^Won/);assert.equal(await text('#pl-co'),initial);
    await s.locator('#pl-stages button').first().click();
    assert.equal(await s.locator('#pl-deals').getByRole('button',{name:'Open dossier for '+initial,exact:true}).count(),0);
    await s.locator('#pl-deals button').first().click();const lost=await text('#pl-co');
    await s.locator('#pl-lost').click();assert.match(await text('#pl-eyebrow'),/^Lost/);
    assert.equal(await s.locator('#pl-deals').getByRole('button',{name:'Open dossier for '+lost,exact:true}).count(),0);break;
  }
  case 'tally': {
    const qty=s.getByLabel('Quantity for Workshop day on site',{exact:true});
    await qty.fill('3');assert.equal(await text('#tl-total'),'€5,404.60');
    await qty.fill('0');assert.equal(await text('#tl-total'),'€5,404.60');
    await s.locator('#tl-act').click();assert.equal(await text('#tl-state'),'Draft','invalid pending edits cannot send an invoice');
    await qty.fill('3');await s.locator('#tl-act').click();assert.equal(await text('#tl-state'),'Sent');
    assert.match(await text('#tl-status'),/No email/);
    await s.getByRole('button',{name:'Open invoice 2026-038 for Clinica Vela',exact:true}).click();
    await s.locator('#tl-act').click();assert.equal(await text('#tl-state'),'Paid');
    assert.equal(await s.locator('#tl-act').isVisible(),false);break;
  }
  case 'letter': {
    await s.locator('input[name=lt-billing][value=year]').check();assert.match(await text('#lt-sentence'),/^€190 a year/);
    await s.locator('input[name=lt-billing][value=month]').check();assert.match(await text('#lt-sentence'),/^€19 a month/);
    const faq=s.locator('[data-panel=example] details').first();await faq.locator('summary').press('Enter');
    assert.notEqual(await faq.getAttribute('open'),null);
    await s.locator('[data-panel=example] [data-open]').first().click();assert.equal(await s.locator('#request-dialog').isVisible(),true);
    await page.keyboard.press('Escape');break;
  }
  case 'datasheet': {
    await s.locator('input[name=ds-period][value=year]').check();assert.match(await text('#ds-plans'),/€2,900.*year/);
    assert.match(await text('#ds-plan-note'),/two free months/);
    await s.locator('input[name=ds-period][value=month]').check();assert.match(await text('#ds-plans'),/€290.*month/);
    const target=s.locator('[data-panel=example] a[href^="#"]').first();await target.click();
    assert.equal(await s.locator('body').evaluate(()=>location.hash),await target.getAttribute('href'));
    await s.locator('[data-panel=example] [data-open]').first().click();assert.equal(await s.locator('#request-dialog').isVisible(),true);
    await page.keyboard.press('Escape');break;
  }
  case 'walkthrough': {
    for(let i=1;i<=4;i++){await s.locator('#wt-next').click();assert.equal(await text('#wt-step-of'),'Step '+(i%4+1)+' of 4');
      assert.equal(await s.locator('.wt-tour [data-active=true]').count(),1);
    }
    await s.locator('#wt-steps [data-step]').nth(2).click();assert.equal(await text('#wt-step-title'),'Fix the gaps');
    for(const index of [0,await s.locator('[data-panel=example] [data-open]').count()-1]){
      await s.locator('[data-panel=example] [data-open]').nth(index).click();assert.equal(await s.locator('#request-dialog').isVisible(),true);
      await page.keyboard.press('Escape');
    }break;
  }
  case 'counter': {
    await s.locator('#ct-einv').uncheck();await s.locator('#ct-payroll').uncheck();
    for(const id of ['ct-people','ct-sites']){await s.locator('#'+id).focus();await page.keyboard.press('Home');}
    assert.equal(await text('#ct-total'),'12');assert.equal(await text('#ct-plan'),'Solo plan');
    for(const id of ['ct-people','ct-sites']){await s.locator('#'+id).focus();await page.keyboard.press('End');}
    assert.equal(await text('#ct-total'),'435');assert.equal(await text('#ct-plan'),'Company plan');
    await s.locator('#ct-einv').check();await s.locator('#ct-payroll').check();assert.equal(await text('#ct-total'),'615');
    assert.deepEqual(await s.locator('#ct-matrix .is-current').evaluateAll(cells=>cells.map(cell=>cell.dataset.plan)),Array(5).fill('Company'));
    await s.locator('#ct-cta').click();assert.match(await s.locator('#request-topic').inputValue(),/Company plan/);
    await page.keyboard.press('Escape');break;
  }
  default: throw Error('No behavioral scenario for '+id);
  }
}
