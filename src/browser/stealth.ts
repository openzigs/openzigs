/**
 * Browser stealth — Anti-bot detection evasion via CDP injection.
 *
 * Injects scripts via `Page.addScriptToEvaluateOnNewDocument` to make
 * the automated Chrome instance appear as a regular user browser.
 * Based on puppeteer-extra-plugin-stealth techniques but implemented
 * directly against CDP (no puppeteer dependency).
 *
 * reCAPTCHA Enterprise and similar systems check:
 *  - navigator.webdriver (C++ flag + JS property)
 *  - Chrome automation markers (cdc_ properties, $cdc_ in DOM)
 *  - Missing chrome.app / chrome.csi / chrome.loadTimes APIs
 *  - Canvas/AudioContext/WebGL fingerprint consistency
 *  - Stack trace sourceURL from CDP-injected scripts
 *  - navigator.connection / NetworkInformation shape
 *  - window dimension anomalies (outerHeight = 0 in headless)
 */

/**
 * Collection of stealth scripts to inject into every new document.
 * Each script patches one or more navigator/window fingerprint leaks.
 */
export const STEALTH_SCRIPTS: string[] = [
  // 1. Override navigator.webdriver to false
  // (Belt-and-suspenders: --disable-blink-features=AutomationControlled
  //  handles the C++ side, this handles the JS reflection side.)
  `Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });`,

  // 2. Fake chrome.runtime (Headless Chrome doesn't have this)
  `if (!window.chrome) { window.chrome = {}; }
   if (!window.chrome.runtime) {
     window.chrome.runtime = {
       connect: function() {},
       sendMessage: function() {},
       id: undefined,
     };
   }`,

  // 3. Fake chrome.app (missing in automation = bot fingerprint)
  `if (!window.chrome.app) {
     window.chrome.app = {
       isInstalled: false,
       InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
       RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
       getDetails: function() { return null; },
       getIsInstalled: function() { return false; },
       installState: function(cb) { if (cb) cb('not_installed'); },
       runningState: function() { return 'cannot_run'; },
     };
   }`,

  // 4. Fake chrome.csi / chrome.loadTimes (expected by many fingerprinters)
  `if (!window.chrome.csi) {
     window.chrome.csi = function() {
       return {
         onloadT: Date.now(),
         startE: Date.now(),
         pageT: performance.now(),
         tran: 15
       };
     };
   }
   if (!window.chrome.loadTimes) {
     window.chrome.loadTimes = function() {
       return {
         commitLoadTime: Date.now() / 1000,
         connectionInfo: 'http/1.1',
         finishDocumentLoadTime: Date.now() / 1000,
         finishLoadTime: Date.now() / 1000,
         firstPaintAfterLoadTime: 0,
         firstPaintTime: Date.now() / 1000,
         navigationType: 'Other',
         npnNegotiatedProtocol: 'unknown',
         requestTime: Date.now() / 1000,
         startLoadTime: Date.now() / 1000,
         wasAlternateProtocolAvailable: false,
         wasFetchedViaSpdy: false,
         wasNpnNegotiated: false,
       };
     };
   }`,

  // 5. Override navigator.plugins to look realistic
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

  // 6. Override navigator.languages
  `Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });`,

  // 7. Patch permissions API to hide "denied" from notifications
  `const originalQuery = window.Permissions?.prototype?.query;
   if (originalQuery) {
     window.Permissions.prototype.query = function(parameters) {
       if (parameters.name === 'notifications') {
         return Promise.resolve({ state: Notification.permission });
       }
       return originalQuery.call(this, parameters);
     };
   }`,

  // 8. Spoof WebGL vendor and renderer strings (WebGL1 + WebGL2)
  `(function() {
     const VENDOR = 'Intel Inc.';
     const RENDERER = 'Intel Iris OpenGL Engine';
     function patchGetParameter(proto) {
       if (!proto) return;
       const orig = proto.getParameter;
       proto.getParameter = function(p) {
         if (p === 37445) return VENDOR;
         if (p === 37446) return RENDERER;
         return orig.call(this, p);
       };
     }
     patchGetParameter(WebGLRenderingContext.prototype);
     if (typeof WebGL2RenderingContext !== 'undefined') {
       patchGetParameter(WebGL2RenderingContext.prototype);
     }
     // Also patch the debug extension (used by some fingerprinters)
     const origGetExtension = WebGLRenderingContext.prototype.getExtension;
     WebGLRenderingContext.prototype.getExtension = function(name) {
       const ext = origGetExtension.call(this, name);
       if (name === 'WEBGL_debug_renderer_info' && ext) {
         return new Proxy(ext, { get: (target, prop) => target[prop] });
       }
       return ext;
     };
   })();`,

  // 9. Hide automation-related window properties (ChromeDriver markers)
  `(function() {
     // Remove cdc_ properties injected by ChromeDriver
     for (const key of Object.keys(window)) {
       if (/^cdc_|^[$]cdc_/.test(key)) {
         try { delete window[key]; } catch(e) {}
       }
     }
     // Also remove known automation markers
     const markers = [
       '__webdriver_evaluate', '__selenium_evaluate',
       '__fxdriver_evaluate', '__driver_evaluate',
       '__webdriver_unwrap', '__selenium_unwrap',
       '__fxdriver_unwrap', '__driver_unwrap',
       '__lastWatirAlert', '__lastWatirConfirm',
       '__lastWatirPrompt', '_WEBDRIVER_ELEM_CACHE',
       'ChromeDriverw', '_phantom', '__nightmare',
       '_selenium', 'callPhantom', 'callSelenium',
       '_Selenium_IDE_Recorder', 'domAutomation',
       'domAutomationController',
     ];
     for (const m of markers) {
       try { delete window[m]; } catch(e) {}
     }
   })();`,

  // 10. Prevent iframe contentWindow detection
  `const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
   if (elementDescriptor) {
     Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
       get: function() {
         return elementDescriptor.get?.call(this);
       }
     });
   }`,

  // 11. Spoof navigator.connection (missing in automation profiles)
  `if (!navigator.connection) {
     Object.defineProperty(navigator, 'connection', {
       get: () => ({
         effectiveType: '4g',
         rtt: 50,
         downlink: 10,
         saveData: false,
         onchange: null,
         addEventListener: function() {},
         removeEventListener: function() {},
         dispatchEvent: function() { return true; },
       }),
       configurable: true,
     });
   }`,

  // 12. Fix window.outerHeight / window.outerWidth (zero in some automation)
  `if (window.outerHeight === 0) {
     Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
   }
   if (window.outerWidth === 0) {
     Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
   }`,

  // 13. Inject subtle canvas noise so fingerprint hashes aren't perfectly
  //     consistent across automated sessions (a hallmark of bots).
  `(function() {
     const origGetContext = HTMLCanvasElement.prototype.getContext;
     HTMLCanvasElement.prototype.getContext = function(type, attrs) {
       const ctx = origGetContext.call(this, type, attrs);
       if (type === '2d' && ctx) {
         const origGetImageData = ctx.getImageData;
         ctx.getImageData = function() {
           const imageData = origGetImageData.apply(this, arguments);
           // Add imperceptible noise (±1 to a handful of pixels)
           const d = imageData.data;
           for (let i = 0; i < Math.min(d.length, 80); i += 4) {
             d[i] = d[i] ^ (1 & (i * 13 + 7));
           }
           return imageData;
         };
       }
       return ctx;
     };
     const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
     HTMLCanvasElement.prototype.toDataURL = function(type) {
       const ctx = this.getContext('2d');
       if (ctx) {
         // Touch one pixel to vary the hash
         const w = this.width, h = this.height;
         if (w > 0 && h > 0) {
           try {
             const imgData = CanvasRenderingContext2D.prototype.getImageData.call(ctx, 0, 0, 1, 1);
             imgData.data[3] = imgData.data[3] ^ 1;
             CanvasRenderingContext2D.prototype.putImageData.call(ctx, imgData, 0, 0);
           } catch(e) {}
         }
       }
       return origToDataURL.apply(this, arguments);
     };
   })();`,

  // 14. Inject AudioContext fingerprint noise
  `(function() {
     if (typeof OfflineAudioContext === 'undefined') return;
     const origGetChannelData = AudioBuffer.prototype.getChannelData;
     AudioBuffer.prototype.getChannelData = function(channel) {
       const data = origGetChannelData.call(this, channel);
       // Only modify once per buffer
       if (!this._stealthed) {
         for (let i = 0; i < Math.min(data.length, 10); i++) {
           data[i] += 1e-7 * ((i * 31 + 17) % 7 - 3);
         }
         this._stealthed = true;
       }
       return data;
     };
   })();`,

  // 15. Clean up Error stack traces to remove CDP sourceURL markers
  //     that reveal scripts were injected via Page.addScriptToEvaluateOnNewDocument
  `(function() {
     const origPrepare = Error.prepareStackTrace;
     Error.prepareStackTrace = function(error, stack) {
       const filtered = stack.filter(frame => {
         const fn = frame.getFileName() || '';
         return !fn.includes('pptr:') && !fn.includes('__puppeteer');
       });
       if (origPrepare) return origPrepare(error, filtered);
       return error.toString() + '\n' + filtered.map(f =>
         '    at ' + f.toString()
       ).join('\n');
     };
   })();`,

  // 16. Override navigator.hardwareConcurrency to a common value
  `Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 8,
    configurable: true,
  });`,

  // 17. Spoof navigator.deviceMemory to a common value
  `if ('deviceMemory' in navigator) {
     Object.defineProperty(navigator, 'deviceMemory', {
       get: () => 8,
       configurable: true,
     });
   }`,

  // 18. Neutralise CDP detection via console.log(Error) stack getter trick.
  //     Anti-bot systems (Cloudflare Turnstile, DataDome) create an Error
  //     with a getter on `stack` and call console.log(). When CDP is active
  //     the WebSocket serialisation triggers the getter, revealing automation.
  //     We wrap console methods so the getter is never triggered by the CDP
  //     serialisation path. Uses the same Proxy approach but adds a safeguard
  //     that prevents Error object stack access during console serialisation.
  `(function() {
     const origConsole = window.console;
     const safeStringify = (arg) => {
       try {
         if (arg instanceof Error) return arg.message || 'Error';
         if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
         return String(arg);
       } catch { return '[object]'; }
     };
     const wrapMethod = (name) => {
       const orig = origConsole[name];
       if (typeof orig !== 'function') return;
       origConsole[name] = function(...args) {
         // Call original but prevent Error stack getter trigger
         // by pre-converting Error objects to safe strings
         const safeArgs = args.map(a => a instanceof Error ? a.message || 'Error' : a);
         return orig.apply(this, safeArgs);
       };
       // Preserve native toString so detectors see [native code]
       origConsole[name].toString = () => 'function ' + name + '() { [native code] }';
     };
     ['log', 'debug', 'info', 'warn', 'error', 'trace', 'dir'].forEach(wrapMethod);
   })();`,

  // 19. Prevent MutationObserver from detecting DOM changes caused by CDP
  //     script injection (Page.addScriptToEvaluateOnNewDocument adds <script>
  //     elements that can be observed). Wrap MutationObserver to filter out
  //     script nodes added before DOMContentLoaded.
  `(function() {
     const OrigMO = window.MutationObserver;
     window.MutationObserver = class extends OrigMO {
       constructor(callback) {
         super(function(mutations, observer) {
           // Filter out script additions that happen pre-DOMContentLoaded
           // (these are typically CDP-injected stealth scripts)
           const filtered = mutations.filter(m => {
             if (m.type === 'childList' && m.addedNodes.length) {
               for (const node of m.addedNodes) {
                 if (node.tagName === 'SCRIPT' && !document.readyState.match(/interactive|complete/)) {
                   return false;
                 }
               }
             }
             return true;
           });
           if (filtered.length > 0) callback(filtered, observer);
         });
       }
     };
     window.MutationObserver.toString = () => 'function MutationObserver() { [native code] }';
     window.MutationObserver.prototype = OrigMO.prototype;
   })();`,

  // 20. Spoof Notification.permission to "default" (many bot detectors
  //     check that notifications aren't in a suspicious state)
  `(function() {
     try {
       if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
         Object.defineProperty(Notification, 'permission', {
           get: () => 'default',
           configurable: true,
         });
       }
     } catch(e) {}
   })();`,
];

/**
 * Combined stealth script — all STEALTH_SCRIPTS joined into a single
 * IIFE for efficient injection via `Page.addScriptToEvaluateOnNewDocument`.
 *
 * The sourceURL is set to a generic Chrome extension-like path to avoid
 * detection of CDP-injected script origins.
 */
export const COMBINED_STEALTH_SCRIPT = `(function() { try { ${STEALTH_SCRIPTS.join("\n")} } catch(e) {} })();
//# sourceURL=chrome-extension://internal/content.js`;
