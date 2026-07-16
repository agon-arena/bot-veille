// Widget HTML autonome (style + markup + script) pour régler l'heure de l'auto-collecte
// Certamen depuis la page /certamen. Ne dépend d'aucun style/script de veille-mixte.js :
// insertion en une seule ligne dans les pages qui l'utilisent.

function renderAutoCollectCertamenWidgetHtml() {
  return `
  <style>
    .cac-panel { max-width: 720px; margin: 0 auto 24px; padding: 16px; border: 1px solid #ddd; border-radius: 12px; background: #fafafa; }
    .cac-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .cac-toggle { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
    .cac-times { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
    .cac-time-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 8px; border: 1px solid #eee; border-radius: 8px; background: #fff; }
    .cac-time-input { font: inherit; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; }
    .cac-days { display: flex; gap: 4px; }
    .cac-day-btn { font: inherit; font-size: 0.75rem; width: 30px; padding: 4px 0; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; color: #555; }
    .cac-day-btn.active { background: #111; color: #fff; border-color: #111; }
    .cac-remove-btn { border: none; background: none; color: #c0392b; cursor: pointer; font-size: 0.9rem; margin-left: auto; }
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
      var CAC_DAYS = [
        { value: 1, label: "Lun" }, { value: 2, label: "Mar" }, { value: 3, label: "Mer" },
        { value: 4, label: "Jeu" }, { value: 5, label: "Ven" }, { value: 6, label: "Sam" },
        { value: 0, label: "Dim" }
      ];
      var CAC_ALL_DAYS = CAC_DAYS.map(function(d) { return d.value; });
      var cacConfig = { enabled: false, entries: [{ time: "08:00", days: CAC_ALL_DAYS.slice() }] };

      function cacEntryRows() {
        return Array.prototype.slice.call(document.querySelectorAll(".cac-time-row"));
      }

      function cacReadEntries() {
        return cacEntryRows().map(function(row) {
          var time = row.querySelector(".cac-time-input").value;
          var days = Array.prototype.slice.call(row.querySelectorAll(".cac-day-btn.active"))
            .map(function(btn) { return Number(btn.dataset.day); });
          return { time: time, days: days };
        });
      }

      function renderCacTimes() {
        var grid = document.getElementById("cac-times");
        grid.innerHTML = "";
        cacConfig.entries.forEach(function(entry, i) {
          var row = document.createElement("div");
          row.className = "cac-time-row";

          var inp = document.createElement("input");
          inp.type = "time";
          inp.className = "cac-time-input";
          inp.value = entry.time;
          inp.addEventListener("change", renderCacStatus);
          row.appendChild(inp);

          var daysWrap = document.createElement("div");
          daysWrap.className = "cac-days";
          CAC_DAYS.forEach(function(d) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cac-day-btn" + (entry.days.indexOf(d.value) !== -1 ? " active" : "");
            btn.dataset.day = d.value;
            btn.textContent = d.label;
            btn.addEventListener("click", function() {
              btn.classList.toggle("active");
              renderCacStatus();
            });
            daysWrap.appendChild(btn);
          });
          row.appendChild(daysWrap);

          if (cacConfig.entries.length > 1) {
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "cac-remove-btn";
            rm.textContent = "✕";
            rm.addEventListener("click", function() {
              cacConfig.entries.splice(i, 1);
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
        var entries = cacReadEntries();
        if (!enabled) { div.textContent = "Collecte automatique Certamen désactivée."; div.className = "cac-status"; return; }
        if (!entries.length || entries.some(function(e) { return !e.days.length; })) {
          div.textContent = "Choisis au moins un jour pour chaque heure."; div.className = "cac-status"; return;
        }
        div.className = "cac-status active";
        var parts = entries.map(function(e) {
          var isEveryDay = e.days.length === 7;
          var dayLabels = isEveryDay ? "tous les jours" : CAC_DAYS
            .filter(function(d) { return e.days.indexOf(d.value) !== -1; })
            .map(function(d) { return d.label; }).join(", ");
          return e.time + " (" + dayLabels + ")";
        });
        div.textContent = "Active — " + parts.join(" · ");
      }

      async function initCac() {
        try {
          cacConfig = await fetch("/api/auto-collect-certamen").then(function(r) { return r.json(); });
        } catch (e) {
          cacConfig = { enabled: false, entries: [{ time: "08:00", days: CAC_ALL_DAYS.slice() }] };
        }
        if (!Array.isArray(cacConfig.entries) || !cacConfig.entries.length) {
          cacConfig.entries = [{ time: "08:00", days: CAC_ALL_DAYS.slice() }];
        }
        document.getElementById("cac-enabled").checked = !!cacConfig.enabled;
        renderCacTimes();
        renderCacStatus();
      }

      document.getElementById("cac-add-btn").addEventListener("click", function() {
        cacConfig.entries = cacReadEntries();
        cacConfig.entries.push({ time: "08:00", days: CAC_ALL_DAYS.slice() });
        renderCacTimes();
        renderCacStatus();
      });

      document.getElementById("cac-enabled").addEventListener("change", renderCacStatus);

      document.getElementById("cac-save-btn").addEventListener("click", async function() {
        var enabled = document.getElementById("cac-enabled").checked;
        var entries = cacReadEntries();
        if (!entries.length) { alert("Ajoute au moins une heure."); return; }
        if (entries.some(function(e) { return !e.days.length; })) { alert("Choisis au moins un jour pour chaque heure."); return; }
        try {
          var r = await fetch("/api/auto-collect-certamen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: enabled, entries: entries })
          });
          var d = await r.json();
          if (d.ok) {
            cacConfig = { enabled: enabled, entries: entries };
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
