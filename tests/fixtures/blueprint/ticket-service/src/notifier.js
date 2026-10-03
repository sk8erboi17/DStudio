const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'localhost', port: 25 });

async function sendOpened(email, id) {
  await transport.sendMail({ to: email, subject: `Ticket #${id} received`, text: 'We will get back to you soon.' });
}

module.exports = { sendOpened };
