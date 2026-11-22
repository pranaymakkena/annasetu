<p align="center">
  <img src="AnnaSetuLogo.png" alt="AnnaSetu Logo" width="220" />
</p>
<p align="center"><a href="https://projectannasetu.vercel.app"><strong>Live demo: projectannasetu.vercel.app</strong></a></p>

# AnnaSetu

**AnnaSetu** — Hyperlocal Surplus-to-Shelter Food Rescue Bridge (Hyderabad)

AnnaSetu is a static, single-page prototype that lets caterers post surplus cooked food, matches it to nearby NGO kitchens and shelters, and tracks the pickup through four stages to delivery. It also keeps an impact ledger and a unit-economics simulator. All data is synthetic.

---

## Hackathon & Team

| Field | Details |
|---|---|
| Event | CodeBenders ACE Builders' Hackathon 2026 |
| Problem Statement | Problem Statement 2 \| Society and Environment — Rescue the Surplus |
| Team Name | Smash Buggers |
| Team Leader | Pranay Makkena |
| Team Member | Shwethan Kumar Anumalla |

---

## Problem Statement & Hyperlocal Focus

Wedding and event caterers in Hyderabad generate large volumes of surplus cooked food after events. AnnaSetu bridges that surplus to nearby shelters and NGO kitchens, with riders assigned for pickup.

The prototype is scoped to six Hyderabad localities that appear in `data.js`:

- Madhapur
- Gachibowli
- Kondapur
- Jubilee Hills
- Hitech City
- Banjara Hills

Each locality is stored with placeholder area-centre coordinates. Distances to NGOs are fixed values in the seed data (`distance_km`), not live map routing.

**Seed NGOs (6, fictional):**

| ID | Name | Locality |
|---|---|---|
| `ngo-asha` | Asha Community Kitchen | Kondapur |
| `ngo-annapurna` | Annapurna Seva Trust | Madhapur |
| `ngo-hope` | Hope Street Community Kitchen | Gachibowli |
| `ngo-sahayam` | Sahayam Food Bank | Jubilee Hills |
| `ngo-karuna` | Karuna Shelter & Elder Care | Hitech City |
| `ngo-nirmal` | Nirmal Jyoti Youth Home | Banjara Hills |

NGO phone numbers use the placeholders `+91-XXXXX-00001` to `+91-XXXXX-00006`.

**Seed batches:** eight batches, `AS-1001` to `AS-1008`, cover the Posted, Claimed, Collected, Delivered and Expired states, with both Veg and Non-Veg food. `AS-1008` is kept as the Expired example.

**Food presets:** the caterer form offers eight presets, from *Veg Biryani & Salan* through *Custom*. They match `FOOD_PRESETS` in `data.js`.

---

## Key Features

1. **Caterer donation intake (donate form)**
   - Mandatory *Time Cooked* selection. Food cooked more than **4 hours** ago is rejected with the message "Food cooked more than 4 hours ago cannot be posted."
   - Required storage tags: *Hot-held (>60°C)*, *Room Temp*, *Chilled (<5°C)*.
   - Required allergen tags: Dairy, Nuts, Gluten, Soy, or None.
   - Required packaging: *Sealed Foil Trays* or *Bulk Vessels (Bring Containers)*.
   - Effective deadline is the earlier of the chosen pickup window and 4 hours after cooking.
   - The button `#btn-autofill-wedding` ("Auto-Fill Sample Wedding Surplus (15s Demo)") fills every field with a sample batch and posts it in one click.
   - The "sub-60-second" intake time is a design goal; the code does not measure it.

2. **Smart matching and dispatch radar**
   - Match score (0–100) = 40% distance + 35% capacity fit + 25% diet fit, combined as a weighted sum and rounded:
     - Distance: `max(0, 1 − km / 15)`.
     - Capacity fit: `min(1, remaining servings ÷ batch meals)`.
     - Diet fit: exact match = 1.0, NGO accepts "Both" = 0.8, otherwise 0 (ineligible).
   - *Claim Batch (Smart Match)* assigns the top-ranked NGO that has room for the whole batch.
   - *Manual NGO Override* lets you pick an NGO; the code still checks diet compatibility and remaining capacity.
   - Each card shows an SVG radar with rings at **2, 5 and 10 km**, six NGO pins at fixed slots, and a route line and rider marker for assigned batches.
   - The radar is redrawn on each view render. Countdowns update every second; the radar itself is not animated by the ticker.
   - **Smart Match factor breakdown:** the top 3 NGOs are listed with bars for Distance (40%), Capacity fit (35%) and Diet fit (25%). These sub-scores are recomputed with the same expressions as the scorer.

3. **Four-stage pickup state machine**
   - Stages: **Posted → Claimed → Collected → Delivered**.
   - Posted → Claimed: assigns a rider from a round-robin list (`Rider R-07`, `R-03`, …) and sets an ETA at 0.25 km/min (minimum 5 min).
   - Claimed → Collected: requires the checkbox *"Core temp checked ≥ 60°C or chilled ≤ 5°C"*. This is a **self-attested checkbox**; no sensor or temperature value is recorded.
   - Collected → Delivered: records delivery and credits 1 impact credit per kg.
   - **Expiry lock:** any open batch (Posted, Claimed or Collected) whose deadline passes becomes *Expired*, is flagged "Do Not Distribute", and can no longer be claimed or moved.

4. **Impact and ESG ledger**
   - Meals = kg ÷ **0.4 kg per meal**.
   - CO2e = kg × **2.5** (a constant named `CO2_FACTOR` in `app.js`). The code has no source for it. The on-page methodology text cites "FAO/UNEP food waste emission benchmarks," but this is not verified in the code. Treat it as an **assumed factor**.
   - Value saved = meals × ₹65 (`MEAL_VALUE_INR`).
   - *Download CSV Audit Log* (`#btn-download-csv`) exports the ledger.
   - *Generate Monthly ESG Summary* (`#esg-generate-btn`) builds a per-caterer summary for the current calendar month, and *Print / Save as PDF* (`#esg-print-btn`) opens the browser print dialog with a print-only layout.
   - Expired batches are excluded from ledger totals.

5. **Notifications and live demo**
   - Toast notifications (`#toast-container`) appear for publish, claim, temperature check, delivery and expiry lock, and auto-dismiss after 3.5 s.
   - *Simulate Live Rescue* (`#btn-simulate-rescue`, in the hero) walks an open batch through Claimed, Collected and Delivered, one step every 1.8 s.

6. **Commercial viability and unit-economics simulator**
   - Tier 1: Caterer SaaS at **₹1,999/month** (`SUBSCRIPTION_INR`). The "7.5x" figure is the default output of the simulator: ₹150,000 raw spend × 10% savings ÷ ₹1,999 ≈ 7.5x. Changing the inputs changes it.
   - Tier 2: Corporate CSR logistics credits at **₹40 per rescue** (`TIER2_PER_RESCUE_INR`). The **₹12,000/month CSR pack** appears as text in the monetisation cards only; it is not calculated.
   - Convention and hotel compliance tier at **₹9,999/month** appears in the monetisation cards only. The "Tier 3" pillar card on the same page says "Custom annual contract."
   - Simulator inputs: active caterers, rescues per caterer, kg per rescue, waste-reduction %, raw spend, and CSR share.
   - Cost per meal uses illustrative assumptions (rider cost ₹30 per rescue, platform fixed cost ₹6,000/month) and is labelled as such.

---

## Safety, Legal & Synthetic Data Guardrails

- AnnaSetu facilitates **logistics coordination only**. It does not inspect, test, or certify food safety, and it does not guarantee tax deductions or legal exemptions. The disclaimer is shown on every card and in the handling guide.
- Receivers are told to check smell and temperature before serving, reject food that is off-smell or outside the safe range, and consume within 1 hour of delivery.
- All caterers, NGOs, riders, localities and coordinates are **fictional placeholders**.
- Phone numbers use the placeholder format `+91-XXXXX-000NN`: NGOs `00001`–`00006`, riders `00001`–`00006`, and seed caterers `00001`–`00004`. They are not real numbers.

---

## Demo Role Login

The header has a role select, `#role-select`, with four synthetic personas. **There is no real login or password.** Choosing a persona only switches the view:

| Persona | Organisation | Opens |
|---|---|---|---|
| Ramesh K. | Deccan Royal Caterers | Caterer Portal |
| Meera S. | Annapurna Seva NGO | Live Dispatch |
| Arjun V. | EV Rider R-07 | Live Dispatch, with the In Transit filter |
| Vikram R. | TechPark CSR Sponsor | Business & ROI |

---

## Tech Stack

- Zero-dependency HTML5, CSS3 and vanilla JavaScript.
- No build step, no backend, no package manager (no `package.json`).
- State is saved in the browser's `localStorage` under the key `annasetu_db_v1`. A reset clears it.
- When a saved state is more than 15 minutes old, batch timestamps are shifted forward on load so demo batches do not expire during judging. `AS-1008` and Expired batches are excluded from this shift.

---

## Quick Start

**Option A — open directly**

1. Open `index.html` in a modern browser.

**Option B — serve locally with any static server**

```bash
python -m http.server 8000
```

Then visit <http://localhost:8000>.

Both options are available. Neither was tested in this environment.

---

## Project Structure

```
AnnaSetu/
├── index.html         Page markup: header, sidebar nav, donate form, dispatch feed, caterer view, impact/ESG and ROI sections, handling-guide modal
├── styles.css         All styling: colour tokens, dashboard shell, cards, radar, responsive breakpoints, print layout
├── app.js             Application logic: in-memory state, matching, pickup state machine, expiry lock, rendering, CSV/ESG/ROI
├── data.js            Synthetic seed data: localities, NGOs, riders, seed batches, disclaimer text
└── AnnaSetuLogo.png   Logo referenced by the header <img class="brand-logo">
```

---

## Responsive Behaviour

Breakpoints are taken from `styles.css`:

- **Desktop, `@media (min-width: 1025px)`:** three columns — sidebar (220px), workspace (`minmax(0, 1fr)`), and sticky queue rail (300px) on the right.
- **Tablet, `@media (min-width: 641px) and (max-width: 1024px)`:** the sidebar becomes a horizontal, scrollable top pill nav; the queue rail sits below the main column; the batch and NGO lists use two columns.
- **Mobile, `@media (max-width: 640px)`:** single column; compact nav with 44px minimum touch targets on nav items only; full-width buttons; table wrappers scroll horizontally.
- Touch targets: on mobile, the 44px minimum applies to nav items only. Other controls (chips, tags, buttons, the temperature checkbox row) set `min-height: 44px` per component, not as a global rule.

---

## Limitations & Next Steps

- **All data is synthetic.** Caterers, NGOs, riders, phone numbers, coordinates and distances are placeholders.
- **Browser-only persistence.** State lives in `localStorage` (`annasetu_db_v1`) on one browser. There is no server-side storage.
- **No authentication.** The demo role select is not a login. Anyone using the page can switch to any persona.
- **No real routing or maps.** Distances are fixed seed values; the radar is a schematic.
- **No payments.** Subscription and CSR figures are illustrative calculations.
- **Food safety is not certified.** Temperature verification is a self-attested checkbox.
- **Possible next steps:** a backend with persistent storage and accounts, real geocoding and routing, sensor- or log-based temperature capture, and an audited methodology for the CO2 factor.

### Known limitations

- The ROI result cards that sat in a removed duplicate block are gone. The 6-card KPI grid remains.
- The Smart Match factor sub-scores are recomputed with the same expressions as the scorer. They are not stored separately.
- Nothing has been verified in a browser.
- The Lucide icons load from unpkg and need network access.

---

## License

Hackathon prototype — license to be decided by the team.
