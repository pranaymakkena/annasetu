/* AnnaSetu app logic: in-memory state, one render function per view, escaped output. */
(function () {
  "use strict";

  var D = window.AnnaSetuData;
  var MIN = 60 * 1000;
  var URGENT_MIN = 45;
  var STAGES = ["Posted", "Claimed", "Collected", "Delivered"];
  // Synthetic riders for dispatch, assigned round-robin. Names and vehicles are fictional.
  var RIDERS = [
    { name: "Rider R-07", vehicle: "Bike (EV)" },
    { name: "Rider R-12", vehicle: "Scooter" },
    { name: "Rider R-19", vehicle: "Cargo auto" }
  ];

  var state = {
    batches: D.buildSeedBatches(Date.now()),
    ngos: D.NGOS,
    catererFilter: "",
    feedMsg: "",
    nextNum: 1005,
    riderIdx: 0,
    roi: { events: 20, kgPerEvent: 35, costPerKg: 12, feePerEvent: 150 },
    // Draft choices for the donate form. kg/meals are read from the slider on each change.
    donate: { foodChoice: "", customFood: "", diet: "", kg: 20, meals: 50, windowHours: null,
      cookedHoursAgo: null, storage: "", allergens: [], packaging: "" }
  };

  var tickerId = null;

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
  // ETA in minutes: distance at 0.25 km per minute, minimum 5.
  function etaFor(b) {
    if (b.etaMin) return b.etaMin;
    var ngo = ngoById(b.ngoId);
    return Math.max(5, Math.round((ngo ? ngo.distance_km : 0) / 0.25));
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
  var KG_PER_MEAL = 0.4;

  function mealsFor(kg) { return Math.round(kg / KG_PER_MEAL); }

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
        changed = true;
      }
    });
    return changed;
  }

  // Posted -> Claimed: top-ranked NGO with room for the whole batch, round-robin rider.
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
    var ngo = ranked[0].ngo;
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
    state.feedMsg = b.id + " claimed by " + ngo.name + " (" + fmtNum(ngo.distance_km) + " km). " +
      b.rider + " (" + b.vehicle + ") assigned.";
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
    state.feedMsg = b.id + " collected by " + b.rider + " at " + hhmm(now) + ".";
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
    state.feedMsg = b.id + " delivered to " + (ngo ? ngo.name : "NGO") +
      " (+" + b.credits + " impact credits).";
  }

  // Action buttons for a feed card. Expired and Delivered listings get none.
  function feedActionsHtml(b) {
    if (b.locked || b.status === "Expired" || b.status === "Delivered") return "";
    if (b.status === "Posted") {
      return '<button type="button" class="btn primary" data-action="claim" data-id="' + esc(b.id) +
        '">Claim Batch (Assign Volunteer)</button>';
    }
    if (b.status === "Claimed") {
      return '<label class="temp-check"><input type="checkbox" data-temp-check="' + esc(b.id) + '"' +
        (b.tempChecked ? " checked" : "") + "> Core temp checked \u2265 60\u00B0C or chilled \u2264 5\u00B0C</label>" +
        '<button type="button" class="btn emerald" data-action="confirm-pickup" data-id="' + esc(b.id) + '"' +
        (b.tempChecked ? "" : " disabled") + ">Confirm Pickup &amp; Check Temp</button>";
    }
    if (b.status === "Collected") {
      return '<button type="button" class="btn emerald" data-action="confirm-delivery" data-id="' + esc(b.id) +
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
    body.innerHTML =
      "<h3>Receiver Handling &amp; Safety Checklist</h3>" +
      "<p>" + esc(b.id) + " \u00B7 " + esc(b.food) + "</p>" +
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
    var matches = rankNgos(state.ngos, { diet: d.diet, meals: d.meals }).slice(0, 2);

    if (!matches.length) {
      preview.innerHTML = '<p class="hint">No compatible NGO with capacity right now.</p>';
      return;
    }
    preview.innerHTML = matches.map(function (m) {
      return '<span class="badge">' + esc(m.pct + "% Match \u2022 " + fmtNum(m.km) + " km away \u2022 Needs " +
        m.needsMeals + " meals") + "</span>";
    }).join(" ");
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

    resetDonateForm();
    msg.textContent = "Batch " + id + " posted. It is now live in the NGO & Rider Dispatch feed.";
    populateCatererFilter();
    renderAll();
  }

  // ---------- render: shared pieces ----------
  function badgeHtml(status) {
    return '<span class="badge badge-' + esc(status.toLowerCase()) + '">' + esc(status) + "</span>";
  }

  function formatCountdown(leftMs) {
    if (leftMs <= 0) return "Expired";
    var secs = Math.floor(leftMs / 1000);
    return pad(Math.floor(secs / 60)) + ":" + pad(secs % 60);
  }

  // Live countdown element; the ticker keeps its text and classes current.
  // Expired listings show the lock text instead of a countdown.
  function urgencyHtml(b, now) {
    if (b.status === "Expired") return '<span class="urgency expired">Expired \u2014 Do Not Distribute</span>';
    if (b.status === "Delivered") return '<span class="urgency ok">Completed</span>';
    var left = b.expiresAt - now;
    var cls = (isLive(b) ? " live" : "") + (left < URGENT_MIN * MIN ? " urgent" : "");
    return '<span class="urgency' + (cls || " ok") + '" data-expires="' + esc(b.expiresAt) +
      '" data-status="' + esc(b.status) + '">' + esc(formatCountdown(left)) + "</span>";
  }

  // Updates only the text/classes of [data-expires] elements, once per second.
  // If a listing crosses its deadline, the lock is applied and the views re-render.
  function tickCountdowns() {
    var now = Date.now();
    if (lockExpired(now)) {
      renderAll();
      return;
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-expires]"), function (el) {
      var left = Number(el.getAttribute("data-expires")) - now;
      var live = el.getAttribute("data-status") === "Claimed" || el.getAttribute("data-status") === "Collected";
      el.classList.toggle("live", live);
      el.classList.toggle("urgent", left < URGENT_MIN * MIN);
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

  // Pickup tracker: a step list with completed stages ticked and the current stage marked.
  function stageDetailHtml(b, i, idx) {
    if (i === 1 && idx === 1 && b.rider) {
      var vehicle = b.vehicle || riderVehicle(b.rider);
      return '<span class="step-detail">Rider: ' + esc(b.rider) + " \u2022 " + esc(vehicle) +
        " \u2022 ETA " + esc(etaFor(b)) + " min</span>";
    }
    if (i === 2 && idx >= 2) {
      var at = b.collectedAt || eventAt(b, "Collected");
      return at ? '<span class="step-detail">Picked up ' + esc(hhmm(at)) + "</span>" : "";
    }
    if (i === 3 && idx === 3) {
      return '<span class="step-detail">Delivered \u2022 +' + esc(creditsFor(b)) + " impact credits</span>";
    }
    return "";
  }

  function trackerHtml(b) {
    var idx = STAGES.indexOf(b.status); // -1 for Expired: every step shows as pending
    var steps = STAGES.map(function (name, i) {
      var cls = idx === -1 ? "pending" : (i < idx ? "done" : (i === idx ? "current" : "pending"));
      var mark = cls === "done" ? "\u2713 " : "";
      return '<li class="step ' + cls + '">' + mark + esc(name) + stageDetailHtml(b, i, idx) + "</li>";
    }).join("");
    return '<ol class="tracker" aria-label="Pickup stages">' + steps + "</ol>";
  }

  // Compact SVG radar: donor at the centre, NGO pins at deterministic angles,
  // and a rider dot on the donor-to-NGO line for in-transit stages.
  function renderRadar(b) {
    var C = 100;
    var maxKm = 1;
    state.ngos.forEach(function (n) { if (n.distance_km > maxKm) maxKm = n.distance_km; });
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var assignedPt = null;
    var out = '<svg class="radar" viewBox="0 0 200 200" role="img" aria-label="' +
      esc("Dispatch radar for " + b.id) + '">';

    [25, 50, 75].forEach(function (r) {
      out += '<circle class="radar-ring" cx="100" cy="100" r="' + r + '" fill="none"></circle>';
    });

    state.ngos.forEach(function (n, i) {
      var ang = -Math.PI / 2 + (i * 2 * Math.PI) / state.ngos.length;
      var r = 18 + (n.distance_km / maxKm) * 68;
      var x = (C + r * Math.cos(ang)).toFixed(1);
      var y = (C + r * Math.sin(ang)).toFixed(1);
      var assigned = !!ngo && ngo.id === n.id;
      if (assigned) assignedPt = { x: Number(x), y: Number(y) };
      out += '<g class="ngo-pin' + (assigned ? " assigned" : "") + '"><title>' + esc(n.name) + "</title>" +
        '<circle cx="' + x + '" cy="' + y + '" r="7"></circle>' +
        '<text x="' + x + '" y="' + y + '" text-anchor="middle" dy="3">' + esc(n.name.charAt(0)) + "</text></g>";
    });

    out += '<circle class="donor-pin" cx="100" cy="100" r="6"></circle>';
    out += '<text class="radar-label" x="100" y="196" text-anchor="middle">' +
      esc("Donor: " + String(b.caterer || "").slice(0, 22)) + "</text>";

    var progress = { Claimed: 0.25, Collected: 0.6, Delivered: 1.0 }[b.status];
    if (assignedPt && progress !== undefined) {
      var rx = (C + progress * (assignedPt.x - C)).toFixed(1);
      var ry = (C + progress * (assignedPt.y - C)).toFixed(1);
      var cls = "rider-dot" + (b.status === "Delivered" ? "" : " rider-pulse");
      out += '<circle class="' + cls + '" cx="' + rx + '" cy="' + ry + '" r="5"><title>' +
        esc(b.rider || "Rider") + "</title></circle>";
    }
    return out + "</svg>";
  }

  // Listing card. actionHtml is trusted markup built by this file (ids are escaped).
  function cardHtml(b, now, actionHtml) {
    var cls = b.status === "Expired" ? "expired" : (isLive(b) ? "live" : (isUrgent(b, now) ? "urgent" : ""));
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var html = '<article class="card ' + cls + '">';
    html += '<div class="card-top"><h3>' + esc(b.food) + "</h3>" + badgeHtml(b.status) + "</div>";
    html += '<p class="meta"><strong>' + esc(b.id) + "</strong> · " + esc(b.caterer) + " · " + esc(b.locality) + "</p>";
    html += '<p class="meta">' + esc(b.diet) + " · " + esc(b.servings) + " servings · " + fmtNum(b.kg) + " kg</p>";
    html += '<p class="meta">Prepared ' + fmtTime(b.preparedAt) + " · Expires " + fmtTime(b.expiresAt) + "</p>";
    if (ngo) {
      html += '<p class="meta">NGO: ' + esc(ngo.name) + "</p>";
    }
    html += urgencyHtml(b, now);
    if (b.dispatchNote) html += '<p class="warn">' + esc(b.dispatchNote) + "</p>";
    html += trackerHtml(b);
    html += '<div class="radar-wrap">' + renderRadar(b) + "</div>";
    var actions = actionHtml || "";
    if (isOpenStatus(b)) {
      actions += '<button type="button" class="btn" data-action="handling" data-id="' + esc(b.id) +
        '">Handling guide</button>';
    }
    if (actions) html += '<div class="actions">' + actions + "</div>";
    html += '<p class="disclaimer">' + esc(D.DISCLAIMER) + "</p>";
    html += "</article>";
    return html;
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
      return !state.catererFilter || b.caterer === state.catererFilter;
    }).sort(function (a, b) { return b.preparedAt - a.preparedAt; });

    if (!list.length) {
      $("caterer-list").innerHTML = '<p class="empty">No batches yet. Post one using the form.</p>';
    } else {
      $("caterer-list").innerHTML = list.map(function (b) {
        return cardHtml(b, now, "");
      }).join("");
    }
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
    $("ngo-panel").innerHTML = state.ngos.map(function (n) {
      var used = ngoUsed(n.id);
      var rem = n.capacity - used;
      var pct = Math.min(100, Math.round((used / n.capacity) * 100));
      return '<article class="ngo-card">' +
        "<h3>" + esc(n.name) + "</h3>" +
        '<p class="meta">' + esc(n.locality) + " · " + esc(n.pref) + " · " + fmtNum(n.distance_km) + " km</p>" +
        '<div class="bar" role="img" aria-label="' + pct + '% used"><span style="width:' + pct + '%"></span></div>' +
        '<p class="meta">Capacity ' + esc(n.capacity) + " · Used " + used +
        " · Remaining <strong>" + rem + "</strong></p>" +
        '<p class="meta">Delivered batches: ' + (n.served || 0) + "</p>" +
        "</article>";
    }).join("");
  }

  function renderFeed() {
    var now = Date.now();
    lockExpired(now);
    renderNgoPanel();
    $("feed-msg").textContent = state.feedMsg;

    var posted = state.batches.filter(function (b) { return b.status === "Posted"; })
      .sort(function (a, b) { return a.expiresAt - b.expiresAt; });
    $("feed-posted").innerHTML = posted.length ? posted.map(function (b) {
      return cardHtml(b, now, feedActionsHtml(b));
    }).join("") : '<p class="empty">No open batches right now.</p>';

    var active = state.batches.filter(function (b) { return b.status !== "Posted"; })
      .sort(function (a, b) { return b.preparedAt - a.preparedAt; });
    $("feed-active").innerHTML = active.length ? active.map(function (b) {
      return cardHtml(b, now, feedActionsHtml(b));
    }).join("") : '<p class="empty">No active rescues yet.</p>';
    startTicker();
  }


  // ---------- render: view 3 (impact) ----------
  function renderImpact() {
    var delivered = state.batches.filter(function (b) { return b.status === "Delivered"; });
    var servings = 0;
    var kg = 0;
    var ngoSet = [];
    delivered.forEach(function (b) {
      servings += b.servings;
      kg += b.kg;
      if (b.ngoId && ngoSet.indexOf(b.ngoId) === -1) ngoSet.push(b.ngoId);
    });
    var co2 = kg * D.CO2_FACTOR;

    function stat(value, label) {
      return '<div class="stat"><div class="value">' + value + '</div><div class="label">' + label + "</div></div>";
    }
    $("impact-stats").innerHTML =
      stat(servings.toLocaleString("en-IN"), "Servings rescued (illustrative)") +
      stat(fmtNum(kg), "kg diverted (illustrative)") +
      stat(fmtNum(co2), "kg CO2e avoided (illustrative)") +
      stat(ngoSet.length, "NGOs served (synthetic)");

    var rows = [];
    state.batches.forEach(function (b) {
      b.events.forEach(function (e) {
        rows.push({ at: e.at, b: b, type: e.type });
      });
    });
    rows.sort(function (a, c) { return a.at - c.at; });

    $("ledger-body").innerHTML = rows.length ? rows.map(function (r) {
      var ngo = r.b.ngoId ? ngoById(r.b.ngoId) : null;
      return "<tr>" +
        "<td>" + esc(new Date(r.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })) + "</td>" +
        "<td>" + esc(r.b.id) + "</td>" +
        "<td>" + esc(r.b.caterer) + "</td>" +
        "<td>" + esc(r.type) + "</td>" +
        "<td>" + esc(ngo ? ngo.name : "-") + "</td>" +
        "<td>" + esc(r.b.rider || "-") + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="6">No events yet.</td></tr>';
  }

  // ---------- render: view 4 (ROI) ----------
  function renderRoiOutputs() {
    var r = state.roi;
    var kgDiverted = r.events * r.kgPerEvent;
    var disposalAvoided = kgDiverted * r.costPerKg;
    var fees = r.events * r.feePerEvent;
    var net = disposalAvoided - fees;

    $("roi-out").innerHTML =
      '<table><tbody>' +
      "<tr><td>Kg diverted per month</td><td><strong>" + fmtNum(kgDiverted) + " kg</strong></td></tr>" +
      "<tr><td>Monthly disposal cost avoided</td><td><strong>" + fmtInr(disposalAvoided) + "</strong></td></tr>" +
      "<tr><td>Platform fees paid</td><td><strong>" + fmtInr(fees) + "</strong></td></tr>" +
      "<tr><td>Net monthly savings</td><td><strong>" + fmtInr(net) + "</strong></td></tr>" +
      "</tbody></table>" +
      '<p class="hint">Formula: disposal avoided = events &times; kg per event &times; cost per kg; ' +
      "net = disposal avoided &minus; (events &times; fee per event). All inputs are illustrative assumptions.</p>";
  }

  function readRoiInputs() {
    function num(id, fallback) {
      var v = Number($(id).value);
      return isFinite(v) && v >= 0 ? v : fallback;
    }
    state.roi = {
      events: num("roi-events", 0),
      kgPerEvent: num("roi-kg", 0),
      costPerKg: num("roi-cost", 0),
      feePerEvent: num("roi-fee", 0)
    };
  }

  // ---------- navigation & wiring ----------
  var renderers = {
    caterer: function () { renderCatererList(); },
    feed: function () { renderFeed(); },
    impact: function () { renderImpact(); },
    roi: function () { renderRoiOutputs(); }
  };

  function renderAll() {
    renderCatererList();
    renderFeed();
    renderImpact();
    renderRoiOutputs();
  }

  function setView(view) {
    if (!renderers[view]) return;
    var tabs = document.querySelectorAll(".tab");
    Array.prototype.forEach.call(tabs, function (t) {
      var on = t.getAttribute("data-view") === view;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["caterer", "feed", "impact", "roi"].forEach(function (v) {
      $("view-" + v).classList.toggle("active", v === view);
    });
    renderers[view]();
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
      claimBatch(id);
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
    if (!t || !t.hasAttribute || !t.hasAttribute("data-temp-check")) return;
    var b = findBatch(t.getAttribute("data-temp-check"));
    if (!b) return;
    b.tempChecked = t.checked;
    renderFeed();
  });


  var donateForm = $("donate-form");
  donateForm.addEventListener("submit", onDonateSubmit);
  donateForm.addEventListener("click", onDonateClick);
  donateForm.addEventListener("input", onDonateInput);
  donateForm.addEventListener("change", renderDonateWidgets);

  $("caterer-filter").addEventListener("change", function (e) {
    state.catererFilter = e.target.value;
    renderCatererList();
  });

  $("roi-form").addEventListener("input", function () {
    readRoiInputs();
    renderRoiOutputs();
  });

  // ---------- init ----------
  $("legal-text").textContent = D.DISCLAIMER;
  renderLocalitySelect();
  renderDonateWidgets();
  $("roi-events").value = state.roi.events;
  $("roi-kg").value = state.roi.kgPerEvent;
  $("roi-cost").value = state.roi.costPerKg;
  $("roi-fee").value = state.roi.feePerEvent;
  populateCatererFilter();
  renderAll();

  // Refresh urgency countdowns and live feed every 30 seconds.
  // Only non-form views are refreshed so typing in the donate form is not disrupted.
  setInterval(function () {
    renderCatererList();
    renderFeed();
    renderImpact();
  }, 30 * 1000);
})();
