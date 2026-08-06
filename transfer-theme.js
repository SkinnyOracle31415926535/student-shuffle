/* Uses Student Shuffle's raised green desktop window treatment for private sync. */
(() => {
  "use strict";

  const styleMarkers = [".ryan-semantic-sync-open{"];
  const dialogs = ".ryan-semantic-sync-dialog";
  const cards = ".ryan-semantic-sync-card";
  const headers = ".ryan-semantic-sync-card > header";
  const titleNodes = ".ryan-semantic-sync-card > header h2";
  const closeButtons = ".ryan-semantic-sync-card > header button";
  const statusPanels = [
    ".ryan-semantic-sync-status", ".ryan-semantic-sync-card section",
  ].join(", ");
  const actionRows = ".ryan-semantic-sync-actions";

  function addClass(selector, className) {
    document.querySelectorAll(selector).forEach((element) => element.classList.add(className));
  }

  function applyTheme() {
    if (document.querySelector('style[data-ryan-semantic-sync-theme="student-shuffle"]')) return;
    document.querySelectorAll("style").forEach((style) => {
      if (styleMarkers.some((marker) => style.textContent.includes(marker))) style.remove();
    });
    addClass(dialogs, "class-dialog");
    addClass(cards, "class-dialog-panel");
    addClass(headers, "queue-dialog-titlebar");
    addClass(titleNodes, "queue-dialog-title");
    addClass(closeButtons, "dialog-close");
    addClass(statusPanels, "panel");
    addClass(actionRows, "class-dialog-actions");

    const style = document.createElement("style");
    style.dataset.ryanSemanticSyncTheme = "student-shuffle";
    style.textContent = `
      .ryan-semantic-sync-open{position:fixed!important;left:8px!important;bottom:8px!important;z-index:2147482998!important}
      ${dialogs}{width:min(640px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important;max-height:calc(100dvh - 24px)!important;margin:auto!important;overflow:auto!important}
      .ryan-semantic-sync-dialog{z-index:2147482999!important}
      ${headers}{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important}
      ${headers} h2{min-width:0!important}
      ${actionRows},.ryan-semantic-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:7px!important}
      ${statusPanels}{margin-top:8px!important}
      .ryan-semantic-sync-card h3{margin-top:0!important}
      .ryan-semantic-conflict{display:grid!important;gap:7px!important;margin-top:8px!important}
    `;
    document.head.append(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  else applyTheme();
})();
