// Widget HTML autonome (style + markup + script) pour régler l'heure de l'auto-collecte
// veille mixte depuis la page /mixte. Ne dépend d'aucun style/script de veille-mixte.js :
// insertion en une seule ligne dans les pages qui l'utilisent.

function renderAutoCollectMixteWidgetHtml() {
  return `
  <style>
    .acm-panel { max-width: 720px; margin: 0 auto 24px; padding: 16px; border: 1px solid #ddd; border-radius: 12px; background: #fafafa; }
    .acm-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .acm-toggle { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
    .acm-times { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
    .acm-time-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 8px; border: 1px solid #eee; border-radius: 8px; background: #fff; }
    .acm-time-input { font: inherit; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; }
    .acm-days { display: flex; gap: 4px; }
    .acm-day-btn { font: inherit; font-size: 0.75rem; width: 30px; padding: 4px 0; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; color: #555; }
    .acm-day-btn.active { background: #111; color: #fff; border-color: #111; }
    .acm-remove-btn { border: none; background: none; color: #c0392b; cursor: pointer; font-size: 0.9rem; margin-left: auto; }
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
      var ACM_DAYS = [
        { value: 1, label: "Lun" }, { value: 2, label: "Mar" }, { value: 3, label: "Mer" },
        { value: 4, label: "Jeu" }, { value: 5, label: "Ven" }, { value: 6, label: "Sam" },
        { value: 0, label: "Dim" }
      ];
      var ACM_ALL_DAYS = ACM_DAYS.map(function(d) { return d.value; });
      var acmConfig = { enabled: false, entries: [{ time: "08:00", days: ACM_ALL_DAYS.slice() }] };

      function acmEntryRows() {
        return Array.prototype.slice.call(document.querySelectorAll(".acm-time-row"));
      }

      function acmReadEntries() {
        return acmEntryRows().map(function(row) {
          var time = row.querySelector(".acm-time-input").value;
          var days = Array.prototype.slice.call(row.querySelectorAll(".acm-day-btn.active"))
            .map(function(btn) { return Number(btn.dataset.day); });
          return { time: time, days: days };
        });
      }

      function renderAcmTimes() {
        var grid = document.getElementById("acm-times");
        grid.innerHTML = "";
        acmConfig.entries.forEach(function(entry, i) {
          var row = document.createElement("div");
          row.className = "acm-time-row";

          var inp = document.createElement("input");
          inp.type = "time";
          inp.className = "acm-time-input";
          inp.value = entry.time;
          inp.addEventListener("change", renderAcmStatus);
          row.appendChild(inp);

          var daysWrap = document.createElement("div");
          daysWrap.className = "acm-days";
          ACM_DAYS.forEach(function(d) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "acm-day-btn" + (entry.days.indexOf(d.value) !== -1 ? " active" : "");
            btn.dataset.day = d.value;
            btn.textContent = d.label;
            btn.addEventListener("click", function() {
              btn.classList.toggle("active");
              renderAcmStatus();
            });
            daysWrap.appendChild(btn);
          });
          row.appendChild(daysWrap);

          if (acmConfig.entries.length > 1) {
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "acm-remove-btn";
            rm.textContent = "✕";
            rm.addEventListener("click", function() {
              acmConfig.entries.splice(i, 1);
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
        var entries = acmReadEntries();
        if (!enabled) { div.textContent = "Collecte automatique veille mixte désactivée."; div.className = "acm-status"; return; }
        if (!entries.length || entries.some(function(e) { return !e.days.length; })) {
          div.textContent = "Choisis au moins un jour pour chaque heure."; div.className = "acm-status"; return;
        }
        div.className = "acm-status active";
        var parts = entries.map(function(e) {
          var isEveryDay = e.days.length === 7;
          var dayLabels = isEveryDay ? "tous les jours" : ACM_DAYS
            .filter(function(d) { return e.days.indexOf(d.value) !== -1; })
            .map(function(d) { return d.label; }).join(", ");
          return e.time + " (" + dayLabels + ")";
        });
        div.textContent = "Active — " + parts.join(" · ");
      }

      async function initAcm() {
        try {
          acmConfig = await fetch("/api/auto-collect").then(function(r) { return r.json(); });
        } catch (e) {
          acmConfig = { enabled: false, entries: [{ time: "08:00", days: ACM_ALL_DAYS.slice() }] };
        }
        if (!Array.isArray(acmConfig.entries) || !acmConfig.entries.length) {
          acmConfig.entries = [{ time: "08:00", days: ACM_ALL_DAYS.slice() }];
        }
        document.getElementById("acm-enabled").checked = !!acmConfig.enabled;
        renderAcmTimes();
        renderAcmStatus();
      }

      document.getElementById("acm-add-btn").addEventListener("click", function() {
        acmConfig.entries = acmReadEntries();
        acmConfig.entries.push({ time: "08:00", days: ACM_ALL_DAYS.slice() });
        renderAcmTimes();
        renderAcmStatus();
      });

      document.getElementById("acm-enabled").addEventListener("change", renderAcmStatus);

      document.getElementById("acm-save-btn").addEventListener("click", async function() {
        var enabled = document.getElementById("acm-enabled").checked;
        var entries = acmReadEntries();
        if (!entries.length) { alert("Ajoute au moins une heure."); return; }
        if (entries.some(function(e) { return !e.days.length; })) { alert("Choisis au moins un jour pour chaque heure."); return; }
        try {
          var r = await fetch("/api/auto-collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: enabled, entries: entries })
          });
          var d = await r.json();
          if (d.ok) {
            acmConfig = { enabled: enabled, entries: entries };
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
