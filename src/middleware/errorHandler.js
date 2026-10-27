const AppError = require('../utils/AppError');

module.exports = (err, req, res, next) => {
  if (err.name === 'ZodError') {
    const message = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
  }
  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ success: false, error: { code: err.code, message: err.message } });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Record not found' } });
  }
  console.error('Unhandled error:', err.message);
  return res
    .status(500)
    .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};