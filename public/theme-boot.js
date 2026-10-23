// Runs before the first paint (a plain script in <head>, not a module), so a driver who picked dark
// never sees a light frame while the app loads. A file, not inline: the CSP allows only 'self' scripts.
// Mirrors src/lib/theme.ts: light unless 'chargeone:theme' holds "dark".
(function () {
  var dark = false;
  try {
    dark = JSON.parse(localStorage.getItem('chargeone:theme') || 'null') === 'dark';
  } catch (e) {
    // Blocked storage: the light default.
  }
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#000000' : '#f2f2f4');
})();
