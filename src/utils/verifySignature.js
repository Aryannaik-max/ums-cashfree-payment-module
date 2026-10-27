// STUB: webhook signature verification.
// TODO: implement per Cashfree's official webhook docs, using the raw request body.
function verifySignature(/* rawBody, signature, timestamp */) {
  throw new Error('verifySignature not implemented');
}

module.exports = { verifySignature };
