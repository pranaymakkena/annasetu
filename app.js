/* AnnaSetu app logic: in-memory state, one render function per view, escaped output. */
(function () {
  "use strict";

  var D = window.AnnaSetuData;
  var MIN = 60 * 1000;
  var URGENT_MIN = 45;
  // Impact constants: 1 meal = 0.4 kg; 2.5 kg CO2e per kg diverted; INR 65 per meal equivalent.
  var MEAL_KG = 0.4;
  var CO2_FACTOR = 2.5;
  var MEAL_VALUE_INR = 65;
  // Assumption (illustrative, not sourced): blended raw-food cost of one kg of surplus, INR per kg.
  // Used only for the caterer waste-insight saving: 8% x kg x this constant.
  var RAW_FOOD_COST_PER_KG_INR = 120;
  // Business model: Tier 1 SaaS subscription per caterer per month; Tier 2 CSR stipend per rescue.
  var SUBSCRIPTION_INR = 1999;
  var TIER2_PER_RESCUE_INR = 40;
  var STAGES = ["Posted", "Claimed", "Collected", "Delivered"];
  // localStorage key for the persisted demo database (batches, ngos, nextNum, activeRole).
  var DB_KEY = "annasetu_db_v1";
  // Single shared locality list: header filter and impact locality bars.
  var LOCALITY_LIST = ["Madhapur", "Gachibowli", "Kondapur", "Jubilee Hills", "Hitech City", "Banjara Hills"];
  // Synthetic persona -> landing view and optional dispatch filter (Arjun = active pickups = "transit").
  var ROLE_VIEWS = {
    ramesh: { view: "caterer" },
    meera: { view: "feed" },
    arjun: { view: "feed", filter: "transit" },
    vikram: { view: "roi" }
  };
  // Riders come from data.js (name, phone). Vehicles are fictional and assigned by position.
  var VEHICLES = ["Bike (EV)", "Scooter", "Cargo auto"];
  var RIDERS = D.RIDERS.map(function (r, i) {
    return { name: r.name, phone: r.phone, vehicle: VEHICLES[i % VEHICLES.length] };
  });

  // Seed caterers are objects {name, phone} in data.js; batches keep the name as a string
  // and carry the phone in catererPhone.
  function normalizeSeedBatches(batches) {
    batches.forEach(function (b) {
      if (b.caterer && typeof b.caterer === "object") {
        b.catererPhone = b.caterer.phone;
        b.caterer = b.caterer.name;
      }
    });
    return batches;
  }

  var state = {
    batches: normalizeSeedBatches(D.buildSeedBatches(Date.now())),
    ngos: D.NGOS,
    catererFilter: "",
    searchQuery: "",
    localityFilter: "",
    feedMsg: "",
    nextNum: 1009,
    // Synthetic persona chosen in #role-select ("" = none). Persisted with the DB.
    activeRole: "",
    riderIdx: 0,
    dispatchFilter: "all",
    // Manual NGO override choices per Posted batch id; kept across re-renders.
    overrides: {},
    // WhatsApp alert drawer: in memory only, deliberately not written by saveDb.
    whatsappUnread: 0,
    whatsappLog: [],
    // Batch id of the open corridor radar popover (session only; not saved).
    radarSelected: null,
    // Draft choices for the donate form. kg/meals are read from the slider on each change.
    donate: { foodChoice: "", customFood: "", diet: "", kg: 20, meals: 50, windowHours: null,
      cookedHoursAgo: null, storage: "", allergens: [], packaging: "" }
  };

  var tickerId = null;
  // Set while a re-render must not write to localStorage (header search keystrokes).
  var saveSuppressed = false;
  var seedSnapshot = null;
  var resetMsgTimer = null;
  // Batch ids already announced as expiry-locked (not persisted; one toast per batch).
  var expiryToasted = new Set();

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  function fmtNum(n) {
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 1 });
  }

  function fmtInr(n) {
    return "INR " + Math.round(n).toLocaleString("en-IN");
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // Toast in #toast-container (created when missing). Text is set with textContent only.
  // type: "ok" (default), "warn" or "error". Gets class "leaving" at 3200 ms, removed at 3500 ms.
  function showToast(title, detail, type) {
    var kind = type === "warn" || type === "error" ? type : "ok";
    var host = $("toast-container");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-container";
      (document.body || document.documentElement).appendChild(host);
    }
    var el = document.createElement("div");
    el.className = "toast toast-" + kind;
    var titleEl = document.createElement("div");
    titleEl.className = "toast-title";
    titleEl.textContent = String(title || "");
    var detailEl = document.createElement("div");
    detailEl.className = "toast-detail";
    detailEl.textContent = String(detail || "");
    el.appendChild(titleEl);
    el.appendChild(detailEl);
    host.appendChild(el);
    setTimeout(function () { el.classList.add("leaving"); }, 3200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3500);
    return el;
  }

  function findBatch(id) {
    for (var i = 0; i < state.batches.length; i++) {
      if (state.batches[i].id === id) return state.batches[i];
    }
    return null;
  }

  function ngoById(id) {
    for (var i = 0; i < state.ngos.length; i++) {
      if (state.ngos[i].id === id) return state.ngos[i];
    }
    return null;
  }

  function minsLeft(b, now) { return (b.expiresAt - now) / MIN; }
  function isLive(b) { return b.status === "Claimed" || b.status === "Collected"; }
  function isUrgent(b, now) {
    return b.status !== "Delivered" && b.status !== "Expired" && minsLeft(b, now) < URGENT_MIN;
  }
  function isOpenStatus(b) { return b.status === "Posted" || b.status === "Claimed" || b.status === "Collected"; }
  function eventAt(b, type) {
    for (var i = 0; i < b.events.length; i++) {
      if (b.events[i].type === type) return b.events[i].at;
    }
    return null;
  }
  function hhmm(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function riderVehicle(name) {
    for (var i = 0; i < RIDERS.length; i++) {
      if (RIDERS[i].name === name) return RIDERS[i].vehicle;
    }
    return "";
  }
  function riderPhone(name) {
    for (var i = 0; i < RIDERS.length; i++) {
      if (RIDERS[i].name === name) return RIDERS[i].phone;
    }
    return "";
  }
  // Inline phone chip; empty string when there is no number.
  function phoneSpan(phone) {
    return phone ? ' <span class="contact-phone">' + esc(phone) + "</span>" : "";
  }
  // ETA in minutes at the 25 km/h rule, minimum 4 (same basis as etaMinFor).
  function etaFor(item) {
    return Math.max(4, Math.round((item.distance_km / 25) * 60));
  }
  function creditsFor(b) {
    return b.credits !== undefined && b.credits !== null ? b.credits : Math.round(b.kg);
  }

  // Servings already assigned to an NGO in this session (treated as today's claims).
  function ngoUsed(ngoId) {
    var total = 0;
    state.batches.forEach(function (b) {
      if (b.ngoId === ngoId && b.status !== "Expired") total += b.servings;
    });
    return total;
  }

  function remaining(ngo) { return ngo.capacity - ngoUsed(ngo.id); }

  function dietOk(pref, diet) { return pref === "Both" || pref === diet; }

  // ---------- pure donate-form logic (no DOM) ----------
  var HOUR = 60 * MIN;
  var MAX_COOKED_HOURS = 4;
  function mealsFor(kg) { return Math.round(kg / MEAL_KG); }

  // Effective deadline = earlier of (pickup window) and (4 h after cooking).
  // Returns null until a Time Cooked value is chosen.
  function computeExpiresAt(nowMs, windowHours, timeCookedHoursAgo) {
    if (timeCookedHoursAgo === null || timeCookedHoursAgo === undefined || !isFinite(timeCookedHoursAgo)) {
      return null;
    }
    var cookedCap = nowMs - timeCookedHoursAgo * HOUR + MAX_COOKED_HOURS * HOUR;
    if (windowHours === null || windowHours === undefined || !isFinite(windowHours)) return cookedCap;
    return Math.min(nowMs + windowHours * HOUR, cookedCap);
  }

  // Returns an error message, or null when the Time Cooked value is acceptable.
  function validateTimeCooked(hoursAgo) {
    if (hoursAgo === null || hoursAgo === undefined || !isFinite(hoursAgo)) {
      return "Select a Time Cooked option (required).";
    }
    if (hoursAgo > MAX_COOKED_HOURS) {
      return "Food cooked more than 4 hours ago cannot be posted.";
    }
    return null;
  }

  // Match score (0-100) for one NGO against a draft batch {diet, meals}.
  function scoreNgo(ngo, batch) {
    var distScore = Math.max(0, 1 - ngo.distance_km / 15);
    var remainingMeals = remaining(ngo);
    var capScore = Math.max(0, Math.min(1, remainingMeals / batch.meals));
    var dietScore = ngo.pref === batch.diet ? 1.0 : (ngo.pref === "Both" ? 0.8 : 0);
    var sum = 0.4 * distScore + 0.35 * capScore + 0.25 * dietScore;
    return Math.round(100 * sum);
  }

  // Per-factor sub-scores (0-100, integers) for the Smart Match breakdown. Same inputs and
  // expressions as scoreNgo; the total is still scoreNgo's 40/35/25 weighted sum.
  function matchFactors(ngo, batch) {
    var distScore = Math.max(0, 1 - ngo.distance_km / 15);
    var capScore = Math.max(0, Math.min(1, remaining(ngo) / batch.meals));
    var dietScore = ngo.pref === batch.diet ? 1.0 : (ngo.pref === "Both" ? 0.8 : 0);
    return { dist: Math.round(100 * distScore), cap: Math.round(100 * capScore), diet: Math.round(100 * dietScore) };
  }

  // All compatible NGOs with spare capacity for a draft batch {diet, meals}, best first.
  function rankNgos(ngos, batch) {
    var eligible = ngos.filter(function (n) {
      return remaining(n) > 0 && dietOk(n.pref, batch.diet);
    }).map(function (n) {
      return { ngo: n, pct: scoreNgo(n, batch), km: n.distance_km, needsMeals: batch.meals };
    });
    eligible.sort(function (a, b) {
      return b.pct - a.pct || a.km - b.km;
    });
    return eligible;
  }

  // ---------- actions ----------
  // Expiry lock: an open batch past its deadline becomes Expired and is never routed.
  // Returns true when at least one batch was locked.
  function lockExpired(now) {
    var changed = false;
    state.batches.forEach(function (b) {
      if (isOpenStatus(b) && b.expiresAt <= now) {
        b.locked = true;
        b.status = "Expired";
        b.events.push({ type: "Expired", at: now });
        state.feedMsg = b.id + " expired. Do Not Distribute.";
        if (!expiryToasted.has(b.id)) {
          expiryToasted.add(b.id);
          showToast("Expiry lock", b.id + " is past its safe window \u2014 Do Not Distribute", "error");
        }
        changed = true;
      }
    });
    return changed;
  }

  // Shared assignment path for Smart Match and manual override: Posted -> Claimed with a
  // round-robin rider. suffix is appended to the feed message.
  function assignToNgo(b, ngo, suffix) {
    var rider = RIDERS[state.riderIdx % RIDERS.length];
    state.riderIdx += 1;
    var now = Date.now();
    b.dispatchNote = null;
    b.status = "Claimed";
    b.ngoId = ngo.id;
    b.rider = rider.name;
    b.vehicle = rider.vehicle;
    b.etaMin = Math.max(5, Math.round(ngo.distance_km / 0.25));
    b.claimedAt = now;
    b.events.push({ type: "Claimed", at: now });
    state.feedMsg = b.id + " claimed by " + ngo.name + suffix + " (" + fmtNum(ngo.distance_km) + " km). " +
      b.rider + " (" + b.vehicle + ") assigned.";
    showToast("Batch claimed", b.id + " assigned to " + ngo.name, "ok");
  }

  // Posted -> Claimed (Smart Match): top-ranked NGO with room for the whole batch.
  function claimBatch(id) {
    var b = findBatch(id);
    if (!b || b.locked || b.status !== "Posted") return;
    var ranked = rankNgos(state.ngos, { diet: b.diet, meals: b.servings }).filter(function (m) {
      return remaining(m.ngo) >= b.servings;
    });
    if (!ranked.length) {
      b.dispatchNote = "No compatible NGO with capacity right now.";
      state.feedMsg = b.id + " not claimed: no compatible NGO with capacity right now.";
      return;
    }
    assignToNgo(b, ranked[0].ngo, "");
  }

  // Posted -> Claimed with the NGO chosen in the Manual NGO Override select.
  // Checks diet compatibility and remaining capacity before assigning.
  function overrideAssign(id) {
    var b = findBatch(id);
    if (!b || b.locked || b.status !== "Posted") return;
    var ngo = ngoById(state.overrides[id] || "");
    if (!ngo) {
      state.feedMsg = b.id + ": choose an NGO in the override list first.";
      return;
    }
    if (!dietOk(ngo.pref, b.diet)) {
      state.feedMsg = b.id + " not assigned: " + ngo.name + " does not accept " + b.diet + ".";
      return;
    }
    if (remaining(ngo) < b.servings) {
      state.feedMsg = b.id + " not assigned: " + ngo.name + " has " + remaining(ngo) +
        " servings left, batch needs " + b.servings + ".";
      return;
    }
    delete state.overrides[id];
    assignToNgo(b, ngo, " (manual override)");
  }

  // Claimed -> Collected, only after the temperature checkbox is ticked.
  function confirmPickup(id) {
    var b = findBatch(id);
    if (!b || b.locked || b.status !== "Claimed") return;
    if (!b.tempChecked) {
      state.feedMsg = b.id + ": tick the temperature check before confirming pickup.";
      return;
    }
    var now = Date.now();
    b.status = "Collected";
    b.collectedAt = now;
    b.events.push({ type: "Collected", at: now });
    queueCollectedAlert(b);
    state.feedMsg = b.id + " collected by " + b.rider + " at " + hhmm(now) + ".";
    showToast("Temperature verified", b.id + " checked at pickup", "ok");
  }

  // Collected -> Delivered: credits = 1 per kg diverted; NGO served count increments.
  function confirmDelivery(id) {
    var b = findBatch(id);
    if (!b || b.locked || b.status !== "Collected") return;
    var now = Date.now();
    var ngo = ngoById(b.ngoId);
    b.status = "Delivered";
    b.deliveredAt = now;
    b.credits = Math.round(b.kg);
    if (ngo) ngo.served = (ngo.served || 0) + 1;
    b.events.push({ type: "Delivered", at: now });
    queueDeliveredAlert(b);
    state.feedMsg = b.id + " delivered to " + (ngo ? ngo.name : "NGO") +
      " (+" + b.credits + " impact credits).";
    showToast("Delivered", b.id + " delivered to " + (ngo ? ngo.name : "NGO"), "ok");
  }

  // Action buttons for a feed card. Expired and Delivered listings get none.
  function feedActionsHtml(b) {
    if (b.locked || b.status === "Expired" || b.status === "Delivered") return "";
    if (b.status === "Posted") {
      var chosen = state.overrides[b.id] || "";
      var options = '<option value="">Manual NGO Override\u2026</option>' + state.ngos.map(function (n) {
        return '<option value="' + esc(n.id) + '"' + (n.id === chosen ? " selected" : "") + ">" +
          esc(n.name + " \u00B7 " + n.locality) + "</option>";
      }).join("");
      return '<button type="button" class="btn btn-primary" data-action="claim" data-id="' + esc(b.id) +
        '">Claim Batch (Smart Match)</button>' +
        '<label class="ngo-override">Manual NGO Override<select class="override-select" data-override-select="' + esc(b.id) + '">' +
        options + "</select></label>" +
        '<button type="button" class="btn btn-secondary" data-action="override-assign" data-id="' + esc(b.id) +
        '">Confirm Override</button>';
    }
    if (b.status === "Claimed") {
      return '<label class="temp-check"><input type="checkbox" data-temp-check="' + esc(b.id) + '"' +
        (b.tempChecked ? " checked" : "") + "> Core temp checked \u2265 60\u00B0C or chilled \u2264 5\u00B0C</label>" +
        '<button type="button" class="btn btn-primary" data-action="confirm-pickup" data-id="' + esc(b.id) + '"' +
        (b.tempChecked ? "" : " disabled") + ">Confirm Pickup &amp; Check Temp</button>";
    }
    if (b.status === "Collected") {
      return '<button type="button" class="btn btn-primary" data-action="confirm-delivery" data-id="' + esc(b.id) +
        '">Confirm Delivery at Shelter</button>';
    }
    return "";
  }

  // Receiver handling guide. Markup comes from index.html (#handling-modal, #handling-body, .modal-close).
  function openHandling(id) {
    var b = findBatch(id);
    var modal = $("handling-modal");
    var body = $("handling-body");
    if (!b || !modal || !body) return;
    var allergens = b.allergens && b.allergens.length ? b.allergens.join(", ") :
      "none declared by caterer (verify on receipt)";
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var contacts = "<p>Caterer: " + esc(b.caterer) + phoneSpan(b.catererPhone) + "</p>";
    if (ngo) contacts += "<p>NGO: " + esc(ngo.name) + phoneSpan(ngo.phone) + "</p>";
    if (b.rider) contacts += "<p>Rider: " + esc(b.rider) + phoneSpan(riderPhone(b.rider)) + "</p>";
    body.innerHTML =
      "<h3>Receiver Handling &amp; Safety Checklist</h3>" +
      "<p>" + esc(b.id) + " \u00B7 " + esc(b.food) + "</p>" +
      contacts +
      "<ul>" +
      "<li>Check smell and temperature before serving. Reject if off-smell or outside the safe range.</li>" +
      "<li>Consume within 1 hour of delivery.</li>" +
      "<li><strong>Allergen warning:</strong> " + esc(allergens) + "</li>" +
      "</ul>" +
      '<p class="disclaimer">' + esc(D.DISCLAIMER) + "</p>";
    modal.classList.remove("hidden");
    modal.style.display = "";
  }

  function hideHandling() {
    var modal = $("handling-modal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.style.display = "none";
  }


  // ---------- handover receipt (chain-of-custody slip) ----------
  // A handover record generated by AnnaSetu. It is not issued by FSSAI.
  function handoverButtonHtml(id) {
    return '<button type="button" class="btn btn-secondary" data-action="handover-receipt" data-id="' +
      esc(id) + '">Handover Receipt</button>';
  }

  function fmtDateTime(ms) {
    if (ms === null || ms === undefined || !isFinite(Number(ms))) return "Not recorded";
    return new Date(Number(ms)).toLocaleString("en-IN");
  }

  // Stored temperature as text, or "" when nothing was recorded.
  function storedTemp(v) {
    return v !== null && v !== undefined && String(v).trim() !== "" ? String(v) : "";
  }

  // Demo handover OTP for the slip: 6 digits from the batch id's numeric part, zero-padded.
  function handoverSlipOtp(id) {
    var digits = String(id).replace(/\D/g, "");
    return ("000000" + digits.slice(-6)).slice(-6);
  }

  function slipField(label, value) {
    return '<div class="slip-field"><span class="slip-label">' + esc(label) + "</span>" +
      '<span class="slip-value">' + esc(value) + "</span></div>";
  }

  function buildHandoverSlipHtml(b) {
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var meals = b.servings !== null && b.servings !== undefined ? b.servings : mealsFor(b.kg);
    var pickupTemp = storedTemp(b.pickupTemp);
    var dropTemp = storedTemp(b.dropTemp) || storedTemp(b.dropoffTemp);
    var tempLogged = !!b.tempChecked || !!pickupTemp || !!dropTemp;
    var rows = [
      ["Cooking time", fmtDateTime(b.preparedAt)],
      ["Pickup temperature", pickupTemp || "Not recorded"],
      ["Drop-off temperature", dropTemp || "Not recorded"],
      ["Status", tempLogged ? "Temperature log recorded" : "Temperature check pending"]
    ];
    var tableRows = rows.map(function (r) {
      return "<tr><td>" + esc(r[0]) + '</td><td class="slip-value">' + esc(r[1]) + "</td></tr>";
    }).join("");
    return '<div class="slip-head">' +
      '<h2 class="slip-title">Food Recovery &amp; CSR Handover Slip</h2>' +
      '<p class="slip-sub">Handover record generated by AnnaSetu. Not issued by FSSAI.</p>' +
      "</div>" +
      '<div class="slip-grid">' +
      slipField("Batch ID", b.id) +
      slipField("Date / Time", fmtDateTime(deliveredAtOf(b))) +
      slipField("Donor caterer", b.caterer) +
      slipField("FSSAI licence no.", "XXXX-XXXX-XXXX (placeholder)") +
      slipField("Receiving NGO", ngo ? ngo.name : "Unassigned") +
      slipField("Meals", meals) +
      slipField("Weight", fmtNum(b.kg) + " kg") +
      slipField("Veg / Non-Veg", b.diet === "Veg" ? "Veg" : "Non-Veg") +
      "</div>" +
      '<h3 class="slip-sub">Cold / hot chain</h3>' +
      '<table class="slip-table"><thead><tr><th>Stage</th><th>Record</th></tr></thead>' +
      "<tbody>" + tableRows + "</tbody></table>" +
      '<p class="slip-sub">Handover OTP (demo)</p>' +
      '<p class="slip-otp">' + esc(handoverSlipOtp(b.id)) + "</p>" +
      '<p class="slip-value">Estimated CSR value (not a tax benefit): \u20B9' + esc(TIER2_PER_RESCUE_INR) + "</p>" +
      '<div class="slip-foot"><span>Caterer signature</span><span>Rider signature</span>' +
      "<span>NGO signature</span></div>";
  }

  function openHandoverReceipt(id) {
    var b = findBatch(id);
    var modal = $("handover-modal");
    var slip = $("handover-slip");
    if (!b || !modal || !slip) return;
    slip.innerHTML = buildHandoverSlipHtml(b);
    modal.hidden = false;
  }

  function closeHandoverReceipt() {
    var modal = $("handover-modal");
    if (modal) modal.hidden = true;
  }

  // Adds the print class (CSS limits printing to the slip) and opens the print dialog.
  function printHandoverReceipt() {
    if (document.body) document.body.classList.add("printing-receipt");
    if (typeof window.print === "function") window.print();
  }

  // ---------- WhatsApp alert drawer (in memory only; never saved) ----------
  var WA_LOG_CAP = 50;

  function waMinsLeft(b) {
    return Math.max(0, Math.round((b.expiresAt - Date.now()) / MIN));
  }

  function ngoNameOf(b) {
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    return ngo ? ngo.name : "NGO";
  }

  // Google Maps directions from the caterer locality to the NGO locality (Hitech City if no NGO).
  function mapsLink(b) {
    var origin = D.LOCALITIES[b.locality];
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var dest = ngo && D.LOCALITIES[ngo.locality] ? D.LOCALITIES[ngo.locality] : D.LOCALITIES["Hitech City"];
    if (!origin || !dest) return "";
    return "https://www.google.com/maps/dir/?api=1&origin=" + origin.lat + "," + origin.lng +
      "&destination=" + dest.lat + "," + dest.lng;
  }

  function updateWhatsAppBadge() {
    var badge = $("whatsapp-badge");
    if (!badge) return;
    badge.textContent = String(state.whatsappUnread);
    badge.hidden = state.whatsappUnread <= 0;
  }

  function queueWhatsAppAlert(recipient, text, kind) {
    state.whatsappLog.push({
      recipient: String(recipient || ""),
      text: String(text || ""),
      kind: String(kind || ""),
      at: Date.now()
    });
    if (state.whatsappLog.length > WA_LOG_CAP) {
      state.whatsappLog.splice(0, state.whatsappLog.length - WA_LOG_CAP);
    }
    state.whatsappUnread += 1;
    updateWhatsAppBadge();
    var drawer = $("whatsapp-drawer");
    if (drawer && !drawer.hidden) renderWhatsAppDrawer();
  }

  function renderWhatsAppDrawer() {
    var host = $("whatsapp-messages");
    if (!host) return;
    if (!state.whatsappLog.length) {
      host.innerHTML = '<p class="wa-empty">No alerts yet.</p>';
      return;
    }
    host.innerHTML = state.whatsappLog.map(function (m) {
      var isRider = m.recipient === "EV Rider";
      return '<div class="wa-bubble' + (isRider ? " is-rider" : "") + '">' +
        '<div class="wa-recipient">' + esc(m.recipient) + "</div>" +
        '<span class="wa-tag">' + esc(m.kind) + "</span>" +
        '<p class="wa-text">' + esc(m.text) + "</p>" +
        '<div class="wa-meta">' + esc(fmtTime(m.at)) + "</div>" +
        "</div>";
    }).join("");
    host.scrollTop = host.scrollHeight;
  }

  function setWhatsAppOpen(open) {
    var drawer = $("whatsapp-drawer");
    var toggle = $("whatsapp-toggle");
    if (drawer) drawer.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      state.whatsappUnread = 0;
      updateWhatsAppBadge();
      renderWhatsAppDrawer();
    }
  }

  // Hook: a batch was published. Alerts go to the NGO Coordinator and the EV Rider.
  function queuePostedAlerts(b) {
    var text = "New surplus posted: " + b.id + ", " + b.food + ", " + fmtNum(b.kg) + " kg from " +
      b.caterer + " in " + b.locality + ". Expires in " + waMinsLeft(b) + "m. Pickup PIN: " +
      demoOtp(b.id) + ". Corridor: " + mapsLink(b);
    queueWhatsAppAlert("NGO Coordinator", text, "Posted");
    queueWhatsAppAlert("EV Rider", text, "Posted");
  }

  // Hook: a Posted batch was claimed. Alerts go to both recipients.
  function queueClaimedAlerts(b) {
    var text = b.id + " claimed by " + b.rider + " for NGO " + ngoNameOf(b) + ". Expires in " +
      waMinsLeft(b) + "m. Pickup PIN: " + demoOtp(b.id) + ". Corridor: " + mapsLink(b);
    queueWhatsAppAlert("NGO Coordinator", text, "Claimed");
    queueWhatsAppAlert("EV Rider", text, "Claimed");
  }

  // Hook: pickup confirmed. Alert goes to the NGO Coordinator.
  function queueCollectedAlert(b) {
    var text = b.id + " collected from " + b.caterer + ". En route to NGO " + ngoNameOf(b) + ". Expires in " +
      waMinsLeft(b) + "m. Corridor: " + mapsLink(b);
    queueWhatsAppAlert("NGO Coordinator", text, "Collected");
  }

  // Hook: delivery confirmed. Alert goes to the EV Rider.
  function queueDeliveredAlert(b) {
    var text = b.id + " delivered to NGO " + ngoNameOf(b) + ". Thank you.";
    queueWhatsAppAlert("EV Rider", text, "Delivered");
  }

  // ---------- donate form: state -> controls ----------
  function foodName() {
    var d = state.donate;
    if (d.foodChoice === "__custom") return d.customFood.trim();
    return d.foodChoice;
  }

  // Reflect the draft state onto every chip/toggle (aria-pressed) and the hidden inputs.
  function syncDonateControls() {
    var d = state.donate;
    var form = $("donate-form");
    var custom = d.foodChoice === "__custom";

    Array.prototype.forEach.call(form.querySelectorAll("[data-food]"), function (el) {
      el.setAttribute("aria-pressed", el.getAttribute("data-food") === d.foodChoice ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-diet]"), function (el) {
      el.setAttribute("aria-pressed", el.getAttribute("data-diet") === d.diet ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-kg]"), function (el) {
      el.setAttribute("aria-pressed", Number(el.getAttribute("data-kg")) === d.kg ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-window]"), function (el) {
      el.setAttribute("aria-pressed", Number(el.getAttribute("data-window")) === d.windowHours ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-cooked]"), function (el) {
      el.setAttribute("aria-pressed", Number(el.getAttribute("data-cooked")) === d.cookedHoursAgo ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-storage]"), function (el) {
      el.setAttribute("aria-pressed", el.getAttribute("data-storage") === d.storage ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-allergen]"), function (el) {
      el.setAttribute("aria-pressed", d.allergens.indexOf(el.getAttribute("data-allergen")) !== -1 ? "true" : "false");
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-pack]"), function (el) {
      el.setAttribute("aria-pressed", el.getAttribute("data-pack") === d.packaging ? "true" : "false");
    });

    $("food").value = foodName();
    $("diet").value = d.diet;
    $("food-custom-wrap").hidden = !custom;
  }

  // Recompute kg/meals, deadline and match preview from the current draft.
  function renderDonateWidgets() {
    var d = state.donate;
    var slider = $("kg-slider");
    d.kg = Number(slider.value);
    d.meals = mealsFor(d.kg);

    var sliderLabel = slider.parentNode.querySelector(".slider-value");
    if (sliderLabel) sliderLabel.textContent = d.kg + " kg";
    $("meals-readout").textContent = d.meals + " meals (est.)";

    syncDonateControls();

    var now = Date.now();
    var deadline = computeExpiresAt(now, d.windowHours, d.cookedHoursAgo);
    var err = d.cookedHoursAgo === null ? null : validateTimeCooked(d.cookedHoursAgo);
    if (deadline === null) {
      $("effective-deadline").textContent = "Effective deadline: select a time cooked to set the deadline.";
    } else if (err) {
      $("effective-deadline").textContent = err;
    } else {
      $("effective-deadline").textContent = "Effective deadline: " + fmtTime(deadline) +
        (d.windowHours === null ? " (no pickup window chosen)" : "");
    }

    var preview = $("match-preview");
    if (!d.diet) {
      preview.innerHTML = '<p class="hint">Choose Veg or Non-Veg to see matching NGOs.</p>';
      return;
    }
    var matches = rankNgos(state.ngos, { diet: d.diet, meals: d.meals }).slice(0, 3);

    if (!matches.length) {
      preview.innerHTML = '<p class="hint">No compatible NGO with capacity right now.</p>';
      return;
    }
    // Top 3 with one bar per factor. Totals come from scoreNgo (40/35/25); bars from matchFactors.
    var draft = { diet: d.diet, meals: d.meals };
    var pill = function (label, value) {
      return '<div class="match-pill"><span>' + label + '</span><div class="match-pill-bar">' +
        '<div class="match-pill-fill" style="width:' + value + '%"></div></div></div>';
    };
    preview.innerHTML = '<div class="match-breakdown">' + matches.map(function (m) {
      var f = matchFactors(m.ngo, draft);
      return '<div class="match-card"><div class="match-card-head"><span>' + esc(m.ngo.name) +
        '</span><span class="match-score">' + esc(m.pct) + '%</span></div>' +
        '<div class="match-pills">' + pill("Distance 40%", f.dist) + pill("Capacity fit 35%", f.cap) +
        pill("Diet fit 25%", f.diet) + "</div></div>";
    }).join("") + "</div>";
  }

  // Click delegation for every chip / toggle inside the donate form.
  function onDonateClick(e) {
    var d = state.donate;
    var btn = e.target.closest ? e.target.closest("button") : null;
    if (!btn || btn.type !== "button") return;

    if (btn.hasAttribute("data-food")) {
      d.foodChoice = btn.getAttribute("data-food");
      if (d.foodChoice !== "__custom") d.customFood = "";
    } else if (btn.hasAttribute("data-kg")) {
      $("kg-slider").value = btn.getAttribute("data-kg");
    } else if (btn.hasAttribute("data-diet")) {
      d.diet = btn.getAttribute("data-diet");
    } else if (btn.hasAttribute("data-window")) {
      d.windowHours = Number(btn.getAttribute("data-window"));
    } else if (btn.hasAttribute("data-cooked")) {
      d.cookedHoursAgo = Number(btn.getAttribute("data-cooked"));
    } else if (btn.hasAttribute("data-storage")) {
      d.storage = btn.getAttribute("data-storage");
    } else if (btn.hasAttribute("data-allergen")) {
      var a = btn.getAttribute("data-allergen");
      if (a === "None") {
        d.allergens = d.allergens.indexOf("None") !== -1 ? [] : ["None"];
      } else {
        d.allergens = d.allergens.filter(function (x) { return x !== "None"; });
        var at = d.allergens.indexOf(a);
        if (at === -1) d.allergens.push(a); else d.allergens.splice(at, 1);
      }
    } else if (btn.hasAttribute("data-pack")) {
      d.packaging = btn.getAttribute("data-pack");
    } else {
      return;
    }
    renderDonateWidgets();
  }

  function onDonateInput() {
    state.donate.customFood = $("food-custom").value;
    renderDonateWidgets();
  }

  function resetDonateForm() {
    var d = state.donate;
    d.foodChoice = "";
    d.customFood = "";
    d.diet = "";
    d.windowHours = null;
    d.cookedHoursAgo = null;
    d.storage = "";
    d.allergens = [];
    d.packaging = "";
    $("food-custom").value = "";
    $("kg-slider").value = "20";
    $("locality-select").selectedIndex = 0;
    renderDonateWidgets();
  }

  // ---------- donate form: submit ----------
  function onDonateSubmit(e) {
    e.preventDefault();
    submitDonateBatch();
  }

  // Validates the draft and creates one Posted batch. Shared by the form submit and the
  // one-click wedding autofill.
  function submitDonateBatch() {
    var d = state.donate;
    var msg = $("donate-msg");
    var caterer = $("donate-form").elements.caterer.value.trim();
    var food = foodName();
    var locality = $("locality-select").value;
    var now = Date.now();

    renderDonateWidgets();
    if (!food) {
      msg.textContent = "Choose a food preset or type a custom food name.";
      return;
    }
    if (!caterer) {
      msg.textContent = "Caterer name is required.";
      return;
    }
    if (!d.diet) {
      msg.textContent = "Choose Veg or Non-Veg.";
      return;
    }
    var timeErr = validateTimeCooked(d.cookedHoursAgo);
    if (timeErr) {
      msg.textContent = timeErr;
      return;
    }
    if (!d.storage) {
      msg.textContent = "Select a storage condition.";
      return;
    }
    if (!d.allergens.length) {
      msg.textContent = "Select an allergen option (choose None if there are none).";
      return;
    }
    if (!d.packaging) {
      msg.textContent = "Select a packaging option.";
      return;
    }
    var expiresAt = computeExpiresAt(now, d.windowHours, d.cookedHoursAgo);
    if (expiresAt === null || expiresAt <= now) {
      msg.textContent = "Deadline has already passed. Post sooner.";
      return;
    }

    var loc = D.LOCALITIES[locality];
    var id = "AS-" + state.nextNum;
    state.nextNum += 1;

    state.batches.push({
      id: id,
      caterer: caterer,
      locality: locality,
      lat: loc.lat,
      lng: loc.lng,
      food: food,
      diet: d.diet,
      servings: d.meals,
      kg: d.kg,
      preparedAt: now,
      expiresAt: expiresAt,
      ngoId: null,
      rider: null,
      claimedAt: null,
      status: "Posted",
      storage: d.storage,
      allergens: d.allergens.filter(function (a) { return a !== "None"; }),
      packaging: d.packaging,
      events: [{ type: "Posted", at: now }]
    });
    var postedBatch = findBatch(id);
    if (postedBatch) queuePostedAlerts(postedBatch);

    resetDonateForm();
    msg.textContent = "Batch " + id + " posted. It is now live in the NGO & Rider Dispatch feed.";
    showToast("Batch published", id + " \u00B7 " + food + " is live for dispatch", "ok");
    populateCatererFilter();
    renderAll();
  }

  // One-click sample: fills every draft field with a realistic wedding surplus, then creates the batch.
  function autofillWeddingSurplus() {
    var d = state.donate;
    $("donate-form").elements.caterer.value = "Lakeview Wedding Kitchens";
    $("locality-select").value = "Jubilee Hills";
    d.foodChoice = "Veg Biryani & Salan";
    d.customFood = "";
    d.diet = "Veg";
    $("kg-slider").value = "40";
    d.windowHours = 2;
    d.cookedHoursAgo = 1;
    d.storage = "Hot-held";
    d.allergens = ["Dairy"];
    d.packaging = "Sealed Foil Trays";
    renderDonateWidgets();
    submitDonateBatch();
  }

  // Waste pattern insight from ALL batches (seeds included): the dish with the largest share of
  // surplus kg, its share of total kg, and the saving from cutting that dish's prep by 8%.
  // Saving = 8% x kg x RAW_FOOD_COST_PER_KG_INR (assumption, see constant at top of file).
  function renderWasteInsight() {
    var el = $("waste-insight-text");
    if (!el) return;
    var byDish = {};
    var totalKg = 0;
    state.batches.forEach(function (b) {
      var kg = Number(b.kg) || 0;
      totalKg += kg;
      byDish[b.food] = (byDish[b.food] || 0) + kg;
    });
    var top = null;
    Object.keys(byDish).forEach(function (dish) {
      if (top === null || byDish[dish] > byDish[top]) top = dish;
    });
    if (top === null || totalKg <= 0) {
      el.textContent = "No surplus batches yet. Post one to see your waste pattern.";
      return;
    }
    var sharePct = Math.round(100 * byDish[top] / totalKg);
    var saving = Math.round(0.08 * byDish[top] * RAW_FOOD_COST_PER_KG_INR);
    el.textContent = "Insight: " + top + " batches account for " + sharePct +
      "% of your monthly surplus \u2014 reducing prep by 8% saves \u20B9" + saving.toLocaleString("en-IN") + "/mo";
  }

  // ---------- render: shared pieces ----------
  function badgeHtml(status) {
    var keys = {
      Posted: "posted", Assigned: "claimed", Claimed: "claimed",
      "Picked Up": "collected", Collected: "collected", "In Transit": "collected",
      Delivered: "delivered", Expired: "expired"
    };
    var key = Object.prototype.hasOwnProperty.call(keys, status) ? keys[status] : "posted";
    return '<span class="status-badge status-' + key + '">' + key.toUpperCase() + "</span>";
  }


  // Countdown as "HHh MMm SSs", zero-padded. Returns "Expired" once the deadline has passed.
  function formatCountdown(ms) {
    if (ms <= 0) return "Expired";
    var secs = Math.floor(ms / 1000);
    var hours = Math.floor(secs / 3600);
    var mins = Math.floor((secs % 3600) / 60);
    var two = function (n) { return n < 10 ? "0" + n : String(n); };
    return two(hours) + "h " + two(mins) + "m " + two(secs % 60) + "s";
  }


  // Live countdown: <span class="countdown"> with data-expires, so the ticker keeps text and the
  // "urgent" class (under URGENT_MIN minutes) current. Expired and Delivered show a fixed label.
  function urgencyHtml(b, now) {
    if (b.status === "Expired") return '<span class="countdown">Expired</span>';
    if (b.status === "Delivered") return '<span class="countdown">Completed</span>';
    var left = b.expiresAt - now;
    var urgent = left < URGENT_MIN * MIN;
    return '<span class="countdown' + (urgent ? " urgent" : "") + '" data-expires="' + esc(b.expiresAt) + '">' +
      esc(formatCountdown(left)) + "</span>";
  }

  // Updates only the text/classes of [data-expires] elements, once per second.
  // The queue-rail item that holds a countdown gets the same "urgent" state.
  // If a listing crosses its deadline, the lock is applied and the views re-render.
  function tickCountdowns() {
    var now = Date.now();
    if (lockExpired(now)) {
      renderAll();
      return;
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-expires]"), function (el) {
      var left = Number(el.getAttribute("data-expires")) - now;
      var urgent = left < URGENT_MIN * MIN;
      el.classList.toggle("urgent", urgent);
      var row = el.closest ? el.closest(".queue-item") : null;
      if (row) row.classList.toggle("urgent", urgent);
      el.textContent = formatCountdown(left);
    });
  }

  // Restart the 1 s ticker; called after every list re-render.
  // The interval is set before the first tick so a nested re-render never leaves two timers.
  function startTicker() {
    if (tickerId !== null) clearInterval(tickerId);
    tickerId = setInterval(tickCountdowns, 1000);
    tickCountdowns();
  }

  // One detail line for the CURRENT stage, shown beneath the stepper (never inside a step pill).
  // Returns trusted inner HTML, or "" when the current stage has nothing to add.
  function stageDetailHtml(b, idx) {
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    if (!b.rider || !ngo) {
      return '<div class="assignment-banner">Awaiting Smart Match or manual NGO override</div>';
    }
    return '<div class="assignment-banner">' +
      "Rider " + esc(b.rider) + ' \u00B7 <span class="contact-phone">' + esc(riderPhone(b.rider) || "") + "</span><br>" +
      "NGO " + esc(ngo.name) + ' \u00B7 <span class="contact-phone">' + esc(ngo.phone || "") + "</span>" +
      "</div>";
  }


  // Stage index for the progress bar: Posted=0, Claimed/Assigned=1, Collected/Picked Up/In Transit=2,
  // Delivered=3. Expired (and any unmapped status) gives -1, so no step is done or current.
  var STAGE_INDEX = { Posted: 0, Assigned: 1, Claimed: 1, "Picked Up": 2, Collected: 2, "In Transit": 2, Delivered: 3 };
  function stageIndexOf(b) {
    return Object.prototype.hasOwnProperty.call(STAGE_INDEX, b.status) ? STAGE_INDEX[b.status] : -1;
  }

  // Four progress steps with the stage label under each (done / current).
  function trackerHtml(b) {
    var idx = stageIndexOf(b); // -1 for Expired: no step is done or current
    var names = ["Posted", "Claimed", "Collected", "Delivered"];
    var steps = names.map(function (name, i) {
      var cls = "";
      if (idx >= 0 && i < idx) cls = " done";
      else if (idx >= 0 && i === idx) cls = " current";
      return '<div class="progress-step' + cls + '"><span class="progress-label">' + name + "</span></div>";
    }).join("");
    return '<div class="progress-steps">' + steps + "</div>";
  }


  // Radar scale: the 10 km ring sits at RADAR_MAX_PX from the centre (fits the 200 viewBox).
  var RADAR_RINGS_KM = [2, 5, 10];
  var RADAR_MAX_PX = 78;
  function radarPx(km) {
    var px = (Number(km) || 0) * (RADAR_MAX_PX / 10);
    return Math.min(RADAR_MAX_PX, px);
  }

  // Dispatch radar (viewBox 380x280): Caterer Hub at the centre, three dashed distance rings,
  // six NGO pins at fixed slots with label pills, and a route + rider badge for active batches.
  function renderRadar(b) {
    var HUB_X = 190, HUB_Y = 135;
    var CANVAS_W = 380, EDGE = 6, CHAR_W = 6.2, PILL_PAD = 12;
    var SLOTS = [
      { id: "ngo-annapurna", short: "Annapurna", km: 2.1, px: 248, py: 88, lx: 258, ly: 84, anchor: "start" },
      { id: "ngo-asha", short: "Asha", km: 3.2, px: 122, py: 78, lx: 112, ly: 74, anchor: "end" },
      { id: "ngo-hope", short: "Hope St", km: 6.8, px: 266, py: 188, lx: 276, ly: 192, anchor: "start" },
      { id: "ngo-sahayam", short: "Sahayam", km: 9.4, px: 96, py: 196, lx: 86, ly: 200, anchor: "end" },
      { id: "ngo-karuna", short: "Karuna", km: 4.1, px: 292, py: 132, lx: 302, ly: 108, anchor: "start" },
      { id: "ngo-nirmal", short: "Nirmal", km: 5.6, px: 108, py: 138, lx: 98, ly: 118, anchor: "end" }
    ];
    var ngos = state.ngos || [];

    // Match each slot to an NGO by id; if the id is missing, fall back to data.js order.
    var pins = [];
    SLOTS.forEach(function (slot, i) {
      var n = null;
      ngos.forEach(function (x) { if (!n && x.id === slot.id) n = x; });
      if (!n && ngos[i]) n = ngos[i];
      if (!n) return;
      var dk = Number(n.distance_km);
      var km = (n.distance_km !== null && isFinite(dk) && dk !== slot.km) ? dk : slot.km;
      pins.push({
        n: n, px: slot.px, py: slot.py, lx: slot.lx, ly: slot.ly, anchor: slot.anchor,
        label: slot.short + " \u2022 " + km.toFixed(1) + " km"
      });
    });

    // Route and rider only for Claimed / Collected / Delivered batches with an assigned NGO on the radar.
    var progress = b.status === "Claimed" ? 0.30 : b.status === "Collected" ? 0.68 : b.status === "Delivered" ? 1 : null;
    var assigned = null;
    if (progress !== null && b.ngoId) {
      pins.forEach(function (p) { if (!assigned && p.n.id === b.ngoId) assigned = p; });
    }

    // Label pills: width from text estimate, kept inside the canvas with a 6px margin.
    var labels = pins.map(function (p) {
      var w = p.label.length * CHAR_W + PILL_PAD;
      var x = p.anchor === "end" ? p.lx + 6 - w : p.lx - 6;
      x = Math.max(EDGE, Math.min(x, CANVAS_W - EDGE - w));
      var tx = p.anchor === "end" ? x + w - 6 : x + 6;
      return { x: x, y: p.ly - 12, w: w, tx: tx, ty: p.ly };
    });

    var out = '<svg class="radar" viewBox="0 0 380 280" role="img" aria-label="Dispatch radar for ' + esc(b.id) + '">';

    [42, 80, 118].forEach(function (r) {
      out += '<circle class="radar-ring" cx="190" cy="135" r="' + r + '"></circle>';
    });
    [["2 km", 175], ["5 km", 213], ["10 km", 251]].forEach(function (rl) {
      out += '<text class="radar-ring-label" text-anchor="middle" x="190" y="' + rl[1] + '">' + rl[0] + "</text>";
    });

    // Draw order: route, pins, pill rects, label texts, hub, rider.
    if (assigned) {
      out += '<line class="radar-route" x1="190" y1="135" x2="' + assigned.px + '" y2="' + assigned.py + '"></line>';
    }
    pins.forEach(function (p) {
      var on = assigned === p;
      out += '<circle class="radar-pin' + (on ? " radar-pin-assigned" : "") + '" cx="' + p.px + '" cy="' + p.py + '" r="6"></circle>';
    });
    pins.forEach(function (p, i) {
      var L = labels[i];
      var on = assigned === p;
      out += '<rect class="radar-label-pill' + (on ? " radar-label-pill-assigned" : "") + '" x="' + L.x.toFixed(1) +
        '" y="' + L.y + '" width="' + L.w.toFixed(1) + '" height="16" rx="6"></rect>';
    });
    pins.forEach(function (p, i) {
      var L = labels[i];
      out += '<text class="radar-label" text-anchor="' + p.anchor + '" x="' + L.tx.toFixed(1) + '" y="' + L.ty + '">' +
        esc(p.label) + "</text>";
    });

    var hubW = "CATERER HUB".length * CHAR_W + PILL_PAD;
    out += '<circle class="radar-hub-pulse" cx="190" cy="135" r="9"></circle>';
    out += '<circle class="radar-hub" cx="190" cy="135" r="6"></circle>';
    out += '<rect class="radar-pill-bg" x="' + (HUB_X - hubW / 2).toFixed(1) + '" y="158" width="' + hubW.toFixed(1) +
      '" height="16" rx="6"></rect>';
    out += '<text class="radar-hub-label" text-anchor="middle" x="190" y="170">CATERER HUB</text>';

    if (assigned) {
      var bx = (HUB_X + progress * (assigned.px - HUB_X)).toFixed(1);
      var by = (HUB_Y + progress * (assigned.py - HUB_Y)).toFixed(1);
      if (b.status !== "Delivered") {
        out += '<circle class="radar-rider-halo" cx="' + bx + '" cy="' + by + '" r="11"></circle>';
      }
      out += '<circle class="radar-rider" cx="' + bx + '" cy="' + by + '" r="7"></circle>';
      out += '<text class="radar-rider-text" x="' + bx + '" y="' + (Number(by) + 3).toFixed(1) +
        '" text-anchor="middle">R</text>';
    }
    return out + "</svg>";
  }



  // Listing card: .batch-card with a card-header (icon, dish, batch id, status badge), a 2x2 meta-grid,
  // progress steps, assignment banner, radar, safety note, then the .card-actions footer.
  // actionHtml is trusted markup built by this file (ids are escaped).
  function cardHtml(b, now, actionHtml) {
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var isVeg = b.diet === "Veg";
    var closed = b.status === "Delivered" || b.status === "Expired";
    var left = b.expiresAt - now;
    var urgent = !closed && left < URGENT_MIN * MIN;
    var icon = isVeg ? '<i data-lucide="leaf" aria-hidden="true"></i>' : '<i data-lucide="flame" aria-hidden="true"></i>';
    // Distance: the assigned NGO if there is one, otherwise the nearest NGO in the registry.
    var ref = ngo;
    if (!ref && state.ngos.length) {
      ref = state.ngos.reduce(function (a, c) {
        return Number(c.distance_km) < Number(a.distance_km) ? c : a;
      });
    }
    var distText = ref && ref.distance_km != null ? Number(ref.distance_km).toFixed(1) + " km" : "\u2014";
    var timeLeft;
    if (b.status === "Delivered") {
      timeLeft = '<span class="meta-value">Completed</span>';
    } else if (b.status === "Expired") {
      timeLeft = '<span class="meta-value">Expired</span>';
    } else {
      timeLeft = '<span class="meta-value countdown' + (urgent ? " urgent" : "") + '" data-expires="' +
        esc(b.expiresAt) + '">' + esc(formatCountdown(left)) + "</span>";
    }
    var storage = b.storage ? " \u2022 " + esc(b.storage) : "";
    var html = '<article class="card batch-card' + (urgent ? " urgent" : "") + '" data-status="' + esc(b.status) + '">';
    html += '<div class="card-header"><div class="card-title-group"><span class="card-icon ' +
      (isVeg ? "veg" : "nonveg") + '">' + icon + "</span>" +
      '<div><h3 class="card-title">' + esc(b.food) + '</h3><p class="card-subtitle">' + esc(b.id) + "</p></div>" +
      "</div>" + badgeHtml(b.status) + "</div>";
    html += '<div class="meta-grid">' +
      '<div class="meta-pill"><span class="meta-label">Quantity</span><span class="meta-value">' +
      esc(fmtNum(b.kg)) + " kg \u2022 " + esc(mealsFor(b.kg)) + " meals</span></div>" +
      '<div class="meta-pill"><span class="meta-label">Diet &amp; Storage</span><span class="meta-value">' +
      esc(b.diet) + storage + "</span></div>" +
      '<div class="meta-pill"><span class="meta-label">Locality &amp; Distance</span><span class="meta-value">' +
      esc(b.locality) + " \u2022 " + esc(distText) + "</span></div>" +
      '<div class="meta-pill' + (urgent ? " urgent" : "") + '"><span class="meta-label">Time Left</span>' +
      timeLeft + "</div>" +
      "</div>";
    html += trackerHtml(b);
    html += stageDetailHtml(b, stageIndexOf(b));
    html += '<div class="radar-wrap">' + renderRadar(b) + "</div>";
    html += '<p class="safety-note">Logistics only</p>';
    html += cardFooterHtml(b, actionHtml);
    html += "</article>";
    return html;
  }


  // Footer content: forward actions plus the handling guide while the batch is open.
  // Delivered and Expired batches have no actions, so a status line is shown instead.
  function cardFooterHtml(b, actionHtml) {
    var footer = actionHtml || "";
    if (isOpenStatus(b)) {
      footer += '<button type="button" class="btn btn-secondary" data-action="handling" data-id="' + esc(b.id) +
        '">Handling guide</button>';
    }
    if (!footer) {
      if (b.status === "Delivered") {
        footer = '<p class="card-status">' + esc("Delivered \u2022 +" + creditsFor(b) + " impact credits") + "</p>" +
          handoverButtonHtml(b.id);
      } else if (b.status === "Expired") {
        footer = '<p class="card-status">' + esc("Expired \u2014 Do Not Distribute") + "</p>";
      } else {
        footer = '<p class="card-status">' + esc(b.status) + "</p>";
      }
    }
    return '<div class="card-actions">' + footer + "</div>";
  }




  // ---------- render: view 1 (caterer) ----------
  function populateCatererFilter() {
    var sel = $("caterer-filter");
    var names = [];
    state.batches.forEach(function (b) {
      if (names.indexOf(b.caterer) === -1) names.push(b.caterer);
    });
    names.sort();
    sel.innerHTML = '<option value="">All caterers</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    }).join("");
    if (names.indexOf(state.catererFilter) === -1) state.catererFilter = "";
    sel.value = state.catererFilter;
  }

  function renderCatererList() {
    var now = Date.now();
    lockExpired(now);

    var list = state.batches.filter(function (b) {
      return (!state.catererFilter || b.caterer === state.catererFilter) && matchesFilters(b) &&
        personaAllows(b, "caterer");
    }).sort(function (a, b) { return b.preparedAt - a.preparedAt; });

    var box = $("caterer-list");
    if (box) {
      if (!list.length) {
        box.innerHTML = state.activeRole === "ramesh"
          ? '<p class="empty">No batches from ' + esc(RAMESH_CATERER) + " yet</p>"
          : emptyHtml("No batches yet. Post one using the form.");
      } else {
        box.innerHTML = list.map(function (b) {
          return cardHtml(b, now, personaActionHtml(b));
        }).join("");
      }
    }
    renderQueueRail();
    startTicker();
  }

  function renderLocalitySelect() {
    var sel = $("locality-select");
    if (sel.options.length) return;
    sel.innerHTML = Object.keys(D.LOCALITIES).map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + "</option>";
    }).join("");
  }

  // ---------- render: view 2 (feed) ----------
  function renderNgoPanel() {
    var panel = $("ngo-panel");
    if (!panel) return;
    panel.innerHTML = state.ngos.map(function (n) {
      return '<article class="card ngo-card">' +
        '<div class="card-header"><div class="card-title-group"><span class="card-icon"><i data-lucide="utensils" aria-hidden="true"></i></span>' +
        '<div><h3 class="card-title">' + esc(n.name) + '</h3><p class="card-subtitle">' + esc(n.locality) + "</p></div>" +
        "</div></div>" +
        '<div class="meta-grid">' +
        '<div class="meta-pill"><span class="meta-label">Locality</span><span class="meta-value">' + esc(n.locality) + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Capacity</span><span class="meta-value">' + esc(n.capacity) + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Distance (km)</span><span class="meta-value">' + esc(fmtNum(n.distance_km)) + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Preference</span><span class="meta-value">' + esc(n.pref) + "</span></div>" +
        "</div>" +
        '<p class="meta"><span class="contact-phone">' + esc(n.phone || "") + "</span></p>" +
        "</article>";
    }).join("");
  }


  // Dispatch filter predicates. Urgent = under URGENT_MIN minutes left (not Delivered/Expired).
  // In Transit = rider assigned (Claimed or Collected).
  function passesDispatchFilter(b, now) {
    var f = state.dispatchFilter;
    if (f === "urgent") return isUrgent(b, now);
    if (f === "posted") return b.status === "Posted";
    if (f === "transit") return isLive(b);
    if (f === "delivered") return b.status === "Delivered";
    return true;
  }

  // Header search + locality filter. Empty state.searchQuery / state.localityFilter = no restriction.
  function filtersActive() {
    return !!(state.searchQuery || state.localityFilter);
  }

  function matchesFilters(b) {
    if (!b) return false;
    var q = String(state.searchQuery || "").toLowerCase();
    if (q) {
      var cat = b.caterer && typeof b.caterer === "object" ? (b.caterer.name || "") : b.caterer;
      var fields = [b.id, b.food, cat, b.locality, b.status];
      var hit = fields.some(function (f) {
        return String(f || "").toLowerCase().indexOf(q) !== -1;
      });
      if (!hit) return false;
    }
    if (state.localityFilter && b.locality !== state.localityFilter) return false;
    return true;
  }

  // Empty-list markup: a filter-specific message when a filter is active, otherwise the original message.
  function emptyHtml(fallback) {
    return filtersActive()
      ? '<p class="empty-state">No matching batches found</p>'
      : '<p class="empty">' + fallback + "</p>";
  }

  function populateHeaderLocality() {
    var sel = $("header-locality-select");
    if (!sel) return;
    if (LOCALITY_LIST.indexOf(state.localityFilter) === -1) state.localityFilter = "";
    sel.innerHTML = '<option value="">All localities</option>' + LOCALITY_LIST.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    }).join("");
    sel.value = state.localityFilter;
  }

  // Pill state for #dispatch-filters: one active button, aria-pressed mirrors it.
  function syncDispatchFilterButtons() {
    var bar = $("dispatch-filters");
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll("[data-filter]"), function (btn) {
      var on = btn.getAttribute("data-filter") === state.dispatchFilter;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function renderFeed() {
    var now = Date.now();
    lockExpired(now);
    renderNgoPanel();
    $("feed-msg").textContent = state.feedMsg;
    syncDispatchFilterButtons();

    var posted = state.batches.filter(function (b) { return b.status === "Posted" && passesDispatchFilter(b, now) && matchesFilters(b) && personaAllows(b, "feed"); })
      .sort(function (a, b) { return a.expiresAt - b.expiresAt; });
    var postedBox = $("feed-posted");
    if (postedBox) {
      postedBox.innerHTML = posted.length ? posted.map(function (b) {
        return cardHtml(b, now, feedActionsHtml(b) + personaActionHtml(b));
      }).join("") : emptyHtml("No open batches right now.");
    }

    var active = state.batches.filter(function (b) { return b.status !== "Posted" && passesDispatchFilter(b, now) && matchesFilters(b) && personaAllows(b, "feed"); })
      .sort(function (a, b) { return b.preparedAt - a.preparedAt; });
    var activeBox = $("feed-active");
    if (activeBox) {
      activeBox.innerHTML = active.length ? active.map(function (b) {
        return cardHtml(b, now, feedActionsHtml(b) + personaActionHtml(b));
      }).join("") : emptyHtml("No active rescues yet.");
    }
    renderQueueRail();
    startTicker();
  }

  // Right-hand live queue rail: one item per active batch (not Delivered/Expired), soonest deadline first.
  // Items under URGENT_MIN minutes get "urgent"; the ticker keeps the countdowns current.
  function renderQueueRail() {
    var list = $("queue-rail-list");
    if (!list) return;
    var now = Date.now();
    var active = state.batches.filter(function (b) {
      return b.status !== "Delivered" && b.status !== "Expired" && matchesFilters(b);
    }).sort(function (a, b) { return (a.expiresAt - now) - (b.expiresAt - now); });
    if (!active.length) {
      list.innerHTML = emptyHtml("No active batches");
      return;
    }
    list.innerHTML = active.map(function (b) {
      var urgent = b.expiresAt - now < URGENT_MIN * MIN;
      return '<div class="queue-item' + (urgent ? " urgent" : "") + '">' +
        '<div class="queue-item-top"><span class="batch-id-pill">' + esc(b.id) + "</span>" +
        urgencyHtml(b, now) + "</div>" +
        '<p class="queue-item-dish">' + esc(b.food) + "</p>" +
        '<p class="queue-item-status">' + esc(b.status) + "</p>" +
        "</div>";
    }).join("");
  }



  // ---------- pure ledger / ESG logic (no DOM) ----------
  function postedAtOf(b) {
    return b.postedAt !== undefined && b.postedAt !== null ? b.postedAt : eventAt(b, "Posted");
  }

  function deliveredAtOf(b) {
    return b.deliveredAt !== undefined && b.deliveredAt !== null ? b.deliveredAt : eventAt(b, "Delivered");
  }

  // Totals across Delivered batches only; Expired batches never count.
  function computeLedgerTotals(batches) {
    var kgRescued = 0;
    var turnSum = 0;
    var turnCount = 0;
    var ngoIds = [];
    var deliveredCount = 0;
    batches.forEach(function (b) {
      if (b.status !== "Delivered") return;
      deliveredCount += 1;
      kgRescued += Number(b.kg) || 0;
      var posted = postedAtOf(b);
      var delivered = deliveredAtOf(b);
      if (posted !== null && delivered !== null) {
        turnSum += (delivered - posted) / MIN;
        turnCount += 1;
      }
      if (b.ngoId && ngoIds.indexOf(b.ngoId) === -1) ngoIds.push(b.ngoId);
    });
    var meals = Math.round(kgRescued / MEAL_KG);
    return {
      meals: meals,
      kgRescued: kgRescued,
      co2Kg: Math.round(kgRescued * CO2_FACTOR * 10) / 10,
      valueInr: meals * MEAL_VALUE_INR,
      avgTurnaroundMin: turnCount ? Math.round(turnSum / turnCount) : 0,
      deliveredCount: deliveredCount,
      ngosServed: ngoIds.length
    };
  }

  // ESG summary for one caterer, calendar month of nowMs. Expired batches are excluded.
  function buildEsgSummary(caterer, batches, nowMs) {
    var now = new Date(nowMs);
    var year = now.getFullYear();
    var month = now.getMonth();
    function inThisMonth(ms) {
      if (ms === null || ms === undefined) return false;
      var d = new Date(ms);
      return d.getFullYear() === year && d.getMonth() === month;
    }
    var rescues = 0;
    var deliveredKg = 0;
    var postedKg = 0;
    batches.forEach(function (b) {
      if (b.caterer !== caterer || b.status === "Expired") return;
      var kg = Number(b.kg) || 0;
      if (inThisMonth(postedAtOf(b))) postedKg += kg;
      if (b.status === "Delivered" && inThisMonth(deliveredAtOf(b))) {
        rescues += 1;
        deliveredKg += kg;
      }
    });
    var score = postedKg > 0 ? Math.round(100 * deliveredKg / postedKg) : 0;
    return {
      caterer: caterer,
      monthLabel: now.toLocaleString("en-IN", { month: "long", year: "numeric" }),
      monthlyRescues: rescues,
      monthlyKg: deliveredKg,
      monthlyMeals: Math.round(deliveredKg / MEAL_KG),
      zeroWasteScore: Math.max(0, Math.min(100, score)),
      co2Kg: Math.round(deliveredKg * CO2_FACTOR * 10) / 10
    };
  }

  // ---------- pure business-model logic (no DOM) ----------
  // Illustrative planning assumptions (not measured, not sourced). They drive only the cost-per-meal KPI:
  // cost per meal = (total rescues x rider cost per rescue + fixed platform cost per month) / meals rescued.
  // Defaults (50 caterers x 12 rescues x 20 kg) give 600 rescues, 30,000 meals, 24,000 INR -> INR 0.80 / meal.
  var RIDER_COST_PER_RESCUE_INR = 30;
  var PLATFORM_FIXED_COST_INR_PER_MONTH = 6000;

  // Tier 1 MRR = caterers x 1999. Tier 2 CSR logistics credits = total rescues x CSR share x 40.
  // Tier 2 is reported separately from MRR and added only to total platform revenue.
  // csrSharePct is 0-100; invalid or negative inputs are clamped to 0.
  function calcBusinessModel(input) {
    var caterers = Math.max(0, Number(input.caterers) || 0);
    var rescuesPerCaterer = Math.max(0, Number(input.rescuesPerMonth) || 0);
    var kgPerRescue = Math.max(0, Number(input.kgPerRescue) || 0);
    var savingsPct = Math.max(0, Number(input.savingsPct) || 0);
    var rawSpendInr = Math.max(0, Number(input.rawSpendInr) || 0);
    var csrShare = Math.min(100, Math.max(0, Number(input.csrSharePct) || 0)) / 100;

    var mrr = caterers * SUBSCRIPTION_INR;
    var perCatererSavings = rawSpendInr * savingsPct / 100;
    var perCatererNet = perCatererSavings - SUBSCRIPTION_INR;
    var perCatererRoi = SUBSCRIPTION_INR > 0 ? perCatererSavings / SUBSCRIPTION_INR : 0;
    var totalSavings = caterers * perCatererSavings;

    var totalRescues = caterers * rescuesPerCaterer;
    var csrRescues = totalRescues * csrShare;
    var tier2Inr = csrRescues * TIER2_PER_RESCUE_INR;
    var totalPlatformRevenue = mrr + tier2Inr;

    var rescuedKg = totalRescues * kgPerRescue;
    var meals = rescuedKg / MEAL_KG;
    var logisticsInr = totalRescues * RIDER_COST_PER_RESCUE_INR + PLATFORM_FIXED_COST_INR_PER_MONTH;

    return {
      mrr: mrr,
      perCatererSavings: perCatererSavings,
      perCatererNet: perCatererNet,
      perCatererRoi: perCatererRoi,
      totalSavings: totalSavings,
      tier2Inr: tier2Inr,
      totalPlatformRevenue: totalPlatformRevenue,
      arr: totalPlatformRevenue * 12,
      totalMealsPerMonth: Math.round(meals),
      rescuedKg: rescuedKg,
      co2Kg: rescuedKg * CO2_FACTOR,
      costPerMeal: meals > 0 ? logisticsInr / meals : null
    };
  }

  // ---------- render: view 3 (impact / ESG ledger) ----------
  function kpiCardHtml(label, value, unit, extraCls) {
    return '<div class="kpi-card' + (extraCls ? " " + extraCls : "") + '">' +
      '<div class="kpi-label">' + esc(label) + "</div>" +
      '<div class="kpi-value">' + esc(value) + "</div>" +
      '<div class="kpi-unit">' + esc(unit) + "</div>" +
      "</div>";
  }

  function renderLedgerKpis(t) {
    var el = $("ledger-kpis");
    if (!el) return;
    el.innerHTML =
      kpiCardHtml("Total Meals Served", fmtNum(t.meals), "meals \u00B7 value saved " + fmtInr(t.valueInr), "") +
      kpiCardHtml("Edible Food Rescued", fmtNum(t.kgRescued), "kg", "") +
      kpiCardHtml("CO2e Emissions Prevented", fmtNum(t.co2Kg), "kg CO2e", "kpi-emerald") +
      kpiCardHtml("Average Rescue Turnaround Time", fmtNum(t.avgTurnaroundMin), "min", "");
  }

  // One row per batch event, oldest first. Shared by the table and the CSV export.
  function ledgerRows() {
    var rows = [];
    state.batches.forEach(function (b) {
      (b.events || []).forEach(function (e) {
        var ngo = b.ngoId ? ngoById(b.ngoId) : null;
        rows.push({
          at: e.at,
          batchId: b.id,
          caterer: b.caterer,
          event: e.type,
          ngo: ngo ? ngo.name : "-",
          rider: b.rider || "-"
        });
      });
    });
    rows.sort(function (a, c) { return a.at - c.at; });
    return rows;
  }

  // Status pill for a ledger event. Class key is the lowercase event name (evt-posted, evt-delivered, ...).
  function eventPillHtml(name) {
    var key = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
    return '<span class="evt-pill evt-' + esc(key) + '">' + esc(name) + "</span>";
  }

  function renderLedgerEvents() {
    var body = $("ledger-events-body");
    if (!body) return;
    var rows = ledgerRows();
    body.innerHTML = rows.length ? rows.map(function (r) {
      return "<tr>" +
        "<td>" + esc(hhmm(r.at)) + "</td>" +
        "<td>" + esc(r.batchId) + "</td>" +
        "<td>" + esc(r.caterer) + "</td>" +
        "<td>" + eventPillHtml(r.event) +
        (r.event === "Delivered" ? " " + handoverButtonHtml(r.batchId) : "") + "</td>" +
        "<td>" + esc(r.ngo) + "</td>" +
        "<td>" + esc(r.rider) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="6">No events yet.</td></tr>';
  }

  // ---------- v5 charts (pure HTML/CSS, no libraries) ----------
  var CHART_BAR_MAX_PX = 140;

  // Percent of a total, guarded against zero.
  function chartPct(part, total) {
    return total > 0 ? Math.round(100 * part / total) : 0;
  }

  // Kg per diet (Veg / Non-Veg) for batches matching the filter.
  function dietKgWhere(filter) {
    var kg = { Veg: 0, "Non-Veg": 0 };
    state.batches.forEach(function (b) {
      if (filter(b) && Object.prototype.hasOwnProperty.call(kg, b.diet)) kg[b.diet] += Number(b.kg) || 0;
    });
    return kg;
  }

  // Left card: per locality, rescued kg (Delivered) stacked under pipeline kg (open statuses).
  function localityBarsHtml() {
    var rows = LOCALITY_LIST.map(function (name) {
      var rescued = 0;
      var pipeline = 0;
      state.batches.forEach(function (b) {
        if (b.locality !== name) return;
        var kg = Number(b.kg) || 0;
        if (b.status === "Delivered") rescued += kg;
        else if (isOpenStatus(b)) pipeline += kg;
      });
      return { name: name, rescued: rescued, pipeline: pipeline, total: rescued + pipeline };
    });
    var max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.total; })));
    var cols = rows.map(function (r) {
      var rPx = Math.round(CHART_BAR_MAX_PX * r.rescued / max);
      var pPx = Math.round(CHART_BAR_MAX_PX * r.pipeline / max);
      var label = r.total > 0 ? fmtNum(r.total) + " kg" : "0 kg";
      return '<div class="bar-col">' +
        '<span class="chart-value">' + esc(label) + "</span>" +
        '<div class="bar-stack" role="img" aria-label="' + esc(r.name + ": " + fmtNum(r.rescued) +
        " kg rescued, " + fmtNum(r.pipeline) + " kg pipeline") + '">' +
        '<span class="bar-seg bar-pipeline" style="height: ' + pPx + 'px"></span>' +
        '<span class="bar-seg bar-rescued" style="height: ' + rPx + 'px"></span>' +
        "</div>" +
        '<span class="bar-label">' + esc(r.name) + "</span>" +
        "</div>";
    }).join("");
    return '<section class="chart-card">' +
      "<h3>Surplus Rescued by Hyderabad Locality</h3>" +
      '<div class="bar-chart">' + cols + "</div>" +
      '<p class="chart-note">Rescued (Delivered) in emerald, active pipeline in orange.</p>' +
      "</section>";
  }

  // One Veg / Non-Veg row: kg label, dual-segment track, and percentage per segment.
  function dietMixRowHtml(label, kg) {
    var total = kg.Veg + kg["Non-Veg"];
    var vegW = total > 0 ? 100 * kg.Veg / total : 0;
    var nonW = total > 0 ? 100 * kg["Non-Veg"] / total : 0;
    var text = total > 0
      ? fmtNum(kg["Non-Veg"]) + " kg Non-Veg \u2022 " + fmtNum(kg.Veg) + " kg Veg"
      : "0 kg";
    var pctText = total > 0
      ? "Veg " + chartPct(kg.Veg, total) + "% \u00B7 Non-Veg " + chartPct(kg["Non-Veg"], total) + "%"
      : "No rescues yet";
    return '<div class="mix-row">' +
      '<div class="mix-head"><span class="mix-label">' + esc(label) + "</span>" +
      '<span class="chart-value">' + esc(text) + "</span></div>" +
      '<div class="mix-track">' +
      '<span class="mix-veg" style="width: ' + vegW.toFixed(2) + '%"></span>' +
      '<span class="mix-nonveg" style="width: ' + nonW.toFixed(2) + '%"></span>' +
      "</div>" +
      '<div class="mix-pct">' + esc(pctText) + "</div>" +
      "</div>";
  }

  // Right card: Veg vs Non-Veg split for Delivered and for the open pipeline. Returns HTML only.
  function renderCategoryBars() {
    var delivered = dietKgWhere(function (b) { return b.status === "Delivered"; });
    var pipeline = dietKgWhere(function (b) { return isOpenStatus(b); });
    return '<section class="chart-card">' +
      "<h3>Veg vs. Non-Veg Rescue Mix</h3>" +
      dietMixRowHtml("Delivered", delivered) +
      dietMixRowHtml("Active Pipeline", pipeline) +
      "</section>";
  }

  // Writes the two-column analytics row into #category-bars (above the ledger table).
  function renderImpactCharts() {
    var el = $("category-bars");
    if (!el) return;
    el.innerHTML = '<div class="chart-row">' + localityBarsHtml() + renderCategoryBars() + "</div>";
  }

  // Quotes every field and doubles embedded quotes (RFC 4180 style).
  function csvField(v) {
    return '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"';
  }

  function downloadAuditCsv() {
    var lines = [["Timestamp", "Batch ID", "Caterer", "Event", "NGO", "Rider"]];
    ledgerRows().forEach(function (r) {
      lines.push([new Date(r.at).toISOString(), r.batchId, r.caterer, r.event, r.ngo, r.rider]);
    });
    var csv = lines.map(function (cols) {
      return cols.map(csvField).join(",");
    }).join("\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "annasetu-audit-log.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function renderImpact() {
    renderLedgerKpis(computeLedgerTotals(state.batches));
    renderImpactCharts();
    renderLedgerEvents();
  }

  // Caterer dropdown: unique names, current selection kept when still present.
  function populateEsgSelect() {
    var sel = $("esg-caterer-select");
    if (!sel) return;
    var prev = sel.value;
    var names = [];
    state.batches.forEach(function (b) {
      if (names.indexOf(b.caterer) === -1) names.push(b.caterer);
    });
    names.sort();
    sel.innerHTML = names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    }).join("");
    if (names.indexOf(prev) !== -1) sel.value = prev;
  }

  function renderEsgPreview(s) {
    var box = $("esg-report-preview");
    if (!box) return;
    if (!s) {
      box.innerHTML = '<p class="hint">No caterer selected</p>';
      return;
    }
    box.innerHTML =
      '<div class="esg-report">' +
      "<h3>" + esc("Caterer ESG Impact Report \u2014 " + s.caterer + " \u2014 " + s.monthLabel) + "</h3>" +
      "<ul>" +
      "<li>" + esc("Monthly rescues: " + s.monthlyRescues) + "</li>" +
      "<li>" + esc("Food rescued: " + fmtNum(s.monthlyKg) + " kg") + "</li>" +
      "<li>" + esc("Meals equivalent: " + fmtNum(s.monthlyMeals) + " meals (kg \u00F7 0.4)") + "</li>" +
      "<li>" + esc("CO2e prevented: " + fmtNum(s.co2Kg) + " kg (kg \u00D7 2.5)") + "</li>" +
      "<li>" + esc("Zero-waste score: " + s.zeroWasteScore + "% (Delivered kg \u00F7 posted kg this month \u00D7 100)") + "</li>" +
      "</ul>" +
      "</div>";
  }

  function onEsgGenerate() {
    var sel = $("esg-caterer-select");
    var printBtn = $("esg-print-btn");
    var name = sel ? sel.value : "";
    if (!name) {
      renderEsgPreview(null);
      if (printBtn) printBtn.classList.add("hidden");
      return;
    }
    renderEsgPreview(buildEsgSummary(name, state.batches, Date.now()));
    if (printBtn) printBtn.classList.remove("hidden");
  }

  // ---------- render: business model & ROI ----------
  function setTextIfPresent(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  // Result card: main line set with textContent; optional sub-line added as a child element.
  function setCardText(id, main, note) {
    var el = $(id);
    if (!el) return;
    el.textContent = main;
    if (note) {
      var sub = document.createElement("div");
      sub.className = "kpi-unit";
      sub.textContent = note;
      el.appendChild(sub);
    }
  }

  // Slider / number input value, or the fallback when the element is missing or invalid.
  function bmInputValue(id, fallback) {
    var el = $(id);
    if (!el) return fallback;
    var v = Number(el.value);
    return isFinite(v) && v >= 0 ? v : fallback;
  }

  function bmInt(n) {
    var v = Math.round(n);
    return typeof v.toLocaleString === "function" ? v.toLocaleString("en-IN") : String(v);
  }

  function renderBusinessModel() {
    var caterers = Math.round(bmInputValue("bm-caterers", 50));
    var rescues = Math.round(bmInputValue("bm-rescues", 12));
    var kg = bmInputValue("bm-kg", 20);
    var savingsPct = bmInputValue("bm-waste-pct", 10);
    var rawSpend = bmInputValue("bm-raw-spend", 150000);
    var csrShare = Math.round(bmInputValue("roi-csr-share", 20));

    setTextIfPresent("bm-caterers-out", String(caterers));
    setTextIfPresent("bm-rescues-out", String(rescues));
    setTextIfPresent("bm-kg-out", kg + " kg");
    setTextIfPresent("bm-waste-pct-out", savingsPct + "%");
    setTextIfPresent("roi-csr-share-val", csrShare + "%");

    var r = calcBusinessModel({
      caterers: caterers,
      rescuesPerMonth: rescues,
      kgPerRescue: kg,
      savingsPct: savingsPct,
      rawSpendInr: rawSpend,
      csrSharePct: csrShare
    });

    setCardText("bm-mrr", "MRR \u20B9" + bmInt(r.mrr) + " / month", "SaaS subscriptions only");
    setCardText("bm-savings", "Caterer raw-material savings \u20B9" + bmInt(r.perCatererSavings) +
      " / month per caterer", "vs subscription \u20B9" + bmInt(SUBSCRIPTION_INR));
    setCardText("bm-roi", "ROI for caterer: " + r.perCatererRoi.toFixed(1) + "x", "savings \u00F7 subscription");
    setCardText("bm-meals", "Meals rescued / month at scale: " + bmInt(r.totalMealsPerMonth), "");

    setTextIfPresent("bm-formula",
      "MRR = caterers \u00D7 \u20B9" + bmInt(SUBSCRIPTION_INR) +
      " \u00B7 Caterer savings = raw spend \u00D7 savings% " +
      "\u00B7 ROI = savings \u00F7 \u20B9" + bmInt(SUBSCRIPTION_INR) +
      " \u00B7 Meals = caterers \u00D7 rescues \u00D7 kg \u00F7 0.4 " +
      "\u00B7 CSR credits = rescues \u00D7 CSR share \u00D7 \u20B9" + bmInt(TIER2_PER_RESCUE_INR) +
      " \u00B7 Total platform revenue = MRR + CSR credits");

    renderRoiKpis(r);
    renderRoiChart(r);
  }

  // v5 ROI chart block (#roi-chart), created after #kpi-grid if absent. Reads the same calcBusinessModel result as the KPIs.
  function renderRoiChart(r) {
    var el = $("roi-chart");
    if (!el) {
      var kpi = $("kpi-grid");
      if (!kpi || !kpi.parentNode) return;
      el = document.createElement("div");
      el.id = "roi-chart";
      el.className = "roi-chart";
      kpi.parentNode.insertBefore(el, kpi.nextSibling);
    }
    var cost = SUBSCRIPTION_INR;
    var savings = isFinite(r.perCatererSavings) ? r.perCatererSavings : 0;
    var roiText = isFinite(r.perCatererRoi) ? r.perCatererRoi.toFixed(1) + "x" : "\u2014";
    var maxA = Math.max(1, cost, savings);
    function barRow(label, value, cls) {
      return '<div class="roi-bar-row">' +
        '<div class="roi-bar-head"><span>' + esc(label) + '</span><span class="chart-value">\u20B9' +
        esc(bmInt(value)) + "</span></div>" +
        '<div class="roi-bar-track"><span class="roi-bar-fill ' + cls + '" style="width: ' +
        (100 * value / maxA).toFixed(2) + '%"></span></div>' +
        "</div>";
    }

    var mrr = Number(r.mrr) || 0;
    var csr = Number(r.tier2Inr) || 0;
    var mixTotal = mrr + csr;
    var mrrW = mixTotal > 0 ? 100 * mrr / mixTotal : 0;
    var csrW = mixTotal > 0 ? 100 * csr / mixTotal : 0;

    el.innerHTML =
      '<div class="chart-row">' +
      '<section class="chart-card">' +
      "<h3>Caterer monthly economics</h3>" +
      barRow("Caterer SaaS cost", cost, "roi-bar-saas") +
      barRow("Raw-material waste saved", savings, "roi-bar-waste") +
      '<p class="chart-note">Savings gap: <strong>' + esc(roiText) + "</strong> (raw-material waste saved \u00F7 SaaS cost)</p>" +
      "</section>" +
      '<section class="chart-card">' +
      "<h3>Platform revenue mix</h3>" +
      '<div class="roi-mix-track">' +
      '<span class="roi-seg-mrr" style="width: ' + mrrW.toFixed(2) + '%"></span>' +
      '<span class="roi-seg-csr" style="width: ' + csrW.toFixed(2) + '%"></span>' +
      "</div>" +
      '<div class="roi-mix-legend">' +
      '<span><i class="roi-dot roi-seg-mrr"></i>SaaS MRR \u20B9' + esc(bmInt(mrr)) +
      " (" + chartPct(mrr, mixTotal) + "%)</span>" +
      '<span><i class="roi-dot roi-seg-csr"></i>CSR Delivery Credits \u20B9' + esc(bmInt(csr)) +
      " (" + chartPct(csr, mixTotal) + "%)</span>" +
      "</div>" +
      "</section>" +
      "</div>";
  }

  // Six KPI cards in #kpi-grid. Every value is computed from the sliders via calcBusinessModel.
  function renderRoiKpis(r) {
    var el = $("kpi-grid");
    if (!el) return;
    var roiText = isFinite(r.perCatererRoi) ? r.perCatererRoi.toFixed(1) + "x" : "\u2014";
    var cpmText = r.costPerMeal === null ? "\u2014" : "\u20B9" + r.costPerMeal.toFixed(2) + " / meal";
    el.innerHTML =
      kpiCardHtml("Total Monthly Platform Revenue", "\u20B9" + bmInt(r.totalPlatformRevenue) + " / mo",
        "SaaS MRR (caterers \u00D7 \u20B9" + bmInt(SUBSCRIPTION_INR) + ") + CSR logistics credits " +
        "(rescues/mo \u00D7 CSR share \u00D7 \u20B9" + bmInt(TIER2_PER_RESCUE_INR) + ")", "") +
      kpiCardHtml("Annualized Run Rate (ARR)", "\u20B9" + bmInt(r.arr) + " / yr",
        "Total monthly revenue \u00D7 12", "") +
      kpiCardHtml("Caterer Net Monthly Savings", "\u20B9" + bmInt(r.perCatererNet) + " / mo",
        "(raw food spend \u00D7 waste reduction %) \u2212 \u20B9" + bmInt(SUBSCRIPTION_INR) + " per caterer", "") +
      kpiCardHtml("Caterer ROI Multiple", roiText,
        "raw food savings per caterer \u00F7 \u20B9" + bmInt(SUBSCRIPTION_INR), "kpi-emerald") +
      kpiCardHtml("Cost Per Meal Rescued", cpmText,
        "Assumption: rider cost per rescue (\u20B9" + bmInt(RIDER_COST_PER_RESCUE_INR) + ") + \u20B9" +
        bmInt(PLATFORM_FIXED_COST_INR_PER_MONTH) + " fixed platform cost per month, \u00F7 meals rescued", "") +
      kpiCardHtml("Monthly Meals & CO2e Impact at Scale", bmInt(r.totalMealsPerMonth) + " meals",
        "CO2e " + bmInt(r.co2Kg) + " kg (rescued kg \u00D7 " + CO2_FACTOR + "); meals = kg \u00F7 " + MEAL_KG,
        "kpi-emerald");
  }

  // Static Monetization Stream cards (#revenue-streams). Rendered once from initRoiTab().
  var ROI_STREAMS = [
    {
      title: "Caterer SaaS & Kitchen Waste Intelligence",
      price: "\u20B91,999 / mo per caterer",
      note: "Pays for itself 7.5x by cutting raw-material overproduction by 8\u201312% (default assumptions)."
    },
    {
      title: "Corporate CSR Logistics Credits",
      price: "\u20B940 / rescue or \u20B912,000 / mo CSR packs",
      note: "Hyderabad IT parks & corporates fund last-mile EV rider stipends with auditable ESG impact."
    },
    {
      title: "Convention Center & Hotel Zero-Waste Compliance",
      price: "\u20B99,999 / mo enterprise tier",
      note: "Bulk municipal solid-waste diversion reporting for large venues."
    }
  ];

  function renderRevenueStreams() {
    var el = $("revenue-streams");
    if (!el) return;
    el.innerHTML = ROI_STREAMS.map(function (s) {
      return '<article class="pillar-card"><h3>' + esc(s.title) + '</h3><p class="price">' + esc(s.price) +
        "</p><p>" + esc(s.note) + "</p></article>";
    }).join("");
  }

  // Static "Why Caterers & Sponsors Pay" comparison (#value-matrix). Rendered once from initRoiTab().
  var VALUE_MATRIX_ROWS = [
    ["Cost of surplus disposal",
      "Surplus goes to landfill; disposal and hauling costs are not recovered",
      "Surplus routed to partner NGOs by rider; disposal cost avoided for each completed pickup"],
    ["Raw-material overproduction visibility",
      "No record of which dishes are repeatedly over-cooked",
      "Dish-level waste pattern alert; 8\u201312% raw-material saving target"],
    ["Compliance / MSW diversion proof",
      "No diversion record for municipal solid-waste reporting",
      "Timestamped batch ledger and monthly diversion summary (kg, CO2e)"],
    ["ESG / CSR auditability",
      "ESG claims are anecdotal and hard to verify",
      "Batch-level CSV audit log behind every ESG summary"],
    ["Community impact",
      "Surplus meals are lost",
      "Meals routed to NGOs (kg \u00F7 0.4 kg per meal)"],
    ["Setup & rider logistics",
      "Caterer staff arrange ad hoc transport",
      "Rider dispatch with assigned vehicle, ETA and contact numbers"],
    ["Price (per caterer)",
      "No subscription; disposal cost unrecovered",
      "\u20B91,999 / month SaaS subscription"]
  ];

  function renderValueMatrix() {
    var el = $("value-matrix");
    if (!el) return;
    var head = "<tr><th>Dimension</th><th>Status Quo (Landfill / Disposal Loss)</th><th>AnnaSetu Pro</th></tr>";
    var body = VALUE_MATRIX_ROWS.map(function (row) {
      var keyRow = row[0] === "Community impact" || row[0] === "Price (per caterer)";
      var trCls = keyRow ? ' class="key-metric"' : "";
      return "<tr" + trCls + "><th>" + esc(row[0]) + "</th><td>" + esc(row[1]) + "</td><td>" + esc(row[2]) + "</td></tr>";
    }).join("");
    el.innerHTML = '<table class="ledger-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
  }

  // One-time ROI tab setup: static cards/table, plus live listeners on every simulator control.
  function initRoiTab() {
    renderRevenueStreams();
    renderValueMatrix();
    ["bm-caterers", "bm-rescues", "bm-kg", "bm-waste-pct", "bm-raw-spend", "roi-csr-share"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", renderBusinessModel);
      el.addEventListener("change", renderBusinessModel);
    });
  }

  // Copies the seed batches and NGOs once, at load, before any user action.
  function takeSeedSnapshot() {
    if (seedSnapshot) return;
    seedSnapshot = {
      now: Date.now(),
      batches: JSON.parse(JSON.stringify(state.batches)),
      ngos: JSON.parse(JSON.stringify(state.ngos)),
      nextNum: state.nextNum
    };
  }

  // Moves every timestamp on a batch forward by delta milliseconds.
  function shiftBatchTimes(b, delta) {
    ["preparedAt", "postedAt", "expiresAt", "claimedAt", "collectedAt", "deliveredAt"].forEach(function (k) {
      if (typeof b[k] === "number") b[k] += delta;
    });
    (b.events || []).forEach(function (e) {
      if (typeof e.at === "number") e.at += delta;
    });
  }

  function showResetMessage(text) {
    var el = $("reset-msg");
    if (!el) return;
    el.textContent = text;
    if (resetMsgTimer !== null) clearTimeout(resetMsgTimer);
    resetMsgTimer = setTimeout(function () {
      el.textContent = "";
      resetMsgTimer = null;
    }, 3000);
  }

  // ---------- persistence (localStorage, synthetic demo only) ----------
  // Writes batches, ngos, nextNum and activeRole as one JSON object. Never throws.
  function saveDb() {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(DB_KEY, JSON.stringify({
        batches: state.batches,
        ngos: state.ngos,
        nextNum: state.nextNum,
        activeRole: state.activeRole,
        savedAt: Date.now()
      }));
      return true;
    } catch (err) {
      return false;
    }
  }

  // Merges one saved NGO over the seed NGO with the same id (D.NGOS).
  // Saved own fields overlay the seed copy. Null or undefined fields fall back to the seed value.
  // priorityAlert keeps the saved value when it is a boolean. dailyCapacityKg falls back to capacity / 5.
  function mergeNgoWithSeed(saved) {
    var seed = (D.NGOS || []).filter(function (s) { return s && s.id === saved.id; })[0] || null;
    var out = seed ? JSON.parse(JSON.stringify(seed)) : {};
    Object.keys(saved).forEach(function (k) { out[k] = saved[k]; });
    ["avgAcceptMins", "dailyCapacityKg", "coldStorage", "diet", "priorityAlert"].forEach(function (f) {
      if ((out[f] === undefined || out[f] === null) && seed) {
        out[f] = JSON.parse(JSON.stringify(seed[f]));
      }
    });
    if (!(Number(out.dailyCapacityKg) > 0)) {
      out.dailyCapacityKg = Math.round((Number(out.capacity) || 0) / 5);
    }
    if (typeof saved.priorityAlert === "boolean") {
      out.priorityAlert = saved.priorityAlert;
    } else {
      out.priorityAlert = !!out.priorityAlert;
    }
    return out;
  }

  // Per-NGO merge keyed by id. Returns the saved NGOs merged over seed, plus any seed NGO missing from the saved list.
  function mergeNgoList(savedList) {
    var seeds = D.NGOS || [];
    var out = [];
    var seen = {};
    (Array.isArray(savedList) ? savedList : []).forEach(function (s) {
      if (!s || typeof s !== "object") return;
      out.push(mergeNgoWithSeed(s));
      seen[String(s.id)] = true;
    });
    seeds.forEach(function (seed) {
      if (!seed || seen[String(seed.id)]) return;
      out.push(JSON.parse(JSON.stringify(seed)));
      seen[String(seed.id)] = true;
    });
    return out;
  }

  // Restores saved fields into state. Keeps seed defaults for anything missing or invalid.
  // All batch timestamps are numeric milliseconds (no Date objects), so JSON round-trips them.
  function loadDb() {
    var raw = null;
    var saved = null;
    try {
      raw = window.localStorage ? window.localStorage.getItem(DB_KEY) : null;
    } catch (err) {
      raw = null;
    }
    if (!raw) return false;
    try {
      saved = JSON.parse(raw);
    } catch (err) {
      return false;
    }
    if (!saved || typeof saved !== "object") return false;
    // Stale demo data: if the save is older than 15 minutes, shift batch times forward by the age.
    // Expired batches and AS-1008 keep their saved times. Without a numeric savedAt, nothing shifts.
    if (Array.isArray(saved.batches) && typeof saved.savedAt === "number" && isFinite(saved.savedAt)) {
      var age = Date.now() - saved.savedAt;
      if (age > 15 * MIN) {
        saved.batches.forEach(function (b) {
          if (!b || typeof b !== "object") return;
          if (b.status === "Expired" || b.id === "AS-1008") return;
          shiftBatchTimes(b, age);
        });
      }
    }
    if (Array.isArray(saved.batches)) state.batches = saved.batches;
    if (Array.isArray(saved.ngos) && saved.ngos.length > 0) {
      state.ngos = mergeNgoList(saved.ngos);
    }
    if (typeof saved.nextNum === "number" && isFinite(saved.nextNum)) state.nextNum = saved.nextNum;
    if (typeof saved.activeRole === "string" && ROLE_VIEWS.hasOwnProperty(saved.activeRole)) {
      state.activeRole = saved.activeRole;
    }
    return true;
  }

  // Shows the persona line in #role-status when present, otherwise in the feed message line.
  function setRoleStatus(text) {
    var el = $("role-status");
    if (el) {
      el.textContent = text;
    } else {
      state.feedMsg = text;
    }
  }

  // Header role select: store the persona, persist, then land on its view via setView (no duplicate tab logic).
  function onRoleChange(e) {
    var sel = e.target;
    var role = sel && typeof sel.value === "string" ? sel.value : "";
    state.activeRole = ROLE_VIEWS.hasOwnProperty(role) ? role : "";
    saveDb();
    if (!state.activeRole) {
      setRoleStatus("");
      return;
    }
    var map = ROLE_VIEWS[state.activeRole];
    if (map.filter) state.dispatchFilter = map.filter;
    var label = sel && sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : state.activeRole;
    renderAll();
    setView(map.view);
    setRoleStatus("Signed in as " + label);
  }

  // Restores the load-time seed without reloading the page.
  function resetDemoData() {
    if (!seedSnapshot) return;
    try {
      if (window.localStorage) window.localStorage.removeItem(DB_KEY);
    } catch (err) {
      // Storage unavailable: the in-memory reset below still applies.
    }
    var delta = Date.now() - seedSnapshot.now;
    state.batches = JSON.parse(JSON.stringify(seedSnapshot.batches));
    state.batches.forEach(function (b) { shiftBatchTimes(b, delta); });
    state.ngos = mergeNgoList(seedSnapshot.ngos);
    state.nextNum = seedSnapshot.nextNum;
    state.riderIdx = 0;
    state.feedMsg = "";
    state.catererFilter = "";
    state.overrides = {};
    state.activeRole = "";
    var roleSel = $("role-select");
    if (roleSel) roleSel.value = "";

    var form = $("donate-form");
    if (form) form.reset();
    resetDonateForm();
    setTextIfPresent("donate-msg", "");

    hideHandling();
    populateCatererFilter();
    renderAll();
    saveDb();
    startTicker();
    showResetMessage("Demo reset to seed data.");
  }

  // ---------- simulate live rescue (demo) ----------
  // One button: Smart Match claim, pickup with auto temperature check, delivery, SIM_STEP_MS apart.
  var simRunning = false;
  var SIM_STEP_MS = 1800;

  function findOpenPostedBatch(now) {
    for (var i = 0; i < state.batches.length; i++) {
      var b = state.batches[i];
      if (b && b.status === "Posted" && !b.locked && b.expiresAt > now) return b;
    }
    return null;
  }

  // Demo batch through the donate submit path (submitDonateBatch), with fixed defaults:
  // first FOOD_PRESETS dish, Veg, 20 kg, Jubilee Hills, 2 h window, cooked 1 h ago, Hot-held,
  // Dairy allergen, Sealed Foil Trays, caterer "Lakeview Wedding Kitchens". Returns null if not published.
  function createDemoBatch() {
    var d = state.donate;
    var form = $("donate-form");
    var presets = D.FOOD_PRESETS || [];
    var food = presets.length ? presets[0] : "Veg Biryani & Salan";
    var before = state.batches.length;
    if (form && form.elements.caterer) form.elements.caterer.value = "Lakeview Wedding Kitchens";
    var loc = $("locality-select");
    if (loc) loc.value = "Jubilee Hills";
    d.foodChoice = food;
    d.customFood = "";
    d.diet = "Veg";
    var slider = $("kg-slider");
    if (slider) slider.value = "20";
    d.windowHours = 2;
    d.cookedHoursAgo = 1;
    d.storage = "Hot-held";
    d.allergens = ["Dairy"];
    d.packaging = "Sealed Foil Trays";
    renderDonateWidgets();
    submitDonateBatch();
    return state.batches.length > before ? state.batches[state.batches.length - 1] : null;
  }

  function finishSimulation(btn) {
    simRunning = false;
    if (btn) btn.disabled = false;
  }

  // step 1 = Smart Match claim, 2 = pickup with auto temperature check, 3 = delivery.
  function runSimulationStep(id, step, btn) {
    setTimeout(function () {
      try {
        var b = findBatch(id);
        if (!b) throw new Error(id + " is no longer in the feed.");
        if (step === 1) {
          claimBatch(id);
          if (b.status !== "Claimed") throw new Error(b.dispatchNote || (id + " was not claimed."));
        } else if (step === 2) {
          b.tempChecked = true;
          confirmPickup(id);
          if (b.status !== "Collected") throw new Error(state.feedMsg || (id + " was not picked up."));
        } else {
          confirmDelivery(id);
          if (b.status !== "Delivered") throw new Error(state.feedMsg || (id + " was not delivered."));
        }
        renderAll();
      } catch (err) {
        showToast("Simulation stopped", err && err.message ? err.message : String(err), "error");
        finishSimulation(btn);
        return;
      }
      if (step < 3) runSimulationStep(id, step + 1, btn);
      else finishSimulation(btn);
    }, SIM_STEP_MS);
  }

  function onSimulateRescue() {
    if (simRunning) return;
    var btn = $("btn-simulate-rescue");
    var batch = null;
    try {
      batch = findOpenPostedBatch(Date.now()) || createDemoBatch();
    } catch (err) {
      batch = null;
    }
    if (!batch) {
      showToast("Simulation not started", "No open batch, and the demo batch could not be published.", "error");
      return;
    }
    simRunning = true;
    if (btn) btn.disabled = true;
    try { setView("feed"); } catch (err) { /* the view switch is cosmetic */ }
    runSimulationStep(batch.id, 1, btn);
  }

  // ---------- navigation & wiring ----------
  var renderers = {
    caterer: function () { renderCatererList(); },
    feed: function () { renderFeed(); },
    radar: function () { renderCorridorMap(); renderCorridorEta(); },
    ngos: function () { renderNgoNetwork(); renderCapacityBars(); },
    safety: function () { renderSafety(); },
    impact: function () { renderImpact(); },
    roi: function () { renderBusinessModel(); }
  };

  // Quick stats. Active = not Delivered and not Expired. Meals = kg / MEAL_KG per Delivered batch.
  // Avg pickup = mean minutes from Posted to Collected (picked up), else to Claimed (assigned).
  // CO2e = rescued (Delivered) kg x CO2_FACTOR, same basis as the ledger.
  function renderPulse() {
    var now = new Date();
    var active = 0;
    var mealsToday = 0;
    var pickupSum = 0;
    var pickupCount = 0;
    state.batches.forEach(function (b) {
      if (b.status !== "Delivered" && b.status !== "Expired") active += 1;
      if (b.status === "Delivered") {
        var d = deliveredAtOf(b);
        if (d !== null) {
          var dd = new Date(d);
          if (dd.getFullYear() === now.getFullYear() && dd.getMonth() === now.getMonth() &&
              dd.getDate() === now.getDate()) {
            mealsToday += Math.round((Number(b.kg) || 0) / MEAL_KG);
          }
        }
      }
      if (b.status === "Expired") return;
      var posted = postedAtOf(b);
      var picked = eventAt(b, "Collected");
      var reached = picked !== null ? picked : eventAt(b, "Claimed");
      if (posted !== null && reached !== null) {
        pickupSum += (reached - posted) / MIN;
        pickupCount += 1;
      }
    });
    var totals = computeLedgerTotals(state.batches);
    setTextIfPresent("pulse-active-batches", String(active));
    setTextIfPresent("pulse-meals-today", fmtNum(mealsToday));
    setTextIfPresent("pulse-avg-pickup", pickupCount ? String(Math.round(pickupSum / pickupCount)) : "\u2014");
    setTextIfPresent("pulse-co2e", fmtNum(totals.co2Kg));
  }

  // Hero banner stats. Meals and CO2e come from Delivered batches (computeLedgerTotals, the same basis
  // as the pulse strip); active = not Delivered and not Expired. Thousands use Indian grouping.
  function renderHeroStats() {
    var totals = computeLedgerTotals(state.batches);
    var active = 0;
    state.batches.forEach(function (b) {
      if (b.status !== "Delivered" && b.status !== "Expired") active += 1;
    });
    setTextIfPresent("hero-stat-meals", Number(totals.meals).toLocaleString("en-IN"));
    setTextIfPresent("hero-stat-active", Number(active).toLocaleString("en-IN"));
    setTextIfPresent("hero-stat-co2e", fmtNum(totals.co2Kg));
  }


  // Header status pill: sets the label text only, keeping the existing dot element.
  function setCityStatusPill() {
    var pill = $("city-status-pill");
    if (!pill) return;
    var label = "Hyderabad Corridor \u2022 Live Dispatch";
    if (pill.textContent.replace(/\s+/g, " ").trim() === label) return;
    var dot = pill.querySelector(".status-dot");
    pill.textContent = "";
    if (dot) pill.appendChild(dot);
    pill.appendChild(document.createTextNode(label));
  }

  // ---------- v6 operational modules (persona, badges, corridor, NGO network, split claim, safety, ESG) ----------
  var RAMESH_CATERER = "Deccan Royal Caterers";
  var MEERA_NGO_ID = "ngo-annapurna";
  var CSR_RATE_INR = D.CSR_RESCUE_RATE || 40;
  var SAFE_HOURS = D.SAFE_HOURS_DEFAULT || 4;

  var RING_COLOR = { green: "#16a34a", amber: "#f59e0b", red: "#dc2626" };
  // Non-persisted session state (lost on reload, never written to localStorage).
  var sponsoredIds = new Set();
  var receiptIds = new Set();
  var riderSteps = {};
  var estimatorBuilt = false;
  var methodologyBuilt = false;

  function isActiveBatch(b) { return b.status !== "Delivered" && b.status !== "Expired"; }

  // Remaining safe minutes: safeHours x 60 minus minutes since preparedAt. Negative once past the window.
  function safeMinsLeft(b, now) {
    var hours = Number(b.safeHours);
    if (!isFinite(hours) || hours <= 0) hours = SAFE_HOURS;
    return hours * 60 - (now - Number(b.preparedAt)) / MIN;
  }

  // green > 60 min, amber 15-60 min, red under 15 min (including past the window).
  function safeClass(mins) {
    if (mins < 15) return "red";
    if (mins > 60) return "green";
    return "amber";
  }

  // Kg assigned to an NGO (Claimed, Collected or Delivered). Treated as today's intake, as in ngoUsed().
  function kgAcceptedBy(ngoId) {
    var total = 0;
    state.batches.forEach(function (b) {
      if (b.ngoId === ngoId && (b.status === "Claimed" || b.status === "Collected" || b.status === "Delivered")) {
        total += Number(b.kg) || 0;
      }
    });
    return total;
  }

  // ETA in minutes at the 25 km/h rule.
  function etaMinFor(ngo) { return Math.round(Number(ngo.distance_km) / 25 * 60); }


  // Persona filter. scope "caterer" = caterer list, "feed" = dispatch feed.
  function personaAllows(b, scope) {
    if (scope === "caterer" && state.activeRole === "ramesh") return b.caterer === RAMESH_CATERER;
    if (scope === "feed" && state.activeRole === "meera") return b.diet === "Veg";
    return true;
  }

  // Extra card action for the active persona (trusted markup; ids escaped).
  function personaActionHtml(b) {
    if (state.activeRole === "ramesh" && b.caterer === RAMESH_CATERER && b.status === "Delivered") {
      return '<button type="button" class="btn btn-secondary" data-action="csr-cert" data-id="' + esc(b.id) +
        '">Download CSR Impact Summary</button>';
    }
    if (state.activeRole === "meera" && b.ngoId === MEERA_NGO_ID) {
      if (b.status === "Delivered") {
        if (receiptIds.has(b.id)) return '<p class="card-status">Receipt confirmed</p>';
        return '<button type="button" class="btn btn-primary" data-action="confirm-receipt" data-id="' + esc(b.id) +
          '">Confirm Receipt &amp; Rate Packaging</button>';
      }
      var ngo = ngoById(MEERA_NGO_ID);
      if (ngo && isLive(b)) return '<p class="card-status">ETA ' + esc(etaMinFor(ngo)) + " min</p>";
    }
    return "";
  }

  // Ramesh: download a plain-text logistics record for one Delivered batch. No tax or certification claim.
  function downloadCsrCertificate(id) {
    var b = findBatch(id);
    if (!b || b.caterer !== RAMESH_CATERER || b.status !== "Delivered") return false;
    var kg = Number(b.kg) || 0;
    var lines = [
      "AnnaSetu CSR Impact Summary",
      "Batch ID: " + b.id,
      "Dish: " + b.food,
      "Quantity: " + fmtNum(kg) + " kg",
      "Meals (kg / 0.4): " + Math.round(kg / MEAL_KG),
      "CO2e (kg x 2.5): " + fmtNum(Math.round(kg * CO2_FACTOR * 10) / 10) + " kg",
      "Synthetic demo record. Logistics only."
    ];
    var blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = b.id + "-csr-impact.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    showToast("Record downloaded", b.id + " logistics record saved", "ok");
    return false;
  }

  // Ramesh: recurring-dish waste insight for this kitchen only.
  function catererInsightText() {
    var byDish = {};
    state.batches.forEach(function (b) {
      if (b.caterer !== RAMESH_CATERER) return;
      byDish[b.food] = (byDish[b.food] || 0) + (Number(b.kg) || 0);
    });
    var top = null;
    Object.keys(byDish).forEach(function (d) {
      if (top === null || byDish[d] > byDish[top]) top = d;
    });
    if (top === null) return "No surplus recorded for this kitchen yet.";
    var kg = byDish[top];
    var saving = Math.round((kg / MEAL_KG) * MEAL_VALUE_INR);
    return "Recurring waste: " + top + " \u00B7 " + fmtNum(kg) + " kg. Estimated saving \u20B9" +
      saving.toLocaleString("en-IN") + " (assumes \u20B965 per meal).";
  }

  // Meera: confirm receipt of a Delivered NGO batch. Status is unchanged; the id is kept in memory only.
  function confirmReceipt(id) {
    var b = findBatch(id);
    if (!b || b.status !== "Delivered" || b.ngoId !== MEERA_NGO_ID) return false;
    receiptIds.add(b.id);
    showToast("Receipt confirmed", b.id + " receipt noted. Batch status unchanged.", "ok");
    return true;
  }

  // Arjun: rider mission step state, keyed by batch id (not persisted).
  function riderBatches() {
    return state.batches.filter(function (b) {
      return !!b.rider && String(b.rider).indexOf("R-07") !== -1 && b.status !== "Expired";
    }).sort(function (a, c) { return a.expiresAt - c.expiresAt; });
  }

  function isRider07(b) {
    return !!b && !!b.rider && String(b.rider).indexOf("R-07") !== -1 && b.status !== "Expired";
  }

  function riderStep(id) {
    if (!riderSteps[id]) riderSteps[id] = { arrived: false, tempOk: false, temp: null, seal: false, handed: false };
    return riderSteps[id];
  }

  // Synthetic OTP: last 4 digits of the numeric part of the batch id, zero-padded.
  function demoOtp(id) {
    var digits = String(id).replace(/\D/g, "");
    return ("0000" + digits.slice(-4)).slice(-4);
  }

  function handoverCount() {
    var n = 0;
    Object.keys(riderSteps).forEach(function (id) {
      if (riderSteps[id].handed) n += 1;
    });
    return n;
  }

  function riderArrive(id) {
    var b = findBatch(id);
    if (!isRider07(b)) return false;
    riderStep(id).arrived = true;
    showToast("Arrived", b.id + " arrival logged", "ok");
    return true;
  }

  function riderLogTemp(id, scope) {
    var b = findBatch(id);
    if (!isRider07(b)) return false;
    var input = scope ? scope.querySelector('[id="rider-temp-' + id + '"]') : null;
    var seal = scope ? scope.querySelector('[id="rider-seal-' + id + '"]') : null;
    var raw = input ? String(input.value).trim() : "";
    var temp = raw === "" ? NaN : Number(raw);
    if (!isFinite(temp) || temp < 0 || temp > 100) {
      showToast("Temperature not logged", "Enter a number from 0 to 100 \u00B0C.", "warn");
      return false;
    }
    var s = riderStep(id);
    s.tempOk = true;
    s.temp = temp;
    s.seal = !!(seal && seal.checked);
    showToast("Temperature logged", b.id + " at " + temp + " \u00B0C", "ok");
    return true;
  }

  function riderHandover(id, scope) {
    var b = findBatch(id);
    if (!isRider07(b)) return false;
    var s = riderStep(id);
    if (s.handed) return false;
    if (!s.arrived || !s.tempOk) {
      showToast("Handover locked", "Mark arrival and log the temperature first.", "warn");
      return false;
    }
    var input = scope ? scope.querySelector('[id="rider-otp-' + id + '"]') : null;
    var code = input ? String(input.value).trim() : "";
    if (code !== demoOtp(id)) {
      showToast("OTP does not match", "Check the 4-digit handover code.", "warn");
      return false;
    }
    s.handed = true;
    showToast("Handover complete", b.id + " \u00B7 \u20B9" + CSR_RATE_INR + " fuel stipend counted", "ok");
    return true;
  }

  // Vikram: sponsor an active rescue (session only).
  function sponsorRescue(id) {
    var b = findBatch(id);
    if (!b || !isActiveBatch(b) || sponsoredIds.has(b.id)) return false;
    sponsoredIds.add(b.id);
    showToast("Rescue sponsored", b.id + " \u00B7 \u20B9" + CSR_RATE_INR + " CSR rescue credit", "ok");
    return true;
  }

  // Split a Posted batch above 40 kg: half the kg moves to a new Claimed batch for the chosen NGO.
  function splitClaim(id, ngoId) {
    var b = findBatch(id);
    var ngo = ngoById(ngoId);
    if (!b || !ngo) return false;
    if (b.status !== "Posted" || b.locked) {
      showToast("Split not created", b.id + " is no longer Posted.", "warn");
      return false;
    }
    var kg = Number(b.kg) || 0;
    if (kg <= 40) return false;
    if (!dietOk(ngo.pref, b.diet)) {
      showToast("Split not created", ngo.name + " does not accept " + b.diet + ".", "warn");
      return false;
    }
    var half = Math.round(kg * 5) / 10;
    var newMeals = Math.round((Number(b.servings) || 0) / 2);
    if (remaining(ngo) < newMeals) {
      showToast("Split not created", ngo.name + " has no room for the split half.", "warn");
      return false;
    }
    var now = Date.now();
    var rider = RIDERS[state.riderIdx % RIDERS.length];
    state.riderIdx += 1;
    var postedAt = eventAt(b, "Posted");
    var clone = JSON.parse(JSON.stringify(b));
    var newId = "AS-" + state.nextNum;
    state.nextNum += 1;
    clone.id = newId;
    clone.kg = half;
    clone.servings = newMeals;
    clone.status = "Claimed";
    clone.ngoId = ngo.id;
    clone.rider = rider.name;
    clone.vehicle = rider.vehicle;
    clone.etaMin = Math.max(5, Math.round(Number(ngo.distance_km) / 0.25));
    clone.claimedAt = now;
    clone.tempChecked = false;
    clone.dispatchNote = null;
    clone.locked = false;
    clone.events = [{ type: "Posted", at: postedAt !== null ? postedAt : now }, { type: "Claimed", at: now }];
    b.kg = Math.round((kg - half) * 10) / 10;
    b.servings = (Number(b.servings) || 0) - newMeals;
    state.batches.push(clone);
    state.feedMsg = newId + " split from " + b.id + " and claimed by " + ngo.name + ".";
    showToast("Split claim created", newId + " claimed by " + ngo.name, "ok");
    return true;
  }

  // One delegated click listener (attached in init). Unknown ids are no-ops.
  function onModuleClick(e) {
    var t = e.target;
    var el = t && t.closest ? t.closest("[data-action]") : null;
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id") || "";
    var scope = el.closest ? el.closest(".rider-batch") : null;
    var changed = false;
    if (action === "csr-cert") changed = downloadCsrCertificate(id);
    else if (action === "confirm-receipt") changed = confirmReceipt(id);
    else if (action === "rider-arrive") changed = riderArrive(id);
    else if (action === "rider-log-temp") changed = riderLogTemp(id, scope);
    else if (action === "rider-handover") changed = riderHandover(id, scope);
    else if (action === "sponsor") changed = sponsorRescue(id);
    else if (action === "split-claim") changed = splitClaim(id, el.getAttribute("data-ngo") || "");
    else return;
    if (changed) {
      renderAll();
      saveDb();
    }
  }

  // Delegated change listener for the NGO priority-alert checkboxes (attached in init).
  function onModuleChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute("data-action") !== "priority-alert") return;
    var ngo = ngoById(t.getAttribute("data-id") || "");
    if (!ngo) return;
    ngo.priorityAlert = !!t.checked;
    saveDb();
  }

  // Persona banner, kitchen insight, and the rider / CSR workspaces. Driven by state.activeRole.
  function setPanel(id, on, build) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = on ? build() : '<p class="hint">Select this persona in the header to open the workspace.</p>';
  }

  function riderMissionHtml() {
    var list = riderBatches();
    if (!list.length) return '<p class="empty">No R-07 batches on the mission right now.</p>';
    var handed = handoverCount();
    var head = '<div class="rider-stipend">CSR fuel stipend: <strong>\u20B9' + esc(handed * CSR_RATE_INR) +
      "</strong> (" + esc(handed) + " handovers \u00D7 \u20B9" + esc(CSR_RATE_INR) + ")</div>";
    return head + list.map(function (b) {
      var s = riderSteps[b.id] || { arrived: false, tempOk: false, temp: null, seal: false, handed: false };
      var step1 = '<div class="rider-step' + (s.arrived ? " done" : "") + '"><h4>1 Arrive</h4>' +
        (s.arrived ? "<p>Arrived at the caterer.</p>" :
          '<button type="button" class="btn btn-primary" data-action="rider-arrive" data-id="' + esc(b.id) +
          '">Mark arrived</button>') + "</div>";
      var step2 = '<div class="rider-step' + (s.tempOk ? " done" : "") + '"><h4>2 Log temperature and seal check</h4>' +
        '<input type="number" id="rider-temp-' + esc(b.id) + '" step="0.1" min="0" max="100" placeholder="\u00B0C" aria-label="Temperature in Celsius"> ' +
        '<label><input type="checkbox" id="rider-seal-' + esc(b.id) + '"' + (s.seal ? " checked" : "") + "> Seal intact</label> " +
        '<button type="button" class="btn btn-secondary" data-action="rider-log-temp" data-id="' + esc(b.id) +
        '">Log temperature</button>' +
        (s.tempOk ? '<p class="hint">Logged ' + esc(s.temp) + " \u00B0C</p>" : "") + "</div>";
      var step3 = '<div class="rider-step' + (s.handed ? " done" : "") + '"><h4>3 4-digit handover</h4>' +
        (s.handed ? "<p>Handover complete.</p>" :
          '<p class="hint">Demo OTP: ' + esc(demoOtp(b.id)) + "</p>" +
          '<input type="text" id="rider-otp-' + esc(b.id) + '" inputmode="numeric" maxlength="4" placeholder="0000" aria-label="4-digit handover code"> ' +
          '<button type="button" class="btn btn-primary" data-action="rider-handover" data-id="' + esc(b.id) +
          '">Confirm handover</button>') + "</div>";
      return '<article class="card rider-batch" data-id="' + esc(b.id) + '"><div class="card-header"><div>' +
        '<h3 class="card-title">' + esc(b.id) + '</h3><p class="card-subtitle">' + esc(b.food) + " \u00B7 " +
        esc(b.rider) + "</p></div></div>" + step1 + step2 + step3 + "</article>";
    }).join("");
  }

  function csrConsoleHtml() {
    var active = state.batches.filter(isActiveBatch).sort(function (a, c) { return a.expiresAt - c.expiresAt; });
    var count = 0;
    var meals = 0;
    sponsoredIds.forEach(function (id) {
      var b = findBatch(id);
      if (!b) return;
      count += 1;
      meals += Number(b.servings) || 0;
    });
    var avg = meals > 0 ? (CSR_RATE_INR * count / meals).toFixed(2) : null;
    var totals = '<div class="csr-totals">' +
      kpiCardHtml("Sponsored rescues", String(count), "this session", "") +
      kpiCardHtml("Cost per meal", avg === null ? "\u2014" : "\u20B9" + avg, "average across sponsored rescues", "") +
      "</div>";
    var rows = active.map(function (b) {
      var m = Number(b.servings) || 0;
      var cpm = m > 0 ? "\u20B9" + (CSR_RATE_INR / m).toFixed(2) : "\u2014";
      var action = sponsoredIds.has(b.id) ? '<span class="card-status">Sponsored</span>' :
        '<button type="button" class="sponsor-badge" data-action="sponsor" data-id="' + esc(b.id) +
        '">Sponsor Open Rescue (\u20B9' + esc(CSR_RATE_INR) + ")</button>";
      return '<div class="csr-row"><span class="batch-id-pill">' + esc(b.id) + "</span> <span>" + esc(b.food) +
        " \u00B7 " + esc(m) + " meals \u00B7 cost per meal " + esc(cpm) + "</span> " + action + "</div>";
    }).join("");
    return totals + (rows || '<p class="empty">No active batches to sponsor.</p>');
  }

  function renderPersona() {
    var role = state.activeRole;
    var banner = $("persona-banner");
    var labels = {
      ramesh: "Deccan Royal Caterers \u00B7 kitchen view",
      meera: "Annapurna Seva Trust \u00B7 receiver view",
      arjun: "Rider R-07 \u00B7 mission view",
      vikram: "CSR sponsor \u00B7 console view"
    };
    if (banner) {
      banner.textContent = Object.prototype.hasOwnProperty.call(labels, role) ? labels[role] : "";
      banner.hidden = !role;
    }
    var insight = $("persona-insight");
    if (role === "ramesh" && banner && !insight && banner.parentNode) {
      insight = document.createElement("p");
      insight.id = "persona-insight";
      insight.className = "hint";
      banner.parentNode.insertBefore(insight, banner.nextSibling);
    }
    if (insight) insight.textContent = role === "ramesh" ? catererInsightText() : "";
    setPanel("rider-mission", role === "arjun", riderMissionHtml);
    setPanel("csr-console", role === "vikram", csrConsoleHtml);
  }

  // Short NGO labels for map pills. Unknown ids fall back to the first word of the name.
  var NGO_SHORT = {
    "ngo-annapurna": "Annapurna",
    "ngo-asha": "Asha",
    "ngo-hope": "Hope St",
    "ngo-sahayam": "Sahayam",
    "ngo-karuna": "Karuna",
    "ngo-nirmal": "Nirmal"
  };

  function ngoShortName(n) {
    if (Object.prototype.hasOwnProperty.call(NGO_SHORT, n.id)) return NGO_SHORT[n.id];
    return String(n.name || "").split(" ")[0];
  }

  // Rider short id such as "R-07", taken from the rider name. Falls back to the full name or "EV".
  function riderShortId(name) {
    var m = /R-\d+/.exec(String(name || ""));
    if (m) return m[0];
    return name ? String(name) : "EV";
  }

  // White label pill with escaped text. x = left edge, cy = vertical centre.
  function corridorTag(x, cy, label, cls) {
    var w = Math.round(String(label).length * 6.2 + 14);
    return '<rect class="' + cls + '-bg" x="' + x + '" y="' + (cy - 9) + '" width="' + w +
      '" height="18" rx="6" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1"></rect>' +
      '<text class="' + cls + '" x="' + (x + 7) + '" y="' + (cy + 4) + '" font-size="10" fill="#0F172A">' +
      esc(label) + "</text>";
  }

  // ---------- corridor radar: schematic Hyderabad map (not to true scale) ----------
  // Projection bounds for the 680 x 420 viewBox. y grows downward, so latitude is inverted.
  var LNG_MIN = 78.33;
  var LNG_MAX = 78.53;
  var LAT_MIN = 17.35;
  var LAT_MAX = 17.50;
  // Places that are not in data.js LOCALITIES (app-only constants).
  var RADAR_EXTRA_PLACES = {
    "Begumpet": { lat: 17.4439, lng: 78.4664 },
    "Secunderabad": { lat: 17.4399, lng: 78.4983 }
  };
  var HUSSAIN_SAGAR = { lat: 17.4239, lng: 78.4738 };
  var RADAR_ZONES = ["Madhapur", "Hitech City", "Gachibowli", "Banjara Hills", "Jubilee Hills", "Begumpet", "Secunderabad"];
  var RADAR_SPEED_KMH = 25;
  var RADAR_CYCLE_MS = 6000;
  // Module-level animation state: rAF handle, animation clock start, and one-time listener flag.
  var radarAnim = null;
  var radarAnimStart = null;
  var radarBound = false;

  // Lat/lng to viewBox x/y, clamped inside the frame.
  function geoToXY(lat, lng) {
    var x = (Number(lng) - LNG_MIN) * (680 / (LNG_MAX - LNG_MIN));
    var y = (LAT_MAX - Number(lat)) * (420 / (LAT_MAX - LAT_MIN));
    if (!isFinite(x)) x = 340;
    if (!isFinite(y)) y = 210;
    return { x: Math.min(668, Math.max(12, x)), y: Math.min(408, Math.max(12, y)) };
  }

  // Coordinates for a locality name, or null when it is unknown.
  function radarPlace(name) {
    var table = (D && D.LOCALITIES) || {};
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    if (Object.prototype.hasOwnProperty.call(RADAR_EXTRA_PLACES, name)) return RADAR_EXTRA_PLACES[name];
    return null;
  }

  // Smooth open curve through projected points (Catmull-Rom converted to cubic segments).
  function radarSmoothPath(pts) {
    if (!pts || pts.length < 2) return "";
    var d = "M " + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) +
        " " + p2.x.toFixed(1) + " " + p2.y.toFixed(1);
    }
    return d;
  }

  // Projects a list of [lat, lng] pairs.
  function radarProjectList(list) {
    return list.map(function (p) { return geoToXY(p[0], p[1]); });
  }

  // Pin position: locality centre plus a pixel offset, kept inside the frame.
  function radarOffset(geo, dx, dy) {
    var p = geoToXY(geo.lat, geo.lng);
    return { x: Math.min(668, Math.max(12, p.x + dx)), y: Math.min(408, Math.max(12, p.y + dy)) };
  }

  function radarReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Route progress 0..1. Claimed riders wait at 0.30; Collected riders loop every 6 s; reduced motion uses 0.5.
  function radarProgress(status, now, reduced) {
    if (status === "Claimed") return 0.3;
    if (status !== "Collected") return 0;
    if (reduced) return 0.5;
    var start = radarAnimStart === null ? now : radarAnimStart;
    return ((((now - start) % RADAR_CYCLE_MS) + RADAR_CYCLE_MS) % RADAR_CYCLE_MS) / RADAR_CYCLE_MS;
  }

  // Live remaining km and ETA minutes for a batch on a route; null when it has no route.
  function radarReadout(b, now) {
    if (!b || (b.status !== "Claimed" && b.status !== "Collected") || !b.ngoId) return null;
    var ngo = ngoById(b.ngoId);
    if (!ngo) return null;
    var dist = Number(ngo.distance_km);
    if (!isFinite(dist) || dist < 0) dist = 0;
    var p = radarProgress(b.status, now, radarReducedMotion());
    var remaining = (1 - p) * dist;
    return { km: remaining, eta: Math.max(4, Math.round(remaining / RADAR_SPEED_KMH * 60)) };
  }

  // Short rider tag: an "R-07" style token, else the last name token, else "EV".
  function radarRiderTag(name) {
    var text = String(name || "").trim();
    if (!text) return "EV";
    var m = /R-\d+/.exec(text);
    if (m) return m[0];
    var parts = text.split(/\s+/);
    return parts[parts.length - 1];
  }

  function radarLegendHtml() {
    return '<div class="radar-legend">' +
      '<span class="radar-legend-item"><span class="radar-legend-swatch" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#F59E0B"></span>Kitchen pickup</span>' +
      '<span class="radar-legend-item"><span class="radar-legend-swatch" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#059669"></span>NGO drop-off</span>' +
      '<span class="radar-legend-item"><span class="radar-legend-swatch" style="display:inline-block;width:14px;height:0;border-top:2px dashed #64748B"></span>Route</span>' +
      '<span class="radar-legend-item"><span class="radar-legend-swatch" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2563EB"></span>EV rider</span>' +
      "</div>";
  }

  // Landmarks drawn before pins: Musi River, Hussain Sagar, Outer Ring Road and the zone labels.
  function radarLandmarksHtml() {
    var s = "";
    var river = radarProjectList([[17.42, 78.36], [17.39, 78.40], [17.38, 78.45], [17.39, 78.49]]);
    s += '<path class="map-river" d="' + radarSmoothPath(river) + '" fill="none" stroke="#BAE6FD" stroke-width="8" ' +
      'stroke-linecap="round" opacity="0.7"></path>' +
      '<text class="map-muted" x="' + river[1].x.toFixed(1) + '" y="' + (river[1].y + 16).toFixed(1) +
      '" font-size="10" font-style="italic" fill="#64748B">Musi River</text>';

    var hs = geoToXY(HUSSAIN_SAGAR.lat, HUSSAIN_SAGAR.lng);
    s += '<ellipse class="map-water" cx="' + hs.x.toFixed(1) + '" cy="' + hs.y.toFixed(1) +
      '" rx="26" ry="14" fill="#BFDBFE" stroke="#93C5FD" stroke-width="1"></ellipse>' +
      '<text class="map-muted" x="' + hs.x.toFixed(1) + '" y="' + (hs.y + 28).toFixed(1) +
      '" text-anchor="middle" font-size="10" font-style="italic" fill="#64748B">Hussain Sagar</text>';

    var orr = radarProjectList([[17.50, 78.33], [17.46, 78.31], [17.40, 78.32], [17.36, 78.37], [17.36, 78.44]]);
    s += '<path class="map-orr" d="' + radarSmoothPath(orr) + '" fill="none" stroke="#E2E8F0" stroke-width="6" ' +
      'stroke-linecap="round"></path>' +
      '<text class="map-muted" x="' + (orr[2].x + 6).toFixed(1) + '" y="' + orr[2].y.toFixed(1) +
      '" font-size="10" font-weight="600" fill="#64748B">ORR</text>';

    RADAR_ZONES.forEach(function (name) {
      var geo = radarPlace(name);
      if (!geo) return;
      var c = geoToXY(geo.lat, geo.lng);
      var w = Math.round(name.length * 6.4 + 16);
      s += '<circle class="map-dot" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="3" fill="#94A3B8"></circle>' +
        '<rect class="map-pill" x="' + (c.x - w / 2).toFixed(1) + '" y="' + (c.y + 10).toFixed(1) + '" width="' + w +
        '" height="16" rx="6" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1"></rect>' +
        '<text class="map-label" x="' + c.x.toFixed(1) + '" y="' + (c.y + 22).toFixed(1) +
        '" text-anchor="middle" font-size="11" fill="#334155">' + esc(name) + "</text>";
    });
    return s;
  }

  function stopRadarAnimation() {
    if (radarAnim !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(radarAnim);
    radarAnim = null;
  }

  function radarFindBatch(id) {
    var found = null;
    state.batches.forEach(function (b) {
      if (!found && String(b.id) === String(id)) found = b;
    });
    return found;
  }

  // Writes live km and ETA into the open popover when it shows this batch.
  function radarWriteReadout(bid, now) {
    var pop = $("corridor-popover");
    if (!pop) return;
    var r = radarReadout(radarFindBatch(bid), now);
    var etaEl = pop.querySelector("[data-radar-eta]");
    var kmEl = pop.querySelector("[data-radar-km]");
    if (r && etaEl) etaEl.textContent = r.eta + " min";
    if (r && kmEl) kmEl.textContent = r.km.toFixed(1) + " km";
  }

  // Moves every rider marker along its route. Returns true while any Collected rider is moving.
  function radarMoveRiders(now, reduced) {
    var el = $("corridor-map");
    if (!el) return false;
    var moving = false;
    var markers = el.querySelectorAll(".radar-rider[data-batch-id]");
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var bid = m.getAttribute("data-batch-id");
      var status = m.getAttribute("data-rider-status");
      var route = document.getElementById("route-" + bid);
      if (!route || typeof route.getPointAtLength !== "function") continue;
      var p = radarProgress(status, now, reduced);
      if (status === "Collected" && !reduced) moving = true;
      var pt = route.getPointAtLength(p * route.getTotalLength());
      m.setAttribute("transform", "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ")");
      if (status === "Collected" && state.radarSelected === bid) radarWriteReadout(bid, now);
    }
    return moving;
  }

  // Starts the rider animation loop. Cancels any previous frame and stops when no rider is moving.
  function startRadarAnimation() {
    stopRadarAnimation();
    var el = $("corridor-map");
    if (!el || !el.querySelector(".radar-rider")) return;
    var reduced = radarReducedMotion();
    if (radarAnimStart === null) radarAnimStart = Date.now();
    function frame() {
      radarAnim = null;
      var moving = radarMoveRiders(Date.now(), reduced);
      if (moving && !reduced && typeof requestAnimationFrame === "function") {
        radarAnim = requestAnimationFrame(frame);
      }
    }
    frame();
  }

  // Detail card for the selected batch. Hides the popover when the batch is not found.
  function renderRadarPopover() {
    var pop = $("corridor-popover");
    if (!pop) return;
    var b = state.radarSelected ? radarFindBatch(state.radarSelected) : null;
    if (!b) {
      state.radarSelected = null;
      pop.hidden = true;
      pop.innerHTML = "";
      return;
    }
    var now = Date.now();
    var kg = Number(b.kg) || 0;
    var servings = Number(b.servings);
    var meals = isFinite(servings) && servings > 0 ? Math.round(servings) : mealsFor(kg);
    var temp = b.tempChecked ? "Temperature checked" : "Check pending at pickup";
    var storage = b.storage ? b.storage : "Storage not recorded";
    var r = radarReadout(b, now);
    var etaText = r ? r.eta + " min" : "Not on a route yet";
    var kmText = r ? r.km.toFixed(1) + " km" : "Not on a route yet";
    pop.innerHTML = '<article class="radar-pop-card">' +
      '<header class="radar-pop-head"><h3 class="radar-pop-title">Batch ID ' + esc(b.id) + "</h3>" +
      '<button type="button" class="btn btn-secondary" data-action="radar-close">Close</button></header>' +
      '<p class="radar-pop-row"><span class="radar-pop-label">Dish</span> ' + esc(b.food || "-") + "</p>" +
      '<p class="radar-pop-row"><span class="radar-pop-label">Meals</span> ' + esc(meals) + "</p>" +
      '<p class="radar-pop-row"><span class="radar-pop-label">Temperature</span> ' + esc(temp) +
      ' <span class="radar-pop-tag">' + esc(storage) + "</span></p>" +
      '<p class="radar-pop-row"><span class="radar-pop-label">EV rider</span> ' +
      esc(b.rider ? b.rider : "Unassigned") + "</p>" +
      '<p class="radar-pop-row"><span class="radar-pop-label">Live ETA</span> <span data-radar-eta>' +
      esc(etaText) + "</span></p>" +
      '<p class="radar-pop-row"><span class="radar-pop-label">Remaining</span> <span data-radar-km>' +
      esc(kmText) + "</span></p>" +
      '<footer class="radar-pop-foot"><button type="button" class="btn btn-primary" data-action="radar-play">Play route</button></footer>' +
      "</article>";
    pop.hidden = false;
  }

  // Delegated listeners for the map pins and the popover. Attached once from init.
  function bindRadarListeners() {
    if (radarBound) return;
    radarBound = true;
    var map = $("corridor-map");
    var pop = $("corridor-popover");
    function pinFrom(target) {
      var node = target && target.closest ? target : null;
      return node ? node.closest(".radar-pin") : null;
    }
    if (map) {
      map.addEventListener("click", function (e) {
        var pin = pinFrom(e.target);
        if (!pin) return;
        state.radarSelected = pin.getAttribute("data-batch-id");
        renderRadarPopover();
      });
      map.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var pin = pinFrom(e.target);
        if (!pin) return;
        e.preventDefault();
        state.radarSelected = pin.getAttribute("data-batch-id");
        renderRadarPopover();
      });
    }
    if (pop) {
      pop.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!btn) return;
        var action = btn.getAttribute("data-action");
        if (action === "radar-close") {
          state.radarSelected = null;
          renderRadarPopover();
        } else if (action === "radar-play") {
          radarAnimStart = Date.now();
          startRadarAnimation();
        }
      });
    }
  }

  // Corridor map (viewBox 680x420): landmarks, routes, kitchen and NGO pins, and EV rider markers.
  function renderCorridorMap() {
    var el = $("corridor-map");
    if (!el) return;
    var legend = radarLegendHtml();
    var shown = state.batches.filter(function (b) { return matchesFilters(b); });
    if (!shown.length) {
      stopRadarAnimation();
      el.innerHTML = legend + '<p class="empty-state">No corridor batches match the current filters.</p>';
      renderRadarPopover();
      return;
    }

    var routeHtml = "";
    var pinHtml = "";
    var riderHtml = "";
    shown.forEach(function (b, i) {
      var geo = radarPlace(b.locality);
      if (!geo) return;
      var expired = b.status === "Expired";
      var bid = esc(b.id);
      var kp = radarOffset(geo, (i % 3 - 1) * 14, -Math.floor(i / 3) * 14 - 6);
      pinHtml += '<g class="radar-pin" data-batch-id="' + bid + '" data-pin="kitchen" tabindex="0" role="button" aria-label="' +
        esc("Kitchen pickup " + b.id + ", " + (b.caterer || "") + ", " + (b.locality || "")) + '">' +
        '<circle class="pin-kitchen" cx="' + kp.x.toFixed(1) + '" cy="' + kp.y.toFixed(1) + '" r="8" fill="' +
        (expired ? "#94A3B8" : "#F59E0B") + '" stroke="#FFFFFF" stroke-width="2"></circle></g>';

      // Expired batches keep the grey kitchen pin only.
      if (expired || !b.ngoId) return;
      var ngo = ngoById(b.ngoId);
      var nGeo = ngo ? radarPlace(ngo.locality) : null;
      if (!ngo || !nGeo) return;
      var np = radarOffset(nGeo, 14, 6);
      pinHtml += '<g class="radar-pin" data-batch-id="' + bid + '" data-pin="ngo" data-ngo-id="' + esc(ngo.id) +
        '" tabindex="0" role="button" aria-label="' + esc("NGO drop-off " + ngo.name + " for " + b.id) + '">' +
        '<rect class="pin-ngo" x="' + (np.x - 6).toFixed(1) + '" y="' + (np.y - 6).toFixed(1) +
        '" width="12" height="12" rx="2" fill="#059669" stroke="#FFFFFF" stroke-width="1.5"></rect></g>';

      if (b.status !== "Claimed" && b.status !== "Collected") return;
      // Quadratic route: control point offset 30 px perpendicular to the chord.
      var mx = (kp.x + np.x) / 2;
      var my = (kp.y + np.y) / 2;
      var dx = np.x - kp.x;
      var dy = np.y - kp.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var cx = mx + (-dy / len) * 30;
      var cy = my + (dx / len) * 30;
      routeHtml += '<path class="radar-route" id="route-' + bid + '" d="M ' + kp.x.toFixed(1) + " " + kp.y.toFixed(1) +
        " Q " + cx.toFixed(1) + " " + cy.toFixed(1) + " " + np.x.toFixed(1) + " " + np.y.toFixed(1) +
        '" fill="none" stroke="#64748B" stroke-width="2" stroke-dasharray="6 5"></path>';

      // Rider marker starts at the route start; startRadarAnimation() places it.
      riderHtml += '<g class="radar-rider" data-batch-id="' + bid + '" data-rider-status="' + esc(b.status) +
        '" transform="translate(' + kp.x.toFixed(1) + " " + kp.y.toFixed(1) + ')">' +
        '<circle r="6" fill="#2563EB" stroke="#FFFFFF" stroke-width="1.5"></circle>' +
        '<rect x="-20" y="-24" width="40" height="14" rx="6" fill="#FFFFFF" stroke="#2563EB" stroke-width="1"></rect>' +
        '<text x="0" y="-14" text-anchor="middle" font-size="9" fill="#1E3A8A">' + esc(radarRiderTag(b.rider)) +
        "</text></g>";
    });

    var svg = '<svg class="corridor-svg" viewBox="0 0 680 420" role="img" aria-label="Hyderabad IT corridor dispatch map">' +
      "<defs>" +
      '<pattern id="corridor-grid" width="34" height="34" patternUnits="userSpaceOnUse">' +
      '<path d="M 34 0 L 0 0 0 34" fill="none" stroke="#E2E8F0" stroke-width="0.6"></path></pattern>' +
      "</defs>" +
      '<rect class="map-bg" x="0" y="0" width="680" height="420" fill="#F8FAFC"></rect>' +
      '<rect x="0" y="0" width="680" height="420" fill="url(#corridor-grid)"></rect>' +
      radarLandmarksHtml() + routeHtml + pinHtml + riderHtml + "</svg>";
    el.innerHTML = legend + svg;
    renderRadarPopover();
    startRadarAnimation();
  }


  // Route cards for active, assigned batches: batch id, status, route, EV rider, safe window and ETA (25 km/h rule).
  function renderCorridorEta() {
    var box = $("corridor-eta-list");
    if (!box) return;
    var now = Date.now();
    var cards = [];
    state.batches.forEach(function (b) {
      if (!isActiveBatch(b) || !b.ngoId) return;
      var ngo = ngoById(b.ngoId);
      if (!ngo) return;
      var mins = Math.max(0, Math.round(safeMinsLeft(b, now)));
      var left = Math.floor(mins / 60) + "h " + (mins % 60) + "m left";
      var rider = b.rider ? b.rider : "Not yet assigned";
      var rr = radarReadout(b, now);
      cards.push('<article class="route-card">' +
        '<header class="route-card-head"><strong>' + esc(b.id) + '</strong> <span class="eta-badge">' +
        esc(b.status) + "</span></header>" +
        '<p class="route-card-path">' + esc(b.caterer) + " \u2192 " + esc(ngo.name) + "</p>" +
        '<p class="route-card-rider"><span class="route-card-label">EV rider</span> ' + esc(rider) + "</p>" +
        '<p class="route-card-meta"><span>' + esc(left) + "</span> <span>ETA " + esc(etaMinFor(ngo)) +
        " min</span>" + (rr ? " <span>" + esc(rr.km.toFixed(1)) + " km left</span>" : "") + "</p>" +
        "</article>");
    });
    box.innerHTML = cards.length ? cards.join("") : '<p class="empty-state">No active corridor routes yet.</p>';
  }


  // NGO cards: remaining meals today, cold storage, acceptance speed, priority-alert toggle.
  function renderNgoNetwork() {
    var grid = $("ngo-network-grid");
    if (!grid) return;
    grid.innerHTML = state.ngos.map(function (n) {
      var accepted = kgAcceptedBy(n.id);
      var capKg = Number(n.dailyCapacityKg) > 0 ? Number(n.dailyCapacityKg) : Math.round((Number(n.capacity) || 0) / 5);
      var meals = Math.max(0, Math.round(capKg / MEAL_KG) - Math.round(accepted / MEAL_KG));
      var focus = state.activeRole === "meera" && n.id === MEERA_NGO_ID;
      return '<article class="card ngo-network-card' + (focus ? " is-focus" : "") + '" data-ngo="' + esc(n.id) + '">' +
        '<div class="card-body">' +
        '<div class="card-header"><div><h3 class="card-title">' + esc(n.name) + '</h3><p class="card-subtitle">' +
        esc(n.locality) + "</p></div></div>" +
        '<div class="meta-grid">' +
        '<div class="meta-pill"><span class="meta-label">Diet</span><span class="meta-value">' + esc(n.diet || n.pref) + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Remaining Meals</span><span class="meta-value">' + esc(meals) + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Cold storage</span><span class="meta-value">' + (n.coldStorage ? "Yes" : "No") + "</span></div>" +
        '<div class="meta-pill"><span class="meta-label">Accept Speed</span><span class="meta-value">' + esc(n.avgAcceptMins) + " min</span></div>" +
        "</div>" +
        "</div>" +
        '<div class="ngo-card-footer"><label class="priority-toggle"><input type="checkbox" data-action="priority-alert" data-id="' + esc(n.id) + '"' +
        (n.priorityAlert ? " checked" : "") + "> Request Priority Alert</label></div>" +
        "</article>";
    }).join("");
  }

  // Feed capacity bars: accepted kg / dailyCapacityKg, capped at 100%.
  function renderCapacityBars() {
    var box = $("ngo-capacity-bars");
    if (!box) return;
    box.innerHTML = state.ngos.map(function (n) {
      var cap = Number(n.dailyCapacityKg) > 0 ? Number(n.dailyCapacityKg) : Math.round((Number(n.capacity) || 0) / 5);
      var accepted = kgAcceptedBy(n.id);
      var rawPct = cap > 0 && isFinite(accepted) ? Math.round(100 * accepted / cap) : 0;
      var pct = isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0;
      return '<div class="capacity-row"><div class="capacity-head"><span>' + esc(n.name) +
        "</span><span>" + esc(fmtNum(accepted)) + " / " + esc(fmtNum(cap)) + " kg</span></div>" +
        '<div class="capacity-track"><span class="capacity-fill" style="width:' + pct + '%"></span></div></div>';
    }).join("");
  }

  // Split-claim panel: Posted batches above 40 kg, top two NGOs by the existing score.
  function renderSplitClaim() {
    var box = $("split-claim-panel");
    if (!box) return;
    var posted = state.batches.filter(function (b) {
      return b.status === "Posted" && !b.locked && (Number(b.kg) || 0) > 40;
    });
    if (!posted.length) {
      box.innerHTML = '<p class="empty">No posted batches above 40 kg need a split.</p>';
      return;
    }
    box.innerHTML = posted.map(function (b) {
      var top = rankNgos(state.ngos, { diet: b.diet, meals: b.servings }).slice(0, 2);
      var buttons = top.length ? top.map(function (m) {
        return '<button type="button" class="btn btn-secondary" data-action="split-claim" data-id="' + esc(b.id) +
          '" data-ngo="' + esc(m.ngo.id) + '">Claim with ' + esc(m.ngo.name) + "</button>";
      }).join("") : '<p class="hint">No compatible NGO with capacity right now.</p>';
      return '<article class="card split-card"><div class="card-header"><div><h3 class="card-title">' + esc(b.food) +
        '</h3><p class="card-subtitle">' + esc(b.id) + " \u00B7 " + esc(fmtNum(b.kg)) + " kg</p></div></div>" +
        '<div class="card-actions">' + buttons + "</div></article>";
    }).join("");
  }

  // Shelf-life estimator: built once so typed values survive re-renders. Handling guidance only.
  function updateEstimator() {
    var out = $("est-output");
    var hoursEl = $("est-hours");
    if (!out || !hoursEl) return;
    if (hoursEl.value === "") {
      out.textContent = "Enter hours since cooked.";
      return;
    }
    var hours = Number(hoursEl.value);
    if (!isFinite(hours) || hours < 0) {
      out.textContent = "Enter hours since cooked (0 or more).";
      return;
    }
    var storageEl = $("est-storage");
    var storage = storageEl ? storageEl.value : "";
    var mins = Math.round(SAFE_HOURS * 60 - hours * 60);
    out.textContent = (mins > 0 ? "Remaining safe time: " + mins + " min" :
      "Past the default " + SAFE_HOURS + " h window: do not distribute") +
      " (" + (storage || "storage not set") + ", default " + SAFE_HOURS + " h window). " +
      "Handling guidance only.";
  }

  function buildEstimator(box) {
    box.innerHTML = '<label>Hours since cooked <input type="number" id="est-hours" min="0" step="0.5"></label> ' +
      '<label>Storage <select id="est-storage"><option value="Hot-held">Hot-held</option>' +
      '<option value="Room Temp">Room Temp</option><option value="Chilled">Chilled</option></select></label>' +
      '<p class="hint" id="est-output"></p>';
    estimatorBuilt = true;
    updateEstimator();
  }

  function renderSafetyChecklist() {
    var box = $("safety-checklist");
    if (!box || box.childElementCount) return;
    var items = ["Check smell and temperature at pickup", "Confirm the allergen list with the caterer",
      "Check the packaging seal before handover", "Consume within 1 hour of delivery",
      "Do not distribute past the safe window"];
    box.innerHTML = "<ul>" + items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>";
  }

  // Safety monitor: each active batch with remaining safe minutes, allergens and packaging.
  function renderSafety() {
    var now = Date.now();
    var mon = $("safety-monitor");
    if (mon) {
      var active = state.batches.filter(isActiveBatch).sort(function (a, c) {
        return safeMinsLeft(a, now) - safeMinsLeft(c, now);
      });
      mon.innerHTML = active.length ? active.map(function (b) {
        var mins = Math.round(safeMinsLeft(b, now));
        var cls = safeClass(mins);
        var allergens = b.allergens && b.allergens.length ? b.allergens.join(", ") : "none declared";
        var timeText = mins > 0
          ? Math.floor(mins / 60) + "h " + (mins % 60) + "m left"
          : "Expired";
        return '<article class="card safety-card">' +
          '<div class="card-body">' +
          '<div class="card-header"><div>' +
          '<h3 class="card-title">' + esc(b.food) + '</h3><p class="card-subtitle">' + esc(b.id) + " \u00B7 " +
          esc(b.caterer) + "</p></div></div>" +
          '<p><span class="safety-time safety-' + cls + '">' + esc(timeText) + "</span></p>" +
          "<p>Allergens: " + esc(allergens) + "</p>" +
          "<p>Packaging: " + esc(b.packaging || "not stated") + "</p>" +
          "</div></article>";
      }).join("") : '<p class="empty">No active batches to monitor.</p>';
    }
    var est = $("safety-estimator");
    if (est && !estimatorBuilt) buildEstimator(est);
    renderSafetyChecklist();
  }

  // Impact KPIs from Delivered batches only.
  function renderEsgKpis() {
    var el = $("esg-kpis");
    if (!el) return;
    var kg = 0;
    var turnSum = 0;
    var turnCount = 0;
    state.batches.forEach(function (b) {
      if (b.status !== "Delivered") return;
      kg += Number(b.kg) || 0;
      var delivered = deliveredAtOf(b);
      var claimed = typeof b.claimedAt === "number" ? b.claimedAt : eventAt(b, "Claimed");
      if (delivered !== null && claimed !== null) {
        turnSum += (delivered - claimed) / MIN;
        turnCount += 1;
      }
    });
    var meals = Math.round(kg / MEAL_KG);
    el.innerHTML =
      kpiCardHtml("Meals Saved", fmtNum(meals), "meals (kg \u00F7 0.4)", "") +
      kpiCardHtml("Food Waste Avoided", fmtNum(kg), "kg diverted", "") +
      kpiCardHtml("CO2e Prevented", fmtNum(Math.round(kg * CO2_FACTOR * 10) / 10), "kg CO2e (kg \u00D7 2.5)", "kpi-emerald") +
      kpiCardHtml("Value Saved", fmtInr(meals * MEAL_VALUE_INR), "meals \u00D7 \u20B965", "") +
      kpiCardHtml("Avg Turnaround", fmtNum(turnCount ? Math.round(turnSum / turnCount) : 0), "min, claimed to delivered", "");
  }

  // Assumptions list, hidden until #btn-esg-methodology is pressed.
  function renderEsgMethodology() {
    var el = $("esg-methodology");
    if (!el || methodologyBuilt) return;
    methodologyBuilt = true;
    el.innerHTML = '<p class="hint">Assumptions behind every impact figure:</p><ul>' +
      ["1 meal = 0.4 kg", "2.5 kg CO2e per kg", "\u20B965 per meal"].map(function (t) {
        return "<li>" + esc(t) + "</li>";
      }).join("") + "</ul>";
    el.hidden = true;
  }

  function toggleMethodology() {
    var el = $("esg-methodology");
    if (!el) return;
    el.hidden = !el.hidden;
    var btn = $("btn-esg-methodology");
    if (btn) btn.setAttribute("aria-expanded", el.hidden ? "false" : "true");
  }

  // Nav badges. Caterer and radar = active batches; feed = Posted + Claimed + Collected;
  // safety = under 60 safe minutes and not Expired; impact = Delivered; roi = sponsored this session.
  function setBadge(key, count) {
    var els = document.querySelectorAll('[data-badge="' + key + '"]');
    Array.prototype.forEach.call(els, function (el) { el.textContent = String(count); });
    return els;
  }

  function renderNavBadges() {
    var now = Date.now();
    var active = 0;
    var feed = 0;
    var safety = 0;
    var delivered = 0;
    state.batches.forEach(function (b) {
      if (isActiveBatch(b)) active += 1;
      if (b.status === "Posted" || b.status === "Claimed" || b.status === "Collected") feed += 1;
      if (b.status === "Delivered") delivered += 1;
      if (b.status !== "Expired" && safeMinsLeft(b, now) < 60) safety += 1;
    });
    setBadge("caterer", active);
    setBadge("radar", active);
    setBadge("feed", feed);
    setBadge("ngos", state.ngos.length);
    setBadge("impact", delivered);
    setBadge("roi", sponsoredIds.size);
    var safetyEls = setBadge("safety", safety);
    Array.prototype.forEach.call(safetyEls, function (el) { el.classList.toggle("alert", safety > 0); });
  }

  // Live Dispatch role visibility (view-feed), driven by state.activeRole. Defined once; called at the end of renderAll().
  // arjun (rider): hides NGO panel, capacity bars, split-claim, NGO heading and open-Posted column; shows rider-mission;
  //   batch list limited to rider names containing "R-07".
  // meera (receiver): keeps only the Annapurna NGO card, hides the rescues column, shows the Annapurna summary line.
  // Other roles and the empty role: clear every hidden state this function sets.
  function applyFeedRoleVisibility() {
    var role = state.activeRole;
    var isArjun = role === "arjun";
    var isMeera = role === "meera";
    var ngoHeading = null;
    var liveHeading = null;
    var rescueHeading = null;

    Array.prototype.forEach.call(document.querySelectorAll("#view-feed h2"), function (h) {
      var t = String(h.textContent || "").trim();
      if (t === "NGO capacity (servings/day)") ngoHeading = h;
      else if (t === "Live feed: open Posted batches") liveHeading = h;
      else if (t === "Rider dispatch: active rescues") rescueHeading = h;
    });

    // Column container: the section.panel wrapping a heading and its list. Null if not found (never falls back to the whole view).
    function panelOf(h) {
      return h && h.closest ? h.closest("section.panel") : null;
    }

    function setHidden(el, on) {
      if (el) el.hidden = !!on;
    }

    function batchForCard(el) {
      var idEl = el.querySelector ? el.querySelector("[data-id]") : null;
      var id = idEl ? idEl.getAttribute("data-id") : "";
      if (!id) return null;
      for (var i = 0; i < state.batches.length; i++) {
        if (state.batches[i].id === id) return state.batches[i];
      }
      return null;
    }

    function filterRiderList(list) {
      if (!list) return;
      Array.prototype.forEach.call(list.children, function (el) {
        var b = batchForCard(el);
        var show;
        if (b) show = !!b.rider && String(b.rider).indexOf("R-07") !== -1;
        else show = el.classList.contains("empty") || String(el.textContent || "").indexOf("R-07") !== -1;
        el.hidden = !show;
      });
    }

    function resetList(list) {
      if (!list) return;
      Array.prototype.forEach.call(list.children, function (el) { el.hidden = false; });
    }

    function annapurnaSummaryText() {
      var ngo = ngoById(MEERA_NGO_ID);
      if (!ngo) return "Annapurna Seva Trust: details not available.";
      var capKg = Number(ngo.dailyCapacityKg) > 0 ? Number(ngo.dailyCapacityKg) : Math.round((Number(ngo.capacity) || 0) / 5);
      var accepted = kgAcceptedBy(ngo.id);
      var meals = Math.max(0, Math.round(capKg / MEAL_KG) - Math.round(accepted / MEAL_KG));
      var assigned = null;
      for (var i = 0; i < state.batches.length; i++) {
        var b = state.batches[i];
        if (b.ngoId === MEERA_NGO_ID && b.status !== "Expired") { assigned = b; break; }
      }
      var tail = assigned ? "Batch " + assigned.id + " ETA " + etaMinFor(ngo) + " min" : "No batch assigned right now";
      return "Annapurna Seva Trust: " + meals + " remaining meals | " + tail;
    }

    // Arjun: NGO panel, capacity bars, split-claim, NGO heading and open-Posted column hidden; rider-mission shown.
    var ngoPanel = $("ngo-panel");
    setHidden(ngoPanel, isArjun);
    setHidden($("ngo-capacity-bars"), isArjun);
    setHidden($("split-claim-panel"), isArjun);
    setHidden(ngoHeading, isArjun);
    setHidden(panelOf(liveHeading), isArjun);
    // Meera: rescues column hidden.
    setHidden(panelOf(rescueHeading), isMeera);
    // rider-mission visibility for other roles is owned by renderPersona()/setPanel(), so only arjun is set here.
    if (isArjun) setHidden($("rider-mission"), false);

    // NGO cards in #ngo-panel follow state.ngos order (renderNgoPanel). Meera keeps only the Annapurna card.
    if (ngoPanel) {
      Array.prototype.forEach.call(ngoPanel.children, function (card, i) {
        var n = state.ngos[i];
        card.hidden = isMeera && !!n && n.id !== MEERA_NGO_ID;
      });
    }

    // Batch lists: arjun sees only R-07 batches; everyone else sees the full list (persona filters already applied by renderFeed).
    var postedList = $("feed-posted");
    var activeList = $("feed-active");
    if (isArjun) {
      filterRiderList(postedList);
      filterRiderList(activeList);
    } else {
      resetList(postedList);
      resetList(activeList);
    }

    // Annapurna summary line, placed after the feed message. Shown for meera only.
    var summary = $("feed-annapurna-summary");
    if (!summary) {
      var msg = $("feed-msg");
      if (msg && msg.parentNode) {
        summary = document.createElement("p");
        summary.id = "feed-annapurna-summary";
        summary.className = "hint";
        msg.parentNode.insertBefore(summary, msg.nextSibling);
      }
    }
    if (summary) {
      summary.hidden = !isMeera;
      if (isMeera) summary.textContent = annapurnaSummaryText();
    }
  }

  // Inline SVG fallbacks for offline use, when the lucide script did not load.
  var SVG_OPEN = '<svg class="lucide-fallback" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var FALLBACK_ICONS = {
    "utensils": SVG_OPEN + '<path d="M7 3v6"/><path d="M5 3v4a2 2 0 0 0 4 0V3"/><path d="M7 9v12"/><path d="M17 21V3c-2 1-3 4-3 8h3"/></svg>',
    "radio": SVG_OPEN + '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/></svg>',
    "radar": SVG_OPEN + '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/></svg>',
    "building-2": SVG_OPEN + '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/><path d="M8 6h2"/><path d="M14 6h2"/><path d="M8 10h2"/><path d="M14 10h2"/><path d="M8 14h2"/><path d="M14 14h2"/></svg>',
    "shield-check": SVG_OPEN + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    "leaf": SVG_OPEN + '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/></svg>',
    "indian-rupee": SVG_OPEN + '<path d="M6 3h12"/><path d="M6 8h12"/><path d="M7 3c0 6 3 10 8 10"/><path d="M7 13l8 8"/></svg>',
    "flame": SVG_OPEN + '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8a7 7 0 0 0 7 7z"/></svg>',
    "drumstick": SVG_OPEN + '<path d="M15 9l-5 5"/><ellipse cx="17" cy="6" rx="3" ry="4" transform="rotate(45 17 6)"/><path d="M6 14c-2 2-2 5 0 7s5 2 7 0"/></svg>',
    "alert-triangle": SVG_OPEN + '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    "arrow-right": SVG_OPEN + '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
    "download": SVG_OPEN + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    "chevron-down": SVG_OPEN + '<path d="M6 9l6 6 6-6"/></svg>',
    "shield-alert": SVG_OPEN + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>'
  };

  // Renders lucide icons; falls back to FALLBACK_ICONS when lucide is unavailable.
  function renderIcons() {
    if (typeof lucide === "undefined" || !lucide || !lucide.createIcons) {
      var nodes = document.querySelectorAll("[data-lucide]");
      Array.prototype.forEach.call(nodes, function (el) {
        if (el.querySelector("svg")) return;
        var name = el.getAttribute("data-lucide");
        el.innerHTML = Object.prototype.hasOwnProperty.call(FALLBACK_ICONS, name) ? FALLBACK_ICONS[name] : "";
      });
      return;
    }
    lucide.createIcons();
  }

  function renderAll() {
    populateEsgSelect();
    renderCatererList();
    renderWasteInsight();
    renderFeed();
    renderImpact();
    renderPulse();
    renderHeroStats();
    renderBusinessModel();
    renderPersona();
    renderCorridorMap();
    renderCorridorEta();
    renderNgoNetwork();
    renderCapacityBars();
    renderSplitClaim();
    renderSafety();
    renderEsgKpis();
    renderEsgMethodology();
    renderNavBadges();
    applyFeedRoleVisibility();
    renderIcons();
    if (!saveSuppressed) saveDb();
  }

  function setView(view) {
    if (!renderers[view]) return;
    // Sidebar .nav-item buttons (and any legacy .tab): active class + aria-selected in one pass.
    var tabs = document.querySelectorAll(".nav-item, .tab");
    Array.prototype.forEach.call(tabs, function (t) {
      var on = t.getAttribute("data-view") === view;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["caterer", "feed", "radar", "ngos", "safety", "impact", "roi"].forEach(function (v) {
      var panel = $("view-" + v);
      if (panel) panel.classList.toggle("active", v === view);
    });
    renderers[view]();
    renderIcons();
  }

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (target.closest && target.closest(".modal-close")) {
      hideHandling();
      return;
    }
    var el = target.closest ? target.closest("[data-action]") : null;
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    if (action === "tab") {
      setView(el.getAttribute("data-view"));
    } else if (action === "claim") {
      var before = findBatch(id);
      var wasPosted = !!before && before.status === "Posted";
      claimBatch(id);
      var claimed = findBatch(id);
      if (wasPosted && claimed && claimed.status === "Claimed") queueClaimedAlerts(claimed);
      renderAll();
    } else if (action === "override-assign") {
      overrideAssign(id);
      renderAll();
    } else if (action === "confirm-pickup") {
      confirmPickup(id);
      renderAll();
    } else if (action === "confirm-delivery") {
      confirmDelivery(id);
      renderAll();
    } else if (action === "handling") {
      openHandling(id);
    }
  });

  // Temperature checkbox state lives on the batch so it survives the 30 s re-render.
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute("data-override-select")) {
      // Stored on state (not re-rendered) so the choice survives the periodic feed refresh.
      state.overrides[t.getAttribute("data-override-select")] = t.value;
      return;
    }
    if (!t.hasAttribute("data-temp-check")) return;
    var b = findBatch(t.getAttribute("data-temp-check"));
    if (!b) return;
    b.tempChecked = t.checked;
    renderFeed();
  });

  // Dispatch filter pills: switch the filter and re-render the feed.
  var dispatchFilters = $("dispatch-filters");
  if (dispatchFilters) {
    dispatchFilters.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-filter]") : null;
      if (!btn) return;
      state.dispatchFilter = btn.getAttribute("data-filter");
      renderFeed();
    });
  }

  var autofillBtn = $("btn-autofill-wedding");
  if (autofillBtn) autofillBtn.addEventListener("click", autofillWeddingSurplus);

  var csvBtn = $("btn-download-csv");
  if (csvBtn) csvBtn.addEventListener("click", downloadAuditCsv);


  var donateForm = $("donate-form");
  donateForm.addEventListener("submit", onDonateSubmit);
  donateForm.addEventListener("click", onDonateClick);
  donateForm.addEventListener("input", onDonateInput);
  donateForm.addEventListener("change", renderDonateWidgets);

  $("caterer-filter").addEventListener("change", function (e) {
    state.catererFilter = e.target.value;
    renderCatererList();
  });

  // Header search (live) and locality filter (on change). Both re-render every view.
  var headerSearch = $("header-search-input");
  if (headerSearch) {
    headerSearch.addEventListener("input", function (e) {
      state.searchQuery = String((e.target && e.target.value) || "").trim();
      // Keystroke re-render: do not write to localStorage.
      saveSuppressed = true;
      try { renderAll(); } finally { saveSuppressed = false; }
    });
  }
  var headerLocality = $("header-locality-select");
  if (headerLocality) {
    headerLocality.addEventListener("change", function (e) {
      state.localityFilter = (e.target && e.target.value) || "";
      renderAll();
    });
  }

  // ROI slider listeners are attached in initRoiTab() (called from init below).

  var resetBtn = $("reset-demo-btn");
  if (resetBtn) resetBtn.addEventListener("click", resetDemoData);

  var simBtn = $("btn-simulate-rescue");
  if (simBtn) simBtn.addEventListener("click", onSimulateRescue);

  var esgGenBtn = $("esg-generate-btn");
  if (esgGenBtn) esgGenBtn.addEventListener("click", onEsgGenerate);
  var esgPrintBtn = $("esg-print-btn");
  if (esgPrintBtn) {
    esgPrintBtn.addEventListener("click", function () {
      if (typeof window.print === "function") window.print();
    });
  }

  // Hero CTA: switch to the Caterer Portal panel and bring it into view.
  var heroCta = $("hero-cta");
  if (heroCta) {
    heroCta.addEventListener("click", function () {
      setView("caterer");
      var panel = $("view-caterer");
      if (panel && typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }



  // ---------- init ----------
  var legal = $("legal-text");
  if (legal) legal.textContent = D.DISCLAIMER;
  setCityStatusPill();
  renderLocalitySelect();
  renderDonateWidgets();
  // Snapshot the seed first so resetDemoData() still restores the seed, then load saved state.
  takeSeedSnapshot();
  loadDb();
  populateCatererFilter();
  populateHeaderLocality();
  initRoiTab();
  var roleSelect = $("role-select");
  if (roleSelect) {
    roleSelect.value = state.activeRole || "";
    roleSelect.addEventListener("change", onRoleChange);
  }
  // Delegated listeners for the v6 modules: attached once here, never inside a render.
  document.addEventListener("click", onModuleClick);
  document.addEventListener("change", onModuleChange);
  // Radar pin and popover listeners: attached once here.
  bindRadarListeners();
  var estimatorHost = $("safety-estimator");
  if (estimatorHost) {
    estimatorHost.addEventListener("input", updateEstimator);
    estimatorHost.addEventListener("change", updateEstimator);
  }
  var methodologyBtn = $("btn-esg-methodology");
  if (methodologyBtn) methodologyBtn.addEventListener("click", toggleMethodology);
  // Handover receipt, print, modal close and WhatsApp drawer: one delegated click listener.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var toggle = t.closest("#whatsapp-toggle");
    if (toggle) {
      var drawer = $("whatsapp-drawer");
      if (drawer) setWhatsAppOpen(drawer.hidden);
      return;
    }
    var el = t.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    if (action === "handover-receipt") {
      openHandoverReceipt(el.getAttribute("data-id"));
    } else if (action === "print-receipt") {
      printHandoverReceipt();
    } else if (action === "close-modal") {
      closeHandoverReceipt();
    } else if (action === "close-whatsapp") {
      setWhatsAppOpen(false);
    }
  });
  window.addEventListener("afterprint", function () {
    if (document.body) document.body.classList.remove("printing-receipt");
  });
  updateWhatsAppBadge();
  renderAll();

  // Refresh urgency countdowns and live feed every 30 seconds.
  // Only non-form views are refreshed so typing in the donate form is not disrupted.
  setInterval(function () {
    renderCatererList();
    renderFeed();
    renderImpact();
    renderPulse();
    renderHeroStats();
  }, 30 * 1000);
})();
