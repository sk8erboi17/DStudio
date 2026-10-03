const queue = require('./queue');
const notifier = require('./notifier');

function startWorker() {
  queue.consume(async (event) => {
    if (event.type === 'ticket.opened') {
      await notifier.sendOpened(event.payload.email, event.payload.id);
    }
  });
}

module.exports = { startWorker };
