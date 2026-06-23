// Bouton autonome "Publier les sujets prêts sur Agôn" pour la page /certamen. N'appelle
// que POST /certamen/publish-ready — ne réutilise jamais .agon-btn, ne touche jamais à
// collectStorySelection() ni à une logique d'article/récit.

function renderCertamenPublishWidgetHtml() {
  return `
  <style>
    .cpub-panel { max-width: 720px; margin: 0 auto 24px; padding: 16px; border: 1px solid #ddd; border-radius: 12px; background: #fafafa; text-align: center; }
    .cpub-btn { font: inherit; font-size: 0.95rem; font-weight: 700; border-radius: 999px; padding: 10px 24px; cursor: pointer; border: 1px solid #111; background: #111; color: #fff; }
    .cpub-btn:disabled { opacity: 0.5; cursor: wait; }
    .cpub-status { margin-top: 10px; font-size: 0.85rem; color: #555; white-space: pre-line; }
    .cpub-status.success { color: #1a7a3c; }
    .cpub-status.error { color: #c0392b; }
  </style>
  <div class="cpub-panel" id="cpub-panel">
    <button type="button" class="cpub-btn" id="cpub-btn">Publier les sujets prêts sur Agôn</button>
    <div class="cpub-status" id="cpub-status"></div>
  </div>
  <script>
    (function() {
      var btn = document.getElementById("cpub-btn");
      var status = document.getElementById("cpub-status");
      if (!btn) return;
      var originalText = btn.textContent;
      btn.addEventListener("click", async function() {
        if (!window.confirm("Publier les sujets Certamen \\"ready\\" sur Agôn ? Cette action crée de vraies arènes et n'est pas réversible depuis cette page.")) return;
        btn.disabled = true;
        btn.textContent = "Publication en cours…";
        status.className = "cpub-status";
        status.textContent = "";
        try {
          var r = await fetch("/certamen/publish-ready", { method: "POST" });
          var d = await r.json();
          if (d.ok) {
            status.className = "cpub-status success";
            status.textContent =
              d.publishedCount + " sujet(s) publié(s) sur " + d.readyCount + " ready\\n" +
              "Vérifiés : " + d.checkedCount + " — Bloqués : " + d.blockedCount + " — À revoir : " + d.needsReviewCount + " — Ignorés : " + ((d.skipped || []).length);
          } else {
            status.className = "cpub-status error";
            status.textContent = "Erreur : " + (d.error || "inconnue");
          }
        } catch (err) {
          status.className = "cpub-status error";
          status.textContent = "Erreur réseau : " + err.message;
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    })();
  </script>
  `;
}

module.exports = { renderCertamenPublishWidgetHtml };
