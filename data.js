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
    "Jubilee Hills": { lat: 17.4326, lng: 78.4071 }
  };

  // Fictional NGOs. distance_km is measured from the sample caterer hub.
  var NGOS = [
    { id: "ngo-asha", name: "Asha Community Kitchen", locality: "Kondapur", pref: "Both", capacity: 300, distance_km: 3.2 },
    { id: "ngo-annapurna", name: "Annapurna Seva Trust", locality: "Madhapur", pref: "Veg", capacity: 250, distance_km: 2.1 },
    { id: "ngo-hope", name: "Hope Street Community Kitchen", locality: "Gachibowli", pref: "Non-Veg", capacity: 200, distance_km: 6.8 },
    { id: "ngo-sahayam", name: "Sahayam Food Bank", locality: "Jubilee Hills", pref: "Both", capacity: 350, distance_km: 9.4 }
  ];

  // Fictional rider IDs.
  var RIDERS = ["Rider R-07", "Rider R-03", "Rider R-11", "Rider R-14", "Rider R-02", "Rider R-19"];

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
        id: "AS-1001", caterer: "Deccan Royal Caterers", locality: "Madhapur",
        food: "Chicken biryani with raita", diet: "Non-Veg", servings: 120, kg: 40,
        preparedAt: now - 95 * MIN, expiresAt: now + 30 * MIN,
        ngoId: null, rider: null, claimedAt: null, status: "Posted",
        events: [ev("Posted", now - 95 * MIN)]
      }),
      placed({
        id: "AS-1002", caterer: "Saffron Feast Events", locality: "Gachibowli",
        food: "Veg thali (dal, paneer, rice, roti)", diet: "Veg", servings: 150, kg: 55,
        preparedAt: now - 150 * MIN, expiresAt: now + 170 * MIN,
        ngoId: "ngo-annapurna", rider: RIDERS[0], claimedAt: now - 40 * MIN, status: "Claimed",
        events: [ev("Posted", now - 150 * MIN), ev("Claimed", now - 40 * MIN)]
      }),
      placed({
        id: "AS-1003", caterer: "Lakeview Wedding Kitchens", locality: "Jubilee Hills",
        food: "Vegetable pulao with sweet boxes", diet: "Veg", servings: 100, kg: 30,
        preparedAt: now - 200 * MIN, expiresAt: now + 90 * MIN,
        ngoId: "ngo-asha", rider: RIDERS[1], claimedAt: now - 70 * MIN, status: "Collected",
        events: [ev("Posted", now - 200 * MIN), ev("Claimed", now - 70 * MIN), ev("Collected", now - 25 * MIN)]
      }),
      placed({
        id: "AS-1004", caterer: "Kondapur Celebrations Co.", locality: "Kondapur",
        food: "Mixed dessert boxes", diet: "Veg", servings: 80, kg: 12,
        preparedAt: now - 300 * MIN, expiresAt: now + 120 * MIN,
        ngoId: "ngo-sahayam", rider: RIDERS[2], claimedAt: now - 200 * MIN, status: "Delivered",
        events: [
          ev("Posted", now - 300 * MIN),
          ev("Claimed", now - 200 * MIN),
          ev("Collected", now - 150 * MIN),
          ev("Delivered", now - 120 * MIN)
        ]
      })
    ];
  }

  global.AnnaSetuData = {
    DISCLAIMER: DISCLAIMER,
    LOCALITIES: LOCALITIES,
    NGOS: NGOS,
    RIDERS: RIDERS,
    CO2_FACTOR: 2.5,
    buildSeedBatches: buildSeedBatches
  };
})(window);
