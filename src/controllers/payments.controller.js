const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/payment.service');

const createSchema = z.object({ feeId: z.string().uuid() });
const idemSchema = z.string().min(8).max(128);
const idSchema = z.string().uuid();
const refundSchema = z.object({
  amount: z.number().positive().optional(),
  reason: z.string().max(200).optional(),
});
const listSchema = z.object({
  studentId: z.string().optional(),
  feeId: z.string().uuid().optional(),
  status: z
    .enum(['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'USER_DROPPED', 'EXPIRED', 'REFUNDED'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

exports.create = asyncHandler(async (req, res) => {
  const { feeId } = createSchema.parse(req.body);
  const idempotencyKey = idemSchema.parse(req.headers['idempotency-key']);
  const payment = await svc.createPayment({ feeId, idempotencyKey });
  res.status(201).json({ success: true, data: payment });
});

exports.get = asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  res.json({ success: true, data: await svc.getPayment(id) });
});

exports.list = asyncHandler(async (req, res) => {
  const q = listSchema.parse(req.query);
  res.json({ success: true, data: await svc.listPayments(q) });
});

exports.paymentReturn = asyncHandler(async (req, res) => {
  const orderId = z.string().min(1).parse(req.query.order_id);
  const payment = await svc.verifyOnReturn(orderId);
  res.json({
    success: true,
    data: { orderId: payment.orderId, status: payment.status, amount: payment.amount, paymentId: payment.id },
  });
});

exports.refund = asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const body = refundSchema.parse(req.body || {});
  const idempotencyKey = req.headers['idempotency-key'] ? idemSchema.parse(req.headers['idempotency-key']) : undefined;
  const refund = await svc.refundPayment(id, { ...body, idempotencyKey });
  res.status(201).json({ success: true, data: refund });
});