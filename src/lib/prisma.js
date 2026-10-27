const { PrismaClient } = require('@prisma/client');

// Single shared PrismaClient instance for the whole app.
const prisma = new PrismaClient();

module.exports = prisma;
