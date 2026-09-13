// Operate authored preview controls through the browser. No inference or DOM
// source inspection. The same scenarios run in the opaque production iframe.
import assert from 'node:assert/strict';

export async function checkChoiceColumns(scope) {
  const problems = await scope.locator('body').evaluate(body => {
    const issues=[];
    for(const label of body.querySelectorAll('label.choice')) {
      if(!label.getBoundingClientRect().width)continue;
      const input=label.querySelector('input'), text=label.querySelector('span');
      if(!input || !text)continue;
      const indicator=input.getBoundingClientRect();
      const walker=document.createTreeWalker(text,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        if(!walker.currentNode.textContent.trim())continue;
        const range=document.createRange();range.selectNodeContents(walker.currentNode);
        for(const rect of range.getClientRects())if(rect.left<indicator.right+3)
          issues.push({text:walker.currentNode.textContent,indicatorRight:indicator.right,textLeft:rect.left});
      }
    }
    return issues;
  });
  assert.deepEqual(problems,[],'wrapped choice text must not enter the indicator column');
  const broken = await scope.locator('.canvas-tools').evaluateAll(rails => {
    const failures=[];
    for(const rail of rails) for(const button of rail.querySelectorAll('button')) {
      if(!button.getBoundingClientRect().width)continue;
      const walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);
      while(walker.nextNode())for(const word of walker.currentNode.textContent.matchAll(/[A-Za-z]+/g)) {
        const range=document.createRange();range.setStart(walker.currentNode,word.index);range.setEnd(walker.currentNode,word.index+word[0].length);
        if(range.getClientRects().length>1)failures.push(word[0]);
      }
    }
    return failures;
  });
  assert.deepEqual(broken,[],'ordinary tool labels must not break in the middle of a word');
}

export async function exerciseDesignDomain(id,scope,page,{limits=false}={}) {
  if(id==='market') {
    const products=scope.locator('[data-product]:visible');
    assert.equal(await products.count(),4);
    await scope.getByLabel('Find an object',{exact:true}).fill('lamp');
    assert.equal(await products.count(),1);
    await scope.getByRole('radio',{name:'On the move',exact:true}).check();
    assert.equal(await products.count(),0);
    await scope.getByRole('button',{name:'Reset filters',exact:true}).click();
    assert.equal(await products.count(),4);
    await scope.getByRole('radio',{name:'All objects',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await products.count(),2);
    await scope.getByRole('radio',{name:'All objects',exact:true}).check();
    await checkChoiceColumns(scope);
    await scope.getByRole('button',{name:'Add Task lamp to basket',exact:true}).click({clickCount:2});
    await scope.getByLabel('Task lamp finish',{exact:true}).selectOption('Ink');
    await scope.getByRole('button',{name:'Add Task lamp to basket',exact:true}).click();
    assert.equal(await scope.locator('#basket-count').textContent(),'3');
    for(const name of ['Task lamp','Field notebook','Desk tray'])await scope.getByRole('checkbox',{name:'Compare '+name,exact:true}).check();
    await scope.getByRole('checkbox',{name:'Compare Day tote',exact:true}).click();
    assert.equal(await scope.getByRole('checkbox',{name:'Compare Day tote',exact:true}).isChecked(),false);
    assert.equal(await scope.locator('#compare-grid article').count(),3);
    await scope.getByRole('button',{name:/^Basket ·/}).click();
    assert.equal(await scope.locator('#basket-total').textContent(),'Total €285');
    for(let i=0;i<4;i++)await scope.getByRole('button',{name:'Increase Task lamp Chalk',exact:true}).click();
    assert.equal(await scope.getByRole('button',{name:'Increase Task lamp Chalk',exact:true}).isDisabled(),true);
    assert.equal(await scope.locator('#basket-total').textContent(),'Total €665');
    await scope.getByRole('button',{name:'Clear basket',exact:true}).click();
    assert.equal(await scope.locator('#basket-total').textContent(),'Total €0');
    assert.equal(await scope.locator('#basket-empty').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.match(await scope.locator(':focus').textContent(),/^Basket ·/);
    await scope.getByRole('button',{name:'Add Task lamp to basket',exact:true}).click();
    await scope.getByRole('button',{name:/^Basket ·/}).click();
    await scope.getByRole('button',{name:'Decrease Task lamp Ink',exact:true}).click();
    assert.equal(await scope.locator('#basket-total').textContent(),'Total €0');
    assert.equal(await scope.locator(':focus').getAttribute('aria-label'),'Close basket','removing the last row must retain dialog focus');
    await page.keyboard.press('Escape');
  } else if(id==='commons') {
    await scope.getByLabel('Search discussions',{exact:true}).fill('bookbinding');
    assert.equal(await scope.locator('#thread-list article').count(),1);
    await scope.getByRole('button',{name:'Open A first notebook, made together',exact:true}).click();
    assert.equal(await scope.locator('#reply-list li').count(),1);
    await scope.getByRole('button',{name:'Add local reply',exact:true}).click();
    assert.equal(await scope.locator('#reply-list li').count(),1,'invalid form cannot create a reply');
    const text='<img src=x onerror="throw Error(1)"> A local question.';
    await scope.getByLabel('Your local reply',{exact:true}).fill(text);
    await scope.getByRole('button',{name:'Add local reply',exact:true}).click();
    assert.equal(await scope.locator('#reply-list li').count(),2);
    assert.equal(await scope.locator('#reply-list li').last().textContent(),text);
    assert.equal(await scope.locator('#reply-list img').count(),0,'reply text is not HTML');
    await scope.getByRole('button',{name:'← All discussions',exact:true}).click();
    assert.match(await scope.locator('#thread-list').textContent(),/2 replies/);
    await scope.getByRole('button',{name:'Join preview community',exact:true}).click();
    assert.equal(await scope.locator('#join-community').getAttribute('aria-pressed'),'true');
    await scope.getByRole('button',{name:'Leave preview community',exact:true}).click();
    assert.equal(await scope.locator('#join-community').getAttribute('aria-pressed'),'false');
    await scope.getByRole('button',{name:'People',exact:true}).click();
    await scope.getByRole('button',{name:"View Ada's profile",exact:true}).click();
    await scope.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await scope.locator(':focus').textContent(),"View Ada's profile");
    await scope.getByRole('button',{name:'Review queue',exact:true}).click();
    await scope.getByRole('button',{name:'Resolve Duplicate workshop announcement',exact:true}).click();
    assert.match(await scope.locator('#review-status').textContent(),/^1 reports/);
    await scope.getByRole('button',{name:'Restore Duplicate workshop announcement',exact:true}).click();
    assert.match(await scope.locator('#review-status').textContent(),/^2 reports/);
    await scope.getByRole('button',{name:'Discussions',exact:true}).click();
    await scope.getByLabel('Search discussions',{exact:true}).fill('no matching thread');
    assert.equal(await scope.locator('#thread-empty').isVisible(),true);
    await scope.getByLabel('Search discussions',{exact:true}).fill('');
  } else if(id==='atlas') {
    await scope.getByRole('button',{name:'Select Riverside Steps on map',exact:true}).click();
    assert.equal(await scope.locator('[data-place-card="riverside"]').getAttribute('data-selected'),'true');
    await scope.getByRole('button',{name:'Show Willow Courtyard on map',exact:true}).click();
    assert.equal(await scope.locator('[data-map-place="courtyard"]').getAttribute('aria-pressed'),'true');
    await scope.getByRole('button',{name:'Add The Corner Bookshop to route',exact:true}).click();
    await scope.getByRole('button',{name:'Add Willow Courtyard to route',exact:true}).click();
    assert.equal(await scope.locator('#route-list li').count(),2);
    assert.equal(await scope.getByRole('button',{name:'Add Willow Courtyard to route',exact:true}).isDisabled(),true);
    await scope.getByLabel('Show places',{exact:true}).selectOption('indoor');
    assert.equal(await scope.locator('[data-place-card]:visible').count(),2);
    assert.equal(await scope.locator('#route-list li').count(),2,'filter must preserve route');
    await scope.getByRole('button',{name:'Move earlier Willow Courtyard',exact:true}).click();
    assert.match(await scope.locator('#route-list li').first().textContent(),/^1\. Willow Courtyard/);
    assert.match(await scope.locator('#map-route').getAttribute('points'),/^330,180\.6 /);
    await scope.getByRole('button',{name:'Remove The Corner Bookshop',exact:true}).click();
    assert.equal(await scope.locator('#route-list li').count(),1);
    await scope.getByRole('button',{name:'Reset route',exact:true}).click();
    assert.equal(await scope.locator('#route-empty').isVisible(),true);
    assert.equal(await scope.locator('#map-route').getAttribute('points'),'');
    await scope.getByLabel('Show places',{exact:true}).selectOption('all');
  } else if(id==='canvas') {
    const objects=scope.locator('[data-object-id]');
    assert.equal(await objects.count(),2);
    await scope.getByRole('button',{name:'Select object 2: For an idea.',exact:true}).focus();
    assert.equal(await scope.getByLabel('Object label',{exact:true}).inputValue(),'For an idea.');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await scope.getByLabel('X (%)',{exact:true}).inputValue(),'47');
    await scope.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await scope.getByLabel('X (%)',{exact:true}).inputValue(),'48');
    await scope.getByRole('button',{name:'Redo',exact:true}).click();
    const before=await objects.nth(1).boundingBox();
    await scope.getByLabel('X (%)',{exact:true}).fill('999');
    await scope.getByRole('button',{name:'Apply changes',exact:true}).click();
    assert.equal((await objects.nth(1).boundingBox()).x,before.x,'invalid position cannot commit');
    await scope.getByLabel('X (%)',{exact:true}).fill('12');
    await scope.getByLabel('Y (%)',{exact:true}).fill('20');
    await scope.getByLabel('Object label',{exact:true}).fill('<b>New title</b>');
    await scope.getByRole('button',{name:'Apply changes',exact:true}).click();
    assert.equal(await scope.locator('[data-object-id="2"] strong').textContent(),'<b>New title</b>');
    assert.equal(await scope.locator('[data-object-id="2"] b').count(),0);
    await scope.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await scope.getByLabel('Object label',{exact:true}).inputValue(),'For an idea.');
    await scope.getByRole('button',{name:'Redo',exact:true}).click();
    const node=scope.locator('[data-object-id="2"]');await node.scrollIntoViewIfNeeded();
    let box=await node.boundingBox();
    await page.mouse.move(box.x+12,box.y+12);await page.mouse.down();
    await page.mouse.move(box.x+42,box.y+42,{steps:3});await page.mouse.up();
    assert.ok(Number(await scope.getByLabel('X (%)',{exact:true}).inputValue())>12,'pointer drag commits a changed position');
    await scope.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await scope.getByLabel('X (%)',{exact:true}).inputValue(),'12');
    await node.scrollIntoViewIfNeeded();box=await node.boundingBox();
    await page.mouse.move(box.x+12,box.y+12);await page.mouse.down();
    await page.mouse.move(box.x+32,box.y+32,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(await scope.getByLabel('X (%)',{exact:true}).inputValue(),'12','cancelled drag cannot publish');
    await scope.getByRole('button',{name:'Delete selected',exact:true}).click();
    assert.equal(await objects.count(),1);
    await scope.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await objects.count(),2);
    for(let i=0;i<10;i++)await scope.getByRole('button',{name:'+ Note',exact:true}).click();
    assert.equal(await objects.count(),12);
    assert.equal(await scope.getByRole('button',{name:'+ Note',exact:true}).isDisabled(),true);
    assert.equal(await scope.getByRole('button',{name:'+ Block',exact:true}).isDisabled(),true);
    await scope.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await objects.count(),11);
    assert.equal(await scope.getByRole('button',{name:'+ Note',exact:true}).isEnabled(),true);
    if(limits) {
      await scope.locator('[data-object-id][aria-pressed="true"]').focus();
      for(let i=0;i<40;i++)await page.keyboard.press(i%2?'ArrowLeft':'ArrowRight');
      for(let i=0;i<30;i++)await scope.getByRole('button',{name:'Undo',exact:true}).click();
      assert.equal(await scope.getByRole('button',{name:'Undo',exact:true}).isDisabled(),true,'only 30 history states retained');
      assert.equal(await objects.count(),11,'discarded history cannot undo older object additions');
      for(let i=0;i<30;i++)await scope.getByRole('button',{name:'Redo',exact:true}).click();
      assert.equal(await scope.getByRole('button',{name:'Redo',exact:true}).isDisabled(),true);
    }
  }
}
