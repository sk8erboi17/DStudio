const http = require('http');
const { createApp } = require('./api');
const { startWorker } = require('./worker');

const port = Number(process.env.PORT || 3000);
http.createServer(createApp()).listen(port);
startWorker();
