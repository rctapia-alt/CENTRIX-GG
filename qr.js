/* =========================================================================
   QR.JS — Modal "Acceso desde celular"
   ---------------------------------------------------------------------
   Genera un código QR con la URL actual del simulador para que el
   estudiante lo escanee con la cámara del teléfono y lo abra directamente
   en su navegador, sin instalar ninguna app. Usa la librería QRCode
   vendorizada en libs/qrcode.min.js (no depende de servicios externos).
   ========================================================================= */

(function () {

  function currentShareUrl() {
    // Se comparte la URL "limpia" del simulador (sin hash ni query de
    // estado de sesión) para que siempre abra la pantalla principal.
    return `${location.origin}${location.pathname}`;
  }

  function openModal() {
    const modal = document.getElementById("qrModal");
    const codeWrap = document.getElementById("qrModalCode");
    const urlLabel = document.getElementById("qrModalUrl");
    if (!modal || !codeWrap) return;

    const url = currentShareUrl();
    codeWrap.innerHTML = "";
    // eslint-disable-next-line no-undef
    new QRCode(codeWrap, {
      text: url,
      width: 192,
      height: 192,
      colorDark: "#10141A",
      colorLight: "#F4F1EA",
      correctLevel: QRCode.CorrectLevel.M
    });
    if (urlLabel) urlLabel.textContent = url;
    modal.style.display = "flex";
  }

  function closeModal() {
    const modal = document.getElementById("qrModal");
    if (modal) modal.style.display = "none";
  }

  function init() {
    const btn = document.getElementById("btnQR");
    const closeBtn = document.getElementById("qrModalClose");
    const modal = document.getElementById("qrModal");
    if (btn) btn.addEventListener("click", openModal);
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
