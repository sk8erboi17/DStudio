const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const LIST = 'ticket-events';

async function publish(type, payload) {
  await redis.lpush(LIST, JSON.stringify({ type, payload, at: Date.now() }));
}

async function consume(handler) {
  for (;;) {
    const [, raw] = await redis.brpop(LIST, 0);
    await handler(JSON.parse(raw));
  }
}

module.exports = { publish, consume };
