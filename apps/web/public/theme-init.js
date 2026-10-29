// Applies the saved (or system) colour scheme before first paint. Kept as an external file so the production Content-Security-Policy
// can forbid inline scripts (script-src 'self').
try {
  var t = localStorage.getItem('nx-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) { /* storage unavailable: light theme */ }
