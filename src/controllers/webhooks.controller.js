const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/payment.service');

exports.cashfree = asyncHandler(async (req, res) => {
  const out = await svc.handleWebhook({ rawBody: req.body, headers: req.headers });
  res.status(200).json({ success: true, data: out });
});