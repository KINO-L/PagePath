(() => {
  "use strict";
  const P = globalThis.__PAGEPATH__;
  if (P.instance && P.instance.state !== "DESTROYED") {
    P.instance.destroy();
    return { active: false };
  }
  P.instance = new P.Game();
  P.instance.start();
  return { active: true };
})();
