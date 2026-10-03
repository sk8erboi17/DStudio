const store = require('./store');
const cache = require('./cache');
const queue = require('./queue');

async function openTicket(input) {
  const ticket = store.insertTicket({ subject: input.subject, requester: input.email, status: 'open' });
  await queue.publish('ticket.opened', { id: ticket.id, email: ticket.requester });
  return ticket;
}

async function getTicket(id) {
  const hit = cache.get(id);
  if (hit) return hit;
  const ticket = store.findTicket(id);
  if (ticket) cache.set(id, ticket);
  return ticket;
}

module.exports = { openTicket, getTicket };
