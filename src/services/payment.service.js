const crypto = require('crypto');
const env = require('../config/env');
const lib = require('../lib/prisma');
const prisma = lib.prisma || lib;
const cashfree = require('./cashfree.service');
const { checkTransition } = require('../utils/stateMachine');
const { verifyWebhookSignature } = require('../utils/verifySignature');
const AppError = require('../utils/AppError');

const toPaise = (v) => Math.round(Number(v) * 100);
const noDash = () => crypto.randomUUID().replace(/-/g, '');

// ---------------------------------------------------------------------------
// The ONLY function that changes Payment.status
// ---------------------------------------------------------------------------
async function applyStatusChange(paymentId, newStatus, { source = 'API', reason = null } = {}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new AppError(404, 'NOT_FOUND', 'Payment not found');

    const { allowed, noop } = checkTransition(payment.status, newStatus);
    if (noop) return { payment, changed: false };
    if (!allowed) {
      console.warn(`Ignored transition ${payment.status} -> ${newStatus} for ${payment.orderId}`);
      return { payment, changed: false };
    }

    // Optimistic lock: only update if status is still what we read
    const res = await tx.payment.updateMany({
      where: { id: paymentId, status: payment.status },
      data: { status: newStatus, failureReason: newStatus === 'FAILED' ? reason : payment.failureReason },
    });
    if (res.count === 0) return { payment, changed: false }; // someone else changed it first

    await tx.paymentStatusHistory.create({
      data: { paymentId, fromStatus: payment.status, toStatus: newStatus, source, reason },
    });

    if (newStatus === 'SUCCESS') {
      await tx.fee.update({ where: { id: payment.feeId }, data: { status: 'PAID', paidAt: new Date() } });
    }
    if (newStatus === 'REFUNDED') {
      await tx.fee.update({ where: { id: payment.feeId }, data: { status: 'UNPAID', paidAt: null } });
    }

    const updated = await tx.payment.findUnique({ where: { id: paymentId } });
    return { payment: updated, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Create payment
// ---------------------------------------------------------------------------
async function createPayment({ feeId, idempotencyKey }) {
  // 1. Same idempotency key -> same result, no new Cashfree call
  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.feeId !== feeId) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different fee');
    }
    return existing;
  }

  // 2. Fee checks
  const fee = await prisma.fee.findUnique({ where: { id: feeId } });
  if (!fee) throw new AppError(404, 'FEE_NOT_FOUND', 'Fee not found');
  if (fee.status === 'PAID') throw new AppError(409, 'FEE_ALREADY_PAID', 'Fee already paid');

  // 3. One active attempt per fee
  const active = await prisma.payment.findFirst({
    where: { feeId, status: { in: ['CREATED', 'PENDING'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (active) return active;

  // 4. Record locally first (amount always comes from OUR fee table, never the client)
  const orderId = `UMS_${noDash()}`;
  let payment;
  try {
    payment = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          feeId,
          studentId: fee.studentId,
          orderId,
          amount: fee.amount,
          currency: 'INR',
          status: 'CREATED',
          idempotencyKey,
        },
      });
      await tx.paymentStatusHistory.create({
        data: { paymentId: p.id, fromStatus: null, toStatus: 'CREATED', source: 'API' },
      });
      return p;
    });
  } catch (err) {
    if (err.code === 'P2002') {
      // Race: another request with the same key won. Return theirs.
      const winner = await prisma.payment.findUnique({ where: { idempotencyKey } });
      if (winner) return winner;
    }
    throw err;
  }

  // 5. Create the order on Cashfree
  try {
    const order = await cashfree.createOrder({
      orderId,
      amount: Number(fee.amount).toFixed(2),
      currency: 'INR',
      customer: { id: fee.studentId, name: fee.studentName, email: fee.studentEmail, phone: fee.studentPhone },
      returnUrl: `${env.APP_BASE_URL}/api/payments/return?order_id={order_id}`,
      notifyUrl: `${env.APP_BASE_URL}/api/webhooks/cashfree`,
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { cfOrderId: String(order.cf_order_id), paymentSessionId: order.payment_session_id },
    });
    const { payment: updated } = await applyStatusChange(payment.id, 'PENDING', { source: 'API' });
    return updated;
  } catch (err) {
    await applyStatusChange(payment.id, 'FAILED', {
      source: 'API',
      reason: `Order creation failed: ${err.message}`,
    }).catch(() => {});
    throw new AppError(502, 'GATEWAY_ERROR', `Could not create order with payment gateway: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sync with Cashfree (used by status check, return_url, reconciliation job)
// ---------------------------------------------------------------------------
function mapCashfreeState(order, attempts) {
  const statuses = attempts.map((a) => a.payment_status);
  if (order.order_status === 'PAID' || statuses.includes('SUCCESS')) return 'SUCCESS';
  if (order.order_status === 'EXPIRED') return 'EXPIRED';
  if (order.order_status === 'TERMINATED') return 'CANCELLED';
  if (statuses.length > 0 && statuses.every((s) => s === 'FAILED')) return 'FAILED';
  if (statuses.length > 0 && statuses.every((s) => ['USER_DROPPED', 'NOT_ATTEMPTED', 'CANCELLED'].includes(s))) {
    return 'USER_DROPPED';
  }
  return 'PENDING';
}

async function syncPaymentWithCashfree(payment, { source = 'API' } = {}) {
  const order = await cashfree.getOrder(payment.orderId);
  const attemptsRaw = await cashfree.getOrderPayments(payment.orderId);
  const attempts = Array.isArray(attemptsRaw) ? attemptsRaw : [];

  const next = mapCashfreeState(order, attempts);

  if (next === 'SUCCESS' && toPaise(order.order_amount) !== toPaise(payment.amount)) {
    console.error(`Amount mismatch on sync for ${payment.orderId}: cashfree=${order.order_amount} ours=${payment.amount}`);
    return prisma.payment.findUnique({ where: { id: payment.id } });
  }

  const failedAttempt = attempts.find((a) => a.payment_status === 'FAILED');
  await applyStatusChange(payment.id, next, {
    source,
    reason: next === 'FAILED' ? failedAttempt?.payment_message || 'Payment failed' : null,
  });
  return prisma.payment.findUnique({ where: { id: payment.id } });
}

async function getPayment(id, { sync = true } = {}) {
  let payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw new AppError(404, 'NOT_FOUND', 'Payment not found');

  const ageMs = Date.now() - payment.createdAt.getTime();
  if (sync && payment.status === 'PENDING' && ageMs > 2 * 60 * 1000) {
    try {
      payment = await syncPaymentWithCashfree(payment, { source: 'API' });
    } catch (err) {
      console.warn(`Live sync failed for ${payment.orderId}: ${err.message}`); // fall back to stored status
    }
  }

  const history = await prisma.paymentStatusHistory.findMany({
    where: { paymentId: id },
    orderBy: { createdAt: 'asc' },
  });
  const refunds = await prisma.refund.findMany({ where: { paymentId: id }, orderBy: { createdAt: 'asc' } });
  return { ...payment, history, refunds };
}

async function listPayments({ studentId, feeId, status, page = 1, limit = 20 }) {
  const where = {};
  if (studentId) where.studentId = studentId;
  if (feeId) where.feeId = feeId;
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.payment.count({ where }),
  ]);
  return { items, page, limit, total };
}

async function verifyOnReturn(orderId) {
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  try {
    return await syncPaymentWithCashfree(payment, { source: 'API' });
  } catch (err) {
    console.warn(`Return sync failed for ${orderId}: ${err.message}`);
    return payment;
  }
}

async function applyRefundStatus(refund, newStatus) {
  if (refund.status === newStatus) return refund;
  if (refund.status === 'SUCCESS') return refund; // terminal
  const updated = await prisma.refund.update({ where: { id: refund.id }, data: { status: newStatus } });

  if (newStatus === 'SUCCESS') {
    const payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
    const done = await prisma.refund.findMany({ where: { paymentId: refund.paymentId, status: 'SUCCESS' } });
    const refunded = done.reduce((s, r) => s + toPaise(r.amount), 0);
    if (refunded >= toPaise(payment.amount)) {
      await applyStatusChange(payment.id, 'REFUNDED', { source: 'WEBHOOK', reason: 'Fully refunded' });
    }
  }
  return updated;
}

function mapRefundStatus(s) {
  if (s === 'SUCCESS') return 'SUCCESS';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'FAILED') return 'FAILED';
  return 'PENDING';
}

async function refundPayment(paymentId, { amount, reason, idempotencyKey }) {
  if (idempotencyKey) {
    const dup = await prisma.refund.findUnique({ where: { idempotencyKey } });
    if (dup) return dup;
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
  if (payment.status !== 'SUCCESS') {
    throw new AppError(409, 'NOT_REFUNDABLE', `Only SUCCESS payments can be refunded (current: ${payment.status})`);
  }

  const existing = await prisma.refund.findMany({
    where: { paymentId, status: { in: ['PENDING', 'SUCCESS'] } },
  });
  const used = existing.reduce((s, r) => s + toPaise(r.amount), 0);
  const remaining = toPaise(payment.amount) - used;
  const requested = amount != null ? Math.round(amount * 100) : remaining;
  if (requested <= 0 || requested > remaining) {
    throw new AppError(422, 'INVALID_REFUND_AMOUNT', `Refund must be between 0.01 and ${(remaining / 100).toFixed(2)}`);
  }

  const refundId = `RF_${noDash()}`;
  let refund;
  try {
    refund = await prisma.refund.create({
      data: {
        paymentId,
        refundId,
        amount: (requested / 100).toFixed(2),
        status: 'PENDING',
        reason: reason || null,
        idempotencyKey: idempotencyKey || null,
      },
    });
  } catch (err) {
    if (err.code === 'P2002' && idempotencyKey) {
      const winner = await prisma.refund.findUnique({ where: { idempotencyKey } });
      if (winner) return winner;
    }
    throw err;
  }

  try {
    const res = await cashfree.createRefund(payment.orderId, {
      refundId,
      amount: requested / 100,
      note: reason || 'Refund',
    });
    return await applyRefundStatus(refund, mapRefundStatus(res.refund_status));
  } catch (err) {
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'FAILED' } });
    throw new AppError(502, 'GATEWAY_ERROR', `Refund failed at payment gateway: ${err.message}`);
  }
}

const EVENT_TO_STATUS = {
  PAYMENT_SUCCESS_WEBHOOK: 'SUCCESS',
  PAYMENT_FAILED_WEBHOOK: 'FAILED',
  PAYMENT_USER_DROPPED_WEBHOOK: 'USER_DROPPED',
};

async function setEventNote(eventDbId, note) {
  await prisma.paymentEvent.update({ where: { id: eventDbId }, data: { note } }).catch(() => {});
}

async function handleWebhook({ rawBody, headers }) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');

  const valid = verifyWebhookSignature({
    rawBody: raw,
    signature: headers['x-webhook-signature'],
    timestamp: headers['x-webhook-timestamp'],
    secret: env.CASHFREE_CLIENT_SECRET,
  });
  if (!valid) {
    console.warn('Webhook rejected: invalid signature');
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_BODY', 'Webhook body is not valid JSON');
  }

  const type = payload.type || 'UNKNOWN';
  const data = payload.data || {};
  const orderId = data.order?.order_id || data.refund?.order_id || null;
  const refKey = data.payment?.cf_payment_id ?? data.refund?.cf_refund_id;
  const refStatus = data.payment?.payment_status ?? data.refund?.refund_status;
  const eventId =
    refKey != null
      ? `${type}:${refKey}:${refStatus}`
      : `${type}:${crypto.createHash('sha256').update(raw).digest('hex')}`;

  const payment = orderId ? await prisma.payment.findUnique({ where: { orderId } }) : null;

  let event;
  try {
    event = await prisma.paymentEvent.create({
      data: { paymentId: payment?.id ?? null, eventId, eventType: type, rawPayload: payload, signatureValid: true },
    });
  } catch (err) {
    if (err.code === 'P2002') return { result: 'duplicate' };
    throw err;
  }

  try {
    if (!payment) {
      await setEventNote(event.id, 'Unknown order_id, ignored');
      console.warn(`Webhook for unknown order: ${orderId}`);
    } else if (type.startsWith('PAYMENT_')) {
      const next = EVENT_TO_STATUS[type];
      if (!next) {
        await setEventNote(event.id, 'Unsupported payment event type');
      } else if (next === 'SUCCESS' && toPaise(data.payment?.payment_amount) !== toPaise(payment.amount)) {
        await setEventNote(event.id, `Amount mismatch: received ${data.payment?.payment_amount}, expected ${payment.amount}`);
        console.error(`Amount mismatch for ${payment.orderId}; NOT marking SUCCESS`);
      } else {
        const reason = next === 'FAILED' ? data.payment?.payment_message || 'Payment failed' : null;
        await applyStatusChange(payment.id, next, { source: 'WEBHOOK', reason });
      }
    } else if (type.includes('REFUND') && data.refund) {
      const refund = await prisma.refund.findUnique({ where: { refundId: data.refund.refund_id } });
      if (refund) await applyRefundStatus(refund, mapRefundStatus(data.refund.refund_status));
      else await setEventNote(event.id, 'Unknown refund_id');
    } else {
      await setEventNote(event.id, 'Unhandled event type');
    }
    await prisma.paymentEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  } catch (err) {
    await prisma.paymentEvent.delete({ where: { id: event.id } }).catch(() => {});
    throw err;
  }

  return { result: 'processed' };
}

module.exports = {
  createPayment,
  getPayment,
  listPayments,
  verifyOnReturn,
  applyStatusChange,
  syncPaymentWithCashfree,
  handleWebhook,
  refundPayment,
};  