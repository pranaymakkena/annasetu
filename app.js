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
    feedMsg: "",
    nextNum: 1005,
    riderIdx: 0,
    dispatchFilter: "all",
    // Manual NGO override choices per Posted batch id; kept across re-renders.
    overrides: {},
    // Draft choices for the donate form. kg/meals are read from the slider on each change.
    donate: { foodChoice: "", customFood: "", diet: "", kg: 20, meals: 50, windowHours: null,
      cookedHoursAgo: null, storage: "", allergens: [], packaging: "" }
  };

  var tickerId = null;
  var seedSnapshot = null;
  var resetMsgTimer = null;

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

    resetDonateForm();
    msg.textContent = "Batch " + id + " posted. It is now live in the NGO & Rider Dispatch feed.";
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
    return '<span class="badge badge-' + esc(status.toLowerCase()) + '">' + esc(status) + "</span>";
  }

  // Countdown as HH:MM:SS, zero-padded. Returns "Expired" once the deadline has passed.
  function formatCountdown(ms) {
    if (ms <= 0) return "Expired";
    var secs = Math.floor(ms / 1000);
    var hours = Math.floor(secs / 3600);
    var mins = Math.floor((secs % 3600) / 60);
    return pad(hours) + ":" + pad(mins) + ":" + pad(secs % 60);
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
    if (idx === 1 && b.rider) {
      var vehicle = b.vehicle || riderVehicle(b.rider);
      return "Rider: " + esc(b.rider) + phoneSpan(riderPhone(b.rider)) + " \u2022 " + esc(vehicle) +
        " \u2022 ETA " + esc(etaFor(b)) + " min";
    }
    if (idx === 2) {
      var at = b.collectedAt || eventAt(b, "Collected");
      return at ? "Picked up " + esc(hhmm(at)) : "";
    }
    if (idx === 3) {
      return "Delivered \u2022 +" + esc(creditsFor(b)) + " impact credits";
    }
    return "";
  }

  // Stage index for the progress bar: Posted=0, Claimed/Assigned=1, Collected/Picked Up/In Transit=2,
  // Delivered=3. Expired (and any unmapped status) gives -1, so no step is done or current.
  var STAGE_INDEX = { Posted: 0, Assigned: 1, Claimed: 1, "Picked Up": 2, Collected: 2, "In Transit": 2, Delivered: 3 };
  function stageIndexOf(b) {
    return Object.prototype.hasOwnProperty.call(STAGE_INDEX, b.status) ? STAGE_INDEX[b.status] : -1;
  }

  // Four progress bars with the stage label under each, then the stage-detail line.
  function trackerHtml(b) {
    var idx = stageIndexOf(b);
    var steps = STAGES.map(function (name, i) {
      var cls = idx === -1 ? "" : (i < idx ? " done" : (i === idx ? " current" : ""));
      return '<div class="progress-step' + cls + '"><span>' + esc(name) + "</span></div>";
    }).join("");
    var detail = stageDetailHtml(b, idx);
    return '<div class="progress-steps" aria-label="Pickup stages">' + steps + "</div>" +
      (detail ? '<p class="step-detail">' + detail + "</p>" : "");
  }

  // Radar scale: the 10 km ring sits at RADAR_MAX_PX from the centre (fits the 200 viewBox).
  var RADAR_RINGS_KM = [2, 5, 10];
  var RADAR_MAX_PX = 78;
  function radarPx(km) {
    var px = (Number(km) || 0) * (RADAR_MAX_PX / 10);
    return Math.min(RADAR_MAX_PX, px);
  }

  // Compact SVG radar: donor at the centre, distance rings (2/5/10 km), NGO pins at
  // deterministic angles with short labels, a route line to the assigned NGO and a rider dot.
  function renderRadar(b) {
    var C = 100;
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var assignedPt = null;
    var out = '<svg class="radar" viewBox="0 0 200 200" role="img" aria-label="' +
      esc("Dispatch radar for " + b.id) + '">';

    RADAR_RINGS_KM.forEach(function (km) {
      var r = radarPx(km);
      out += '<circle class="radar-ring" cx="' + C + '" cy="' + C + '" r="' + r + '" fill="none"></circle>';
      // Ring label sits on the upper-right diagonal, just outside the ring.
      var lx = (C + (r + 2) * Math.cos(-Math.PI / 4)).toFixed(1);
      var ly = (C + (r + 2) * Math.sin(-Math.PI / 4)).toFixed(1);
      out += '<text class="radar-label radar-ring-label" x="' + lx + '" y="' + ly + '">' + km + " km</text>";
    });

    // Route line from donor centre to the assigned NGO (drawn before pins so pins sit on top).
    state.ngos.forEach(function (n, i) {
      if (ngo && ngo.id === n.id) {
        var ang0 = -Math.PI / 2 + (i * 2 * Math.PI) / state.ngos.length;
        var rr = radarPx(n.distance_km);
        assignedPt = { x: C + rr * Math.cos(ang0), y: C + rr * Math.sin(ang0) };
        out += '<line class="radar-route" x1="' + C + '" y1="' + C + '" x2="' + assignedPt.x.toFixed(1) +
          '" y2="' + assignedPt.y.toFixed(1) + '"></line>';
      }
    });

    state.ngos.forEach(function (n, i) {
      var ang = -Math.PI / 2 + (i * 2 * Math.PI) / state.ngos.length;
      var r = radarPx(n.distance_km);
      var x = (C + r * Math.cos(ang)).toFixed(1);
      var y = (C + r * Math.sin(ang)).toFixed(1);
      var assigned = !!ngo && ngo.id === n.id;
      var short = String(n.name).split(" ").slice(0, 2).join(" ");
      out += '<g class="ngo-pin' + (assigned ? " assigned" : "") + '"><title>' + esc(n.name) + "</title>" +
        '<circle cx="' + x + '" cy="' + y + '" r="7"></circle>' +
        '<text x="' + x + '" y="' + y + '" text-anchor="middle" dy="3">' + esc(n.name.charAt(0)) + "</text>" +
        '<text class="radar-label" x="' + x + '" y="' + (Number(y) - 10).toFixed(1) +
        '" text-anchor="middle">' + esc(short) + "</text></g>";
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

  // Listing card: .batch-card with a pastel tint; .card-header (category, id pill, countdown);
  // .card-body (dish, caterer, locality, kg, phone, progress, detail, radar, disclaimer); .card-actions footer.
  // actionHtml is trusted markup built by this file (ids are escaped).
  function cardHtml(b, now, actionHtml) {
    var ngo = b.ngoId ? ngoById(b.ngoId) : null;
    var isVeg = b.diet === "Veg";
    // Pastel tint by category; Expired batches get the blush tint.
    var tint = b.status === "Expired" ? "tint-blush" : (isVeg ? "tint-mint" : "tint-cream");
    var icon = isVeg ? "\uD83E\uDD57" : "\uD83C\uDF57"; // salad / poultry emoji
    var html = '<article class="batch-card ' + tint + '">';
    html += '<div class="card-header">' +
      '<span class="category-badge ' + (isVeg ? "veg" : "nonveg") + '" aria-label="' +
      (isVeg ? "Veg" : "Non-Veg") + '">' + icon + "</span>" +
      '<div class="card-header-right"><span class="batch-id-pill">' + esc(b.id) + "</span>" +
      urgencyHtml(b, now) + "</div>" +
      "</div>";
    html += '<div class="card-body">';
    html += "<h3>" + esc(b.food) + "</h3>";
    html += badgeHtml(b.status);
    html += '<p class="meta">Caterer: ' + esc(b.caterer) + phoneSpan(b.catererPhone) + "</p>";
    html += '<p class="meta">' + esc(b.locality) + " · " + esc(b.diet) + " · " + esc(b.servings) +
      " servings · " + fmtNum(b.kg) + " kg</p>";
    html += '<p class="meta">Prepared ' + fmtTime(b.preparedAt) + " · Expires " + fmtTime(b.expiresAt) + "</p>";
    if (ngo) {
      html += '<p class="meta">NGO: ' + esc(ngo.name) + phoneSpan(ngo.phone) + "</p>";
    }
    if (b.dispatchNote) html += '<p class="warn">' + esc(b.dispatchNote) + "</p>";
    html += trackerHtml(b);
    html += '<div class="radar-wrap">' + renderRadar(b) + "</div>";
    html += '<p class="disclaimer">' + esc(D.DISCLAIMER) + "</p>";
    html += "</div>";
    html += '<div class="card-actions">' + cardFooterHtml(b, actionHtml) + "</div>";
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
    if (footer) return footer;
    if (b.status === "Delivered") {
      return '<p class="card-status">' + esc("Delivered \u2022 +" + creditsFor(b) + " impact credits") + "</p>";
    }
    if (b.status === "Expired") {
      return '<p class="card-status">' + esc("Expired \u2014 Do Not Distribute") + "</p>";
    }
    return '<p class="card-status">' + esc(b.status) + "</p>";
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

    var posted = state.batches.filter(function (b) { return b.status === "Posted" && passesDispatchFilter(b, now); })
      .sort(function (a, b) { return a.expiresAt - b.expiresAt; });
    $("feed-posted").innerHTML = posted.length ? posted.map(function (b) {
      return cardHtml(b, now, feedActionsHtml(b));
    }).join("") : '<p class="empty">No open batches right now.</p>';

    var active = state.batches.filter(function (b) { return b.status !== "Posted" && passesDispatchFilter(b, now); })
      .sort(function (a, b) { return b.preparedAt - a.preparedAt; });
    $("feed-active").innerHTML = active.length ? active.map(function (b) {
      return cardHtml(b, now, feedActionsHtml(b));
    }).join("") : '<p class="empty">No active rescues yet.</p>';
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
      return b.status !== "Delivered" && b.status !== "Expired";
    }).sort(function (a, b) { return (a.expiresAt - now) - (b.expiresAt - now); });
    if (!active.length) {
      list.innerHTML = '<p class="empty">No active batches</p>';
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

  function renderLedgerEvents() {
    var body = $("ledger-events-body");
    if (!body) return;
    var rows = ledgerRows();
    body.innerHTML = rows.length ? rows.map(function (r) {
      return "<tr>" +
        "<td>" + esc(hhmm(r.at)) + "</td>" +
        "<td>" + esc(r.batchId) + "</td>" +
        "<td>" + esc(r.caterer) + "</td>" +
        "<td>" + esc(r.event) + "</td>" +
        "<td>" + esc(r.ngo) + "</td>" +
        "<td>" + esc(r.rider) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="6">No events yet.</td></tr>';
  }

  // Horizontal bars: rescued kg (Delivered batches) split Veg vs Non-Veg.
  function renderCategoryBars() {
    var el = $("category-bars");
    if (!el) return;
    var kg = { Veg: 0, "Non-Veg": 0 };
    state.batches.forEach(function (b) {
      if (b.status === "Delivered" && kg.hasOwnProperty(b.diet)) kg[b.diet] += Number(b.kg) || 0;
    });
    var total = kg.Veg + kg["Non-Veg"];
    function row(label, cls, value) {
      var pct = total > 0 ? Math.round(100 * value / total) : 0;
      return '<div class="cat-bar-row"><span>' + esc(label) + " \u00B7 " + esc(fmtNum(value)) + " kg</span>" +
        '<div class="cat-bar-track"><span class="cat-bar-fill ' + cls + '" style="width: ' + pct +
        '%"></span></div></div>';
    }
    el.innerHTML = row("Veg", "veg", kg.Veg) + row("Non-Veg", "nonveg", kg["Non-Veg"]);
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
    renderCategoryBars();
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
      '<p class="hint">' + esc("Illustrative / synthetic. Operational sustainability report, not a tax-exemption certificate.") + "</p>" +
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
        "Illustrative assumption: \u20B9" + bmInt(RIDER_COST_PER_RESCUE_INR) + " rider cost per rescue + \u20B9" +
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
      "Batch-level CSV audit log behind every ESG summary (operational report, not a tax certificate)"],
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
      return "<tr><th>" + esc(row[0]) + "</th><td>" + esc(row[1]) + "</td><td>" + esc(row[2]) + "</td></tr>";
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

  // Restores the load-time seed without reloading the page.
  function resetDemoData() {
    if (!seedSnapshot) return;
    var delta = Date.now() - seedSnapshot.now;
    state.batches = JSON.parse(JSON.stringify(seedSnapshot.batches));
    state.batches.forEach(function (b) { shiftBatchTimes(b, delta); });
    state.ngos = JSON.parse(JSON.stringify(seedSnapshot.ngos));
    state.nextNum = seedSnapshot.nextNum;
    state.riderIdx = 0;
    state.feedMsg = "";
    state.catererFilter = "";
    state.overrides = {};

    var form = $("donate-form");
    if (form) form.reset();
    resetDonateForm();
    setTextIfPresent("donate-msg", "");

    hideHandling();
    populateCatererFilter();
    renderAll();
    startTicker();
    showResetMessage("Demo reset to seed data.");
  }

  // ---------- navigation & wiring ----------
  var renderers = {
    caterer: function () { renderCatererList(); },
    feed: function () { renderFeed(); },
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

  function renderAll() {
    populateEsgSelect();
    renderCatererList();
    renderWasteInsight();
    renderFeed();
    renderImpact();
    renderPulse();
    renderHeroStats();
    renderBusinessModel();
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
    ["caterer", "feed", "impact", "roi"].forEach(function (v) {
      var panel = $("view-" + v);
      if (panel) panel.classList.toggle("active", v === view);
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

  // ROI slider listeners are attached in initRoiTab() (called from init below).

  var resetBtn = $("reset-demo-btn");
  if (resetBtn) resetBtn.addEventListener("click", resetDemoData);

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
  takeSeedSnapshot();
  populateCatererFilter();
  initRoiTab();
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
