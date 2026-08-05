/* Uses Student Shuffle's raised green desktop window treatment for migration controls. */
(() => {
  "use strict";

  const styleMarkers = [
    ".ryan-transfer-open{",
    ".ryan-semantic-sync-open{",
    ".ryan-v3-recovery-open{",
  ];
  const dialogs = ".ryan-transfer-dialog, .ryan-semantic-sync-dialog, .ryan-v3-recovery-dialog";
  const cards = ".ryan-transfer-card, .ryan-semantic-sync-card, .ryan-v3-recovery-card";
  const headers = ".ryan-transfer-card > header, .ryan-semantic-sync-card > header, .ryan-v3-recovery-card > header";
  const titleNodes = ".ryan-transfer-card > header h2, .ryan-semantic-sync-card > header h2, .ryan-v3-recovery-card > header h2";
  const closeButtons = ".ryan-transfer-card > header button, .ryan-semantic-sync-card > header button, .ryan-v3-recovery-card > header button";
  const statusPanels = [
    ".ryan-transfer-status", ".ryan-transfer-preview", ".ryan-transfer-sync",
    ".ryan-semantic-sync-status", ".ryan-semantic-sync-card section",
    ".ryan-v3-recovery-card [data-status]",
  ].join(", ");
  const actionRows = ".ryan-transfer-actions, .ryan-semantic-sync-actions, .ryan-v3-recovery-actions";

  function addClass(selector, className) {
    document.querySelectorAll(selector).forEach((element) => element.classList.add(className));
  }

  function applyTheme() {
    if (document.querySelector('style[data-ryan-transfer-theme="student-shuffle"]')) return;
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
    style.dataset.ryanTransferTheme = "student-shuffle";
    style.textContent = `
      .ryan-transfer-open{position:fixed!important;right:8px!important;bottom:8px!important;z-index:2147483000!important}
      .ryan-semantic-sync-open{position:fixed!important;left:8px!important;bottom:8px!important;z-index:2147482998!important}
      .ryan-v3-recovery-open{position:fixed!important;left:8px!important;bottom:58px!important;z-index:2147482996!important}
      ${dialogs}{width:min(640px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important;max-height:calc(100dvh - 24px)!important;margin:auto!important;overflow:auto!important}
      .ryan-transfer-dialog{z-index:2147483001!important}
      .ryan-semantic-sync-dialog{z-index:2147482999!important}
      .ryan-v3-recovery-dialog{z-index:2147482997!important}
      ${headers}{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important}
      ${headers} h2{min-width:0!important}
      ${actionRows},.ryan-semantic-conflict-actions,.ryan-transfer-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:7px!important}
      ${statusPanels}{margin-top:8px!important}
      .ryan-transfer-preview h3,.ryan-transfer-sync h3,.ryan-semantic-sync-card h3{margin-top:0!important}
      .ryan-transfer-conflict,.ryan-semantic-conflict{display:grid!important;gap:7px!important;margin-top:8px!important}
    `;
    document.head.append(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  else applyTheme();
})();
