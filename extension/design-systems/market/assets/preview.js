// Local catalog preview. All state belongs to this document and is lost on reload.
// There are no requests, account changes, purchases or durable saves.
const root = document.documentElement;
const theme = document.querySelector('[data-theme-toggle]');
theme.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  theme.setAttribute('aria-pressed', String(dark));
  theme.textContent = dark ? 'Light appearance' : 'Dark appearance';
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === button));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.view;
});
for (const dialog of document.querySelectorAll('dialog')) {
  let opener;
  dialog.addEventListener('close', () => opener?.focus());
  for (const button of document.querySelectorAll('[data-dialog="'+dialog.id+'"]')) button.addEventListener('click', () => {
    opener = button; dialog.showModal();
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
}
const requestDialog = document.querySelector('#request-dialog');
let requestOpener;
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => {
  requestOpener = button;
  document.querySelector('#request-topic').value = button.dataset.open;
  document.querySelector('#request-status').textContent = '';
  requestDialog.showModal();
});
requestDialog.addEventListener('close', () => requestOpener?.focus());
document.querySelector('#request-form').addEventListener('submit', event => {
  event.preventDefault();
  if (event.currentTarget.reportValidity()) document.querySelector('#request-status').textContent = 'Preview complete. Nothing was sent or booked.';
});
const byId = id => document.getElementById(id);
const make = (tag, text, attributes = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};

// Four fixed products, at most eight variant entries and six units per variant.
// The basket and comparison are document-local; filtering never erases a choice.
const products = [
  {id:'lamp',name:'Task lamp',category:'desk',price:95,material:'Powder-coated steel',detail:'A focused pool of light.',variants:['Chalk','Ink'],drawing:'<path d="M30 110h70M65 110V60M35 60h60L80 20H50Z" fill="none" stroke="currentColor" stroke-width="5"/>'},
  {id:'notebook',name:'Field notebook',category:'carry',price:16,material:'Recycled paper',detail:'A place for unfinished thoughts.',variants:['Moss','Clay'],drawing:'<path d="M35 20h65v95H35Z M45 20v95 M58 45h28 M58 56h28" fill="none" stroke="currentColor" stroke-width="4"/>'},
  {id:'tray',name:'Desk tray',category:'desk',price:28,material:'Solid cork',detail:'Keep the useful things together.',variants:['Natural','Charcoal'],drawing:'<path d="M18 55 65 30l47 25v35l-47 25L18 90Z M18 55l47 25 47-25 M65 80v35" fill="none" stroke="currentColor" stroke-width="4"/>'},
  {id:'tote',name:'Day tote',category:'carry',price:42,material:'Cotton canvas',detail:'Room for a change of plan.',variants:['Oat','Navy'],drawing:'<path d="M25 45h80l-6 70H31Z M47 48V30a18 18 0 0 1 36 0v18" fill="none" stroke="currentColor" stroke-width="4"/>'}
];
const basket = new Map(), compared = new Set();
const euro = value => '€' + value;
function renderBasket() {
  byId('basket-list').replaceChildren();
  let quantity = 0, total = 0;
  for (const [key, item] of basket) {
    quantity += item.quantity; total += item.product.price * item.quantity;
    const row = make('li'), title = make('strong', item.product.name+' / '+item.variant);
    const controls = make('div',undefined,{class:'basket-controls'});
    for (const [label, delta] of [['Decrease',-1],['Increase',1]]) {
      const button = make('button',delta < 0 ? '−' : '+',{class:'btn secondary','aria-label':label+' '+item.product.name+' '+item.variant});
      button.disabled = delta > 0 && item.quantity === 6;
      button.addEventListener('click',() => {
        item.quantity += delta;if(!item.quantity)basket.delete(key);renderBasket();
        byId('basket-status').textContent='Basket updated locally.';
        // Rebuilt rows cannot retain focus. Prefer the same still-enabled action,
        // another quantity control, then Close when the last item was removed.
        const controls=[...byId('basket-list').querySelectorAll('button:not(:disabled)')];
        (controls.find(b=>b.getAttribute('aria-label')===label+' '+item.product.name+' '+item.variant)||controls[0]||document.querySelector('#basket-dialog [data-close]')).focus();
      });
      controls.append(button);
    }
    controls.prepend(make('span',item.quantity+' × '+euro(item.product.price)));
    row.append(title,controls); byId('basket-list').append(row);
  }
  byId('basket-count').textContent=String(quantity);
  byId('basket-total').textContent='Total '+euro(total);
  byId('basket-empty').hidden=quantity>0; byId('clear-basket').disabled=quantity===0;
}
function renderComparison() {
  byId('compare-grid').replaceChildren();
  for(const product of products.filter(p=>compared.has(p.id))) {
    const row=make('article',undefined,{class:'compare-item'});
    row.append(make('h3',product.name),make('p',product.material),make('strong',euro(product.price)));
    byId('compare-grid').append(row);
  }
  byId('comparison-status').textContent=compared.size ? compared.size+' objects compared. Example prices, not a live offer.' : 'Choose up to three objects to compare.';
}
for(const product of products) {
  const article=make('article',undefined,{class:'product','data-product':product.id});
  const art=make('div',undefined,{class:'product-art',role:'img','aria-label':'Original line drawing: '+product.name+'. Not a product photograph.'});
  // This SVG is a fixed authored fixture, never user input.
  art.innerHTML='<svg viewBox="0 0 130 130" aria-hidden="true">'+product.drawing+'</svg>';
  const heading=make('div',undefined,{class:'product-heading'});
  heading.append(make('h2',product.name),make('strong',euro(product.price)));
  const field=make('div',undefined,{class:'field'}), select=make('select',undefined,{id:'variant-'+product.id});
  for(const variant of product.variants)select.append(make('option',variant));
  field.append(make('label',product.name+' finish',{for:select.id}),select);
  const actions=make('div',undefined,{class:'actions'});
  const add=make('button','Add to basket',{class:'btn','aria-label':'Add '+product.name+' to basket'});
  add.addEventListener('click',()=> {
    const key=product.id+':'+select.value, previous=basket.get(key);
    if(previous?.quantity===6){byId('catalog-status').textContent='Preview limit: six per finish.';return;}
    basket.set(key,{product,variant:select.value,quantity:(previous?.quantity||0)+1});
    renderBasket();byId('catalog-status').textContent=product.name+' / '+select.value+' added to your local basket.';
  });
  const label=make('label',undefined,{class:'choice'}), check=make('input',undefined,{type:'checkbox','aria-label':'Compare '+product.name});
  check.addEventListener('change',()=> {
    if(check.checked && compared.size===3){check.checked=false;byId('comparison-status').textContent='Compare up to three objects. Remove one first.';return;}
    check.checked?compared.add(product.id):compared.delete(product.id);renderComparison();
  });
  label.append(check,make('span','Compare'));actions.append(add,label);
  article.append(art,heading,make('p',product.detail),field,actions);byId('product-shelf').append(article);
}
function filterProducts() {
  const query=byId('product-search').value.trim().toLowerCase();
  const category=document.querySelector('[name="collection"]:checked').value;let found=0;
  for(const product of products) {
    const visible=(category==='all'||product.category===category)&&(product.name+' '+product.material).toLowerCase().includes(query);
    document.querySelector('[data-product="'+product.id+'"]').hidden=!visible;found+=Number(visible);
  }
  byId('catalog-empty').hidden=found>0;byId('catalog-status').textContent=found+' objects shown.';
}
byId('product-search').addEventListener('input',filterProducts);
for(const input of document.querySelectorAll('[name="collection"]'))input.addEventListener('change',filterProducts);
byId('reset-products').addEventListener('click',()=>{byId('product-search').value='';document.querySelector('[name="collection"][value="all"]').checked=true;filterProducts();byId('product-search').focus();});
byId('clear-basket').addEventListener('click',()=>{basket.clear();renderBasket();byId('basket-status').textContent='Basket cleared. Nothing was purchased.';document.querySelector('#basket-dialog [data-close]').focus();});
filterProducts();renderBasket();
