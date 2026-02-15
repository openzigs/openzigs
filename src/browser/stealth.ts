/**
 * Browser stealth — Anti-bot detection evasion via CDP injection.
 *
 * Injects scripts via `Page.addScriptToEvaluateOnNewDocument` to make
 * the automated Chrome instance appear as a regular user browser.
 * Based on common puppeteer-extra-plugin-stealth techniques but implemented
 * directly against CDP (no puppeteer dependency).
 */

/**
 * Collection of stealth scripts to inject into every new document.
 * Each script patches one or more navigator/window fingerprint leaks.
 */
export const STEALTH_SCRIPTS: string[] = [
  // 1. Override navigator.webdriver to false
  `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,

  // 2. Fake chrome.runtime (Headless Chrome doesn't have this)
  `if (!window.chrome) { window.chrome = {}; }
   if (!window.chrome.runtime) {
     window.chrome.runtime = {
       connect: function() {},
       sendMessage: function() {},
       id: undefined,
     };
   }`,

  // 3. Override navigator.plugins to look realistic
  `Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    }
  });`,

  // 4. Override navigator.languages
  `Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });`,

  // 5. Patch permissions API to hide "denied" from notifications
  `const originalQuery = window.Permissions?.prototype?.query;
   if (originalQuery) {
     window.Permissions.prototype.query = function(parameters) {
       if (parameters.name === 'notifications') {
         return Promise.resolve({ state: Notification.permission });
       }
       return originalQuery.call(this, parameters);
     };
   }`,

  // 6. Spoof WebGL vendor and renderer strings
  `const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
   WebGLRenderingContext.prototype.getParameter = function(parameter) {
     if (parameter === 37445) return 'Intel Inc.';
     if (parameter === 37446) return 'Intel Iris OpenGL Engine';
     return getParameterOrig.call(this, parameter);
   };`,

  // 7. Hide automation-related window properties
  `delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
   delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
   delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;`,

  // 8. Prevent iframe contentWindow detection
  `const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
   if (elementDescriptor) {
     Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
       get: function() {
         return elementDescriptor.get?.call(this);
       }
     });
   }`,
];

/**
 * Combined stealth script — all STEALTH_SCRIPTS joined into a single
 * IIFE for efficient injection via `Page.addScriptToEvaluateOnNewDocument`.
 */
export const COMBINED_STEALTH_SCRIPT = `(function() { try { ${STEALTH_SCRIPTS.join("\n")} } catch(e) { console.error('Stealth script injection failed:', e); } })();`;
