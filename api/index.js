// Vercel entry point: every request is rewritten here (see vercel.json) and
// handled by the same code that `npm start` runs locally, so the Basic Auth
// gate covers the static files too.
module.exports = require("../server");
