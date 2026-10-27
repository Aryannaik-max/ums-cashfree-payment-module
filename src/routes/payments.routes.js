const { Router } = require('express');
const controller = require('../controllers/payments.controller');

const router = Router();

router.post('/', controller.createPayment);
router.get('/:orderId', controller.getPayment);

module.exports = router;
