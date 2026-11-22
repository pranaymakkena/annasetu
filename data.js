/* AnnaSetu synthetic seed data.
   All caterers, NGOs, riders, localities and phone numbers are FICTIONAL placeholders. */
(function (global) {
  "use strict";

  var MIN = 60 * 1000;

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
    { id: "ngo-asha", name: "Asha Community Kitchen", locality: "Kondapur", pref: "Both", capacity: 300, distance_km: 3.2, phone: "+91-XXXXX-00001" },
    { id: "ngo-annapurna", name: "Annapurna Seva Trust", locality: "Madhapur", pref: "Veg", capacity: 250, distance_km: 2.1, phone: "+91-XXXXX-00002" },
    { id: "ngo-hope", name: "Hope Street Community Kitchen", locality: "Gachibowli", pref: "Non-Veg", capacity: 200, distance_km: 6.8, phone: "+91-XXXXX-00003" },
    { id: "ngo-sahayam", name: "Sahayam Food Bank", locality: "Jubilee Hills", pref: "Both", capacity: 350, distance_km: 9.4, phone: "+91-XXXXX-00004" },
    { id: "ngo-karuna", name: "Karuna Shelter & Elder Care", locality: "Hitech City", pref: "Veg", capacity: 180, distance_km: 4.1, phone: "+91-XXXXX-00005" },
    { id: "ngo-nirmal", name: "Nirmal Jyoti Youth Home", locality: "Banjara Hills", pref: "Both", capacity: 260, distance_km: 5.6, phone: "+91-XXXXX-00006" }
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
    return [
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
      })
    ];
  }

  global.AnnaSetuData = {
    DISCLAIMER: DISCLAIMER,
    LOCALITIES: LOCALITIES,
    NGOS: NGOS,
    RIDERS: RIDERS,
    FOOD_PRESETS: FOOD_PRESETS,
    CO2_FACTOR: 2.5,
    buildSeedBatches: buildSeedBatches
  };
})(window);
