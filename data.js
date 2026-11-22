/* AnnaSetu synthetic seed data.
   All caterers, NGOs, riders, localities and phone numbers are FICTIONAL placeholders. */
(function (global) {
  "use strict";

  var MIN = 60 * 1000;

  var SAFE_HOURS_DEFAULT = 4;
  var CSR_RESCUE_RATE = 40;
  var CSR_MONTHLY_PACK = 12000;
  var SAAS_MONTHLY_FEE = 1999;
  var PRIORITY_NGO_COUNT = 6;

  var DISCLAIMER =
    "Disclaimer: AnnaSetu is a logistics coordination platform only. We do not inspect, test, or certify food safety, nor do we guarantee tax deductions or legal exemptions. Receivers must verify food condition upon pickup.";

  // Approximate area centres, used as PLACEHOLDER coordinates only.
  var LOCALITIES = {
    "Madhapur": { lat: 17.4483, lng: 78.3915 },
    "Gachibowli": { lat: 17.4401, lng: 78.3489 },
    "Kondapur": { lat: 17.4611, lng: 78.3564 },
    "Jubilee Hills": { lat: 17.4326, lng: 78.4071 },
    "Hitech City": { lat: 17.4435, lng: 78.3772 },
    "Banjara Hills": { lat: 17.4126, lng: 78.4482 }
  };

  // Fictional NGOs. distance_km is measured from the sample caterer hub.
  var NGOS = [
    { id: "ngo-asha", name: "Asha Community Kitchen", locality: "Kondapur", pref: "Both", capacity: 300, distance_km: 3.2, phone: "+91-XXXXX-00001", dailyCapacityKg: 60, coldStorage: true, avgAcceptMins: 7, diet: "All", priorityAlert: false },
    { id: "ngo-annapurna", name: "Annapurna Seva Trust", locality: "Madhapur", pref: "Veg", capacity: 250, distance_km: 2.1, phone: "+91-XXXXX-00002", dailyCapacityKg: 50, coldStorage: true, avgAcceptMins: 6, diet: "Veg Only", priorityAlert: false },
    { id: "ngo-hope", name: "Hope Street Community Kitchen", locality: "Gachibowli", pref: "Non-Veg", capacity: 200, distance_km: 6.8, phone: "+91-XXXXX-00003", dailyCapacityKg: 40, coldStorage: false, avgAcceptMins: 11, diet: "All", priorityAlert: false },
    { id: "ngo-sahayam", name: "Sahayam Food Bank", locality: "Jubilee Hills", pref: "Both", capacity: 350, distance_km: 9.4, phone: "+91-XXXXX-00004", dailyCapacityKg: 70, coldStorage: true, avgAcceptMins: 13, diet: "All", priorityAlert: false },
    { id: "ngo-karuna", name: "Karuna Shelter & Elder Care", locality: "Hitech City", pref: "Veg", capacity: 180, distance_km: 4.1, phone: "+91-XXXXX-00005", dailyCapacityKg: 36, coldStorage: false, avgAcceptMins: 9, diet: "Veg Only", priorityAlert: false },
    { id: "ngo-nirmal", name: "Nirmal Jyoti Youth Home", locality: "Banjara Hills", pref: "Both", capacity: 260, distance_km: 5.6, phone: "+91-XXXXX-00006", dailyCapacityKg: 52, coldStorage: false, avgAcceptMins: 12, diet: "All", priorityAlert: false }
  ];

  // Fictional riders. Each entry is an object: { name, phone }.
  var RIDERS = [
    { name: "Rider R-07", phone: "+91-XXXXX-00001" },
    { name: "Rider R-03", phone: "+91-XXXXX-00002" },
    { name: "Rider R-11", phone: "+91-XXXXX-00003" },
    { name: "Rider R-14", phone: "+91-XXXXX-00004" },
    { name: "Rider R-02", phone: "+91-XXXXX-00005" },
    { name: "Rider R-19", phone: "+91-XXXXX-00006" }
  ];

  // Rider whose name contains "R-07"; falls back to RIDERS[0] if absent.
  var R07_RIDER = (RIDERS.filter(function (r) { return r.name.indexOf("R-07") !== -1; })[0] || RIDERS[0]).name;

  // Fictional food presets for the caterer form.
  var FOOD_PRESETS = [
    "Veg Biryani & Salan",
    "Chicken Dum Biryani & Raita",
    "Dal Tadka & Jeera Rice",
    "Paneer Butter Masala & Naan",
    "South Indian Tiffin (Idli/Sambar)",
    "Mutton Haleem & Bread",
    "Curd Rice & Lemon Rice Combo",
    "Custom"
  ];

  function placed(o) {
    var loc = LOCALITIES[o.locality];
    o.lat = loc.lat;
    o.lng = loc.lng;
    return o;
  }

  // One batch per lifecycle stage, timestamps relative to `now`.
  function buildSeedBatches(now) {
    function ev(type, at) {
      return { type: type, at: at };
    }
    var list = [
      placed({
        id: "AS-1001", caterer: { name: "Deccan Royal Caterers", phone: "+91-XXXXX-00001" }, locality: "Madhapur",
        food: "Chicken biryani with raita", diet: "Non-Veg", servings: 120, kg: 40,
        preparedAt: now - 95 * MIN, expiresAt: now + 30 * MIN,
        ngoId: null, rider: null, claimedAt: null, status: "Posted",
        events: [ev("Posted", now - 95 * MIN)]
      }),
      placed({
        id: "AS-1002", caterer: { name: "Saffron Feast Events", phone: "+91-XXXXX-00002" }, locality: "Gachibowli",
        food: "Veg thali (dal, paneer, rice, roti)", diet: "Veg", servings: 150, kg: 55,
        preparedAt: now - 150 * MIN, expiresAt: now + 170 * MIN,
        ngoId: "ngo-annapurna", rider: RIDERS[0].name, claimedAt: now - 40 * MIN, status: "Claimed",
        events: [ev("Posted", now - 150 * MIN), ev("Claimed", now - 40 * MIN)]
      }),
      placed({
        id: "AS-1003", caterer: { name: "Lakeview Wedding Kitchens", phone: "+91-XXXXX-00003" }, locality: "Jubilee Hills",
        food: "Vegetable pulao with sweet boxes", diet: "Veg", servings: 100, kg: 30,
        preparedAt: now - 200 * MIN, expiresAt: now + 90 * MIN,
        ngoId: "ngo-asha", rider: RIDERS[1].name, claimedAt: now - 70 * MIN, status: "Collected",
        events: [ev("Posted", now - 200 * MIN), ev("Claimed", now - 70 * MIN), ev("Collected", now - 25 * MIN)]
      }),
      placed({
        id: "AS-1004", caterer: { name: "Kondapur Celebrations Co.", phone: "+91-XXXXX-00004" }, locality: "Kondapur",
        food: "Mixed dessert boxes", diet: "Veg", servings: 80, kg: 12,
        preparedAt: now - 300 * MIN, expiresAt: now + 120 * MIN,
        ngoId: "ngo-sahayam", rider: RIDERS[2].name, claimedAt: now - 200 * MIN, status: "Delivered",
        events: [
          ev("Posted", now - 300 * MIN),
          ev("Claimed", now - 200 * MIN),
          ev("Collected", now - 150 * MIN),
          ev("Delivered", now - 120 * MIN)
        ]
      }),
      placed({
        id: "AS-1005", caterer: { name: "Banjara Banquet Caterers", phone: "+91-XXXXX-00005" }, locality: "Gachibowli",
        food: "Hyderabadi Chicken Haleem & Naan", diet: "Non-Veg", servings: 110, kg: 25,
        preparedAt: now - 360 * MIN, expiresAt: now - 180 * MIN,
        ngoId: "ngo-hope", rider: RIDERS[3].name, claimedAt: now - 260 * MIN, status: "Delivered",
        events: [
          ev("Posted", now - 360 * MIN),
          ev("Claimed", now - 260 * MIN),
          ev("Collected", now - 230 * MIN),
          ev("Delivered", now - 200 * MIN)
        ]
      }),
      placed({
        id: "AS-1006", caterer: { name: "Hitech Corporate Kitchens", phone: "+91-XXXXX-00006" }, locality: "Hitech City",
        food: "Paneer Butter Masala & Naan", diet: "Veg", servings: 90, kg: 36,
        storage: "Hot-held", allergens: ["Dairy"], packaging: "Sealed Foil Trays",
        preparedAt: now - 40 * MIN, expiresAt: now + 35 * MIN,
        ngoId: null, rider: null, claimedAt: null, status: "Posted",
        events: [ev("Posted", now - 40 * MIN)]
      }),
      placed({
        id: "AS-1007", caterer: { name: "Royal Nizam Banquets", phone: "+91-XXXXX-00007" }, locality: "Banjara Hills",
        food: "Mutton Haleem & Bread", diet: "Non-Veg", servings: 140, kg: 56,
        storage: "Hot-held", allergens: ["Gluten"], packaging: "Bulk Vessels (Bring Containers)",
        preparedAt: now - 80 * MIN, expiresAt: now + 110 * MIN,
        ngoId: "ngo-nirmal", rider: RIDERS[4].name, claimedAt: now - 15 * MIN, status: "Claimed",
        events: [ev("Posted", now - 80 * MIN), ev("Claimed", now - 15 * MIN)]
      }),
      placed({
        id: "AS-1008", caterer: { name: "Gachibowli TechPark Events", phone: "+91-XXXXX-00008" }, locality: "Gachibowli",
        food: "South Indian Tiffin (Idli/Sambar)", diet: "Veg", servings: 75, kg: 30,
        storage: "Room Temp", allergens: [], packaging: "Sealed Foil Trays",
        preparedAt: now - 260 * MIN, expiresAt: now - 20 * MIN,
        ngoId: null, rider: null, claimedAt: null, status: "Expired", locked: true,
        events: [ev("Posted", now - 260 * MIN)]
      }),
      placed({
        id: "AS-1009", caterer: { name: "Vanguard Wedding Caterers", phone: "+91-XXXXX-00001" }, catererPhone: "+91-XXXXX-00001",
        locality: "Kondapur",
        food: "Chicken Dum Biryani & Raita", diet: "Non-Veg", servings: 160, kg: 64,
        storage: "Hot-held", allergens: ["Dairy"], packaging: "Bulk Vessels (Bring Containers)",
        preparedAt: now - 90 * MIN, expiresAt: now + 90 * MIN,
        ngoId: "ngo-hope", rider: R07_RIDER, claimedAt: now - 10 * MIN, status: "Claimed",
        events: [ev("Posted", now - 90 * MIN), ev("Claimed", now - 10 * MIN)]
      }),
      placed({
        id: "AS-1010", caterer: { name: "Kondapur Family Caterers", phone: "+91-XXXXX-00002" }, catererPhone: "+91-XXXXX-00002",
        locality: "Kondapur",
        food: "Veg Biryani & Salan", diet: "Veg", servings: 90, kg: 36,
        storage: "Hot-held", allergens: [], packaging: "Sealed Foil Trays",
        preparedAt: now - 120 * MIN, expiresAt: now + 60 * MIN,
        ngoId: "ngo-asha", rider: R07_RIDER, claimedAt: now - 25 * MIN, collectedAt: now - 8 * MIN, status: "Collected",
        events: [ev("Posted", now - 120 * MIN), ev("Claimed", now - 25 * MIN), ev("Collected", now - 8 * MIN)]
      })
    ];
    return list.map(function (o) {
      if (o.cookedHoursAgo === undefined) {
        o.cookedHoursAgo = Math.round(((now - o.preparedAt) / 3600000) * 10) / 10;
      }
      if (o.safeHours === undefined) o.safeHours = SAFE_HOURS_DEFAULT;
      if (o.allergens === undefined) o.allergens = [];
      if (o.packaging === undefined) o.packaging = "Sealed Foil Trays";
      if (o.storage === undefined) o.storage = "Hot-held";
      return o;
    });
  }

  global.AnnaSetuData = {
    DISCLAIMER: DISCLAIMER,
    LOCALITIES: LOCALITIES,
    NGOS: NGOS,
    RIDERS: RIDERS,
    FOOD_PRESETS: FOOD_PRESETS,
    CO2_FACTOR: 2.5,
    SAFE_HOURS_DEFAULT: SAFE_HOURS_DEFAULT,
    CSR_RESCUE_RATE: CSR_RESCUE_RATE,
    CSR_MONTHLY_PACK: CSR_MONTHLY_PACK,
    SAAS_MONTHLY_FEE: SAAS_MONTHLY_FEE,
    PRIORITY_NGO_COUNT: PRIORITY_NGO_COUNT,
    buildSeedBatches: buildSeedBatches
  };
})(window);
