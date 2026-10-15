(() => {
  'use strict';
  const { I18n } = globalThis.__PAGEPATH__;
  document.documentElement.lang = I18n.locale;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = I18n.t(element.dataset.i18n);
  }
})();
