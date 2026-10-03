const tickets = require('./tickets');

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function createApp() {
  return async (req, res) => {
    const match = req.url.match(/^\/tickets\/(\d+)$/);
    if (req.method === 'GET' && match) {
      const ticket = await tickets.getTicket(Number(match[1]));
      return ticket ? send(res, 200, ticket) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && req.url === '/tickets') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const ticket = await tickets.openTicket(JSON.parse(body));
      return send(res, 201, ticket);
    }
    send(res, 404, { error: 'no route' });
  };
}

module.exports = { createApp };
