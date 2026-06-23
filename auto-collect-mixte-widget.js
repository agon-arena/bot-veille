// Widget HTML autonome (style + markup + script) pour régler l'heure de l'auto-collecte
// veille mixte depuis la page /mixte. Ne dépend d'aucun style/script de veille-mixte.js :
// insertion en une seule ligne dans les pages qui l'utilisent.

function renderAutoCollectMixteWidgetHtml() {
  return `
  <style>
    .acm-panel { max-width: 720px; margin: 0 auto 24px; padding: 16px; border: 1px solid #ddd; border-radius: 12px; background: #fafafa; }
    .acm-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .acm-toggle { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
    .acm-times { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .acm-time-row { display: flex; align-items: center; gap: 4px; }
    .acm-time-input { font: inherit; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; }
    .acm-remove-btn { border: none; background: none; color: #c0392b; cursor: pointer; font-size: 0.9rem; }
    .acm-actions { display: flex; gap: 8px; margin-bottom: 8px; }
    .acm-add-btn, .acm-save-btn { font: inherit; font-size: 0.85rem; border-radius: 999px; padding: 6px 14px; cursor: pointer; border: 1px solid #ccc; background: #fff; }
    .acm-save-btn { background: #111; color: #fff; border-color: #111; }
    .acm-status { font-size: 0.85rem; color: #555; }
    .acm-status.active { color: #1a7a3c; }
  </style>
  <div class="acm-panel" id="acm-panel">
    <div class="acm-header">
      <label class="acm-toggle">
        <input type="checkbox" id="acm-enabled">
        Collecte automatique veille mixte
      </label>
    </div>
    <div class="acm-times" id="acm-times"></div>
    <div class="acm-actions">
      <button type="button" class="acm-add-btn" id="acm-add-btn">+ Ajouter une heure</button>
      <button type="button" class="acm-save-btn" id="acm-save-btn">Enregistrer</button>
    </div>
    <div class="acm-status" id="acm-status"></div>
  </div>
  <script>
    (function() {
      var acmConfig = { enabled: false, times: ["08:00"] };

      function acmTimeInputs() {
        return Array.prototype.slice.call(document.querySelectorAll(".acm-time-input"));
      }

      function renderAcmTimes() {
        var grid = document.getElementById("acm-times");
        grid.innerHTML = "";
        acmConfig.times.forEach(function(t, i) {
          var row = document.createElement("div");
          row.className = "acm-time-row";
          var inp = document.createElement("input");
          inp.type = "time";
          inp.className = "acm-time-input";
          inp.value = t;
          row.appendChild(inp);
          if (acmConfig.times.length > 1) {
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "acm-remove-btn";
            rm.textContent = "✕";
            rm.addEventListener("click", function() {
              acmConfig.times.splice(i, 1);
              renderAcmTimes();
              renderAcmStatus();
            });
            row.appendChild(rm);
          }
          grid.appendChild(row);
        });
      }

      function renderAcmStatus() {
        var div = document.getElementById("acm-status");
        var enabled = document.getElementById("acm-enabled").checked;
        var times = acmTimeInputs().map(function(i) { return i.value; });
        if (!enabled) { div.textContent = "Collecte automatique veille mixte désactivée."; div.className = "acm-status"; return; }
        if (!times.length) { div.textContent = "Aucune heure configurée."; div.className = "acm-status"; return; }
        div.className = "acm-status active";
        div.textContent = "Active — " + times.length + " collecte(s)/jour : " + times.join(", ");
      }

      async function initAcm() {
        try {
          acmConfig = await fetch("/api/auto-collect").then(function(r) { return r.json(); });
        } catch (e) {
          acmConfig = { enabled: false, times: ["08:00"] };
        }
        if (!Array.isArray(acmConfig.times) || !acmConfig.times.length) acmConfig.times = ["08:00"];
        document.getElementById("acm-enabled").checked = !!acmConfig.enabled;
        renderAcmTimes();
        renderAcmStatus();
      }

      document.getElementById("acm-add-btn").addEventListener("click", function() {
        acmConfig.times.push("08:00");
        renderAcmTimes();
        renderAcmStatus();
      });

      document.getElementById("acm-enabled").addEventListener("change", renderAcmStatus);

      document.getElementById("acm-save-btn").addEventListener("click", async function() {
        var enabled = document.getElementById("acm-enabled").checked;
        var times = acmTimeInputs().map(function(i) { return i.value; });
        if (!times.length) { alert("Ajoute au moins une heure."); return; }
        try {
          var r = await fetch("/api/auto-collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: enabled, times: times })
          });
          var d = await r.json();
          if (d.ok) {
            acmConfig = { enabled: enabled, times: times };
            renderAcmStatus();
          } else {
            alert("Erreur : " + (d.error || "inconnue"));
          }
        } catch (err) {
          alert("Erreur réseau : " + err.message);
        }
      });

      initAcm();
    })();
  </script>
  `;
}

module.exports = { renderAutoCollectMixteWidgetHtml };
