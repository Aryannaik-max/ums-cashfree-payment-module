const env = require('../config/env');
const AppError = require('../utils/AppError');

module.exports = (req, res, next) => {
  if (!env.INTERNAL_API_KEY) return next();
  if (req.headers['x-api-key'] !== env.INTERNAL_API_KEY) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid or missing x-api-key'));
  }
  next();
};