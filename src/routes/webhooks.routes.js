const { Router } = require('express');
const controller = require('../controllers/webhooks.controller');

const router = Router();

router.post('/cashfree', controller.handleCashfreeWebhook);

module.exports = router;
