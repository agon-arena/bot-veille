// Widget HTML autonome (style + markup + script) pour régler l'heure de l'auto-collecte
// Certamen depuis la page /certamen. Ne dépend d'aucun style/script de veille-mixte.js :
// insertion en une seule ligne dans les pages qui l'utilisent.

function renderAutoCollectCertamenWidgetHtml() {
  return `
  <style>
    .cac-panel { max-width: 720px; margin: 0 auto 24px; padding: 16px; border: 1px solid #ddd; border-radius: 12px; background: #fafafa; }
    .cac-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .cac-toggle { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
    .cac-times { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .cac-time-row { display: flex; align-items: center; gap: 4px; }
    .cac-time-input { font: inherit; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; }
    .cac-remove-btn { border: none; background: none; color: #c0392b; cursor: pointer; font-size: 0.9rem; }
    .cac-actions { display: flex; gap: 8px; margin-bottom: 8px; }
    .cac-add-btn, .cac-save-btn { font: inherit; font-size: 0.85rem; border-radius: 999px; padding: 6px 14px; cursor: pointer; border: 1px solid #ccc; background: #fff; }
    .cac-save-btn { background: #111; color: #fff; border-color: #111; }
    .cac-status { font-size: 0.85rem; color: #555; }
    .cac-status.active { color: #1a7a3c; }
  </style>
  <div class="cac-panel" id="cac-panel">
    <div class="cac-header">
      <label class="cac-toggle">
        <input type="checkbox" id="cac-enabled">
        Collecte automatique Certamen
      </label>
    </div>
    <div class="cac-times" id="cac-times"></div>
    <div class="cac-actions">
      <button type="button" class="cac-add-btn" id="cac-add-btn">+ Ajouter une heure</button>
      <button type="button" class="cac-save-btn" id="cac-save-btn">Enregistrer</button>
    </div>
    <div class="cac-status" id="cac-status"></div>
  </div>
  <script>
    (function() {
      var cacConfig = { enabled: false, times: ["08:00"] };

      function cacTimeInputs() {
        return Array.prototype.slice.call(document.querySelectorAll(".cac-time-input"));
      }

      function renderCacTimes() {
        var grid = document.getElementById("cac-times");
        grid.innerHTML = "";
        cacConfig.times.forEach(function(t, i) {
          var row = document.createElement("div");
          row.className = "cac-time-row";
          var inp = document.createElement("input");
          inp.type = "time";
          inp.className = "cac-time-input";
          inp.value = t;
          row.appendChild(inp);
          if (cacConfig.times.length > 1) {
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "cac-remove-btn";
            rm.textContent = "✕";
            rm.addEventListener("click", function() {
              cacConfig.times.splice(i, 1);
              renderCacTimes();
              renderCacStatus();
            });
            row.appendChild(rm);
          }
          grid.appendChild(row);
        });
      }

      function renderCacStatus() {
        var div = document.getElementById("cac-status");
        var enabled = document.getElementById("cac-enabled").checked;
        var times = cacTimeInputs().map(function(i) { return i.value; });
        if (!enabled) { div.textContent = "Collecte automatique Certamen désactivée."; div.className = "cac-status"; return; }
        if (!times.length) { div.textContent = "Aucune heure configurée."; div.className = "cac-status"; return; }
        div.className = "cac-status active";
        div.textContent = "Active — " + times.length + " collecte(s)/jour : " + times.join(", ");
      }

      async function initCac() {
        try {
          cacConfig = await fetch("/api/auto-collect-certamen").then(function(r) { return r.json(); });
        } catch (e) {
          cacConfig = { enabled: false, times: ["08:00"] };
        }
        if (!Array.isArray(cacConfig.times) || !cacConfig.times.length) cacConfig.times = ["08:00"];
        document.getElementById("cac-enabled").checked = !!cacConfig.enabled;
        renderCacTimes();
        renderCacStatus();
      }

      document.getElementById("cac-add-btn").addEventListener("click", function() {
        cacConfig.times.push("08:00");
        renderCacTimes();
        renderCacStatus();
      });

      document.getElementById("cac-enabled").addEventListener("change", renderCacStatus);

      document.getElementById("cac-save-btn").addEventListener("click", async function() {
        var enabled = document.getElementById("cac-enabled").checked;
        var times = cacTimeInputs().map(function(i) { return i.value; });
        if (!times.length) { alert("Ajoute au moins une heure."); return; }
        try {
          var r = await fetch("/api/auto-collect-certamen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: enabled, times: times })
          });
          var d = await r.json();
          if (d.ok) {
            cacConfig = { enabled: enabled, times: times };
            renderCacStatus();
          } else {
            alert("Erreur : " + (d.error || "inconnue"));
          }
        } catch (err) {
          alert("Erreur réseau : " + err.message);
        }
      });

      initCac();
    })();
  </script>
  `;
}

module.exports = { renderAutoCollectCertamenWidgetHtml };
