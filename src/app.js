const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const paymentsRoutes = require('./routes/payments.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// IMPORTANT: the webhook route is mounted BEFORE the global express.json().
// Signature verification needs the exact raw bytes Cashfree sent. If express.json()
// parsed the body first, re-serializing it could change whitespace/key order and
// break the signature check. Here req.body arrives as a Buffer.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/payments', paymentsRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
