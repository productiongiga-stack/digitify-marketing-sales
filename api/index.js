/**
 * Vercel serverless entry point.
 * Boots the Express app (DB init, session setup, owner seed) once on cold start,
 * then delegates every request to Express.
 */
const { app, boot } = require('../server');

let booted = false;

module.exports = async (req, res) => {
  if (!booted) {
    await boot();
    booted = true;
  }
  return app(req, res);
};
