const Database = require('better-sqlite3');

const db = new Database(process.env.TICKETS_DB || 'tickets.db');
db.exec('CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, subject TEXT, requester TEXT, status TEXT)');

function insertTicket(t) {
  const info = db.prepare('INSERT INTO tickets (subject, requester, status) VALUES (?, ?, ?)').run(t.subject, t.requester, t.status);
  return { id: info.lastInsertRowid, ...t };
}

function findTicket(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) || null;
}

module.exports = { insertTicket, findTicket };
