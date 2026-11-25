// Startup file for hosts that load a CommonJS entry (cPanel "Setup Node.js App" / Passenger).
// The POS itself is an ES module, so it is loaded with a dynamic import.
import('./server/server.js').catch((e) => { console.error(e); process.exit(1); });
