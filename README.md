# Find the flat that fits: Sheffield

A free, open-source map for finding **where to rent in Sheffield**. Set your budget and must-haves, say what matters to you, and it ranks 19 neighbourhoods. Then you can jump straight to live listings on SpareRoom, OpenRent and Zoopla with your filters already applied.

**Live site:** https://nithinyadavg.github.io/sheffield-flat-finder/

Built for people moving to Sheffield for work or study who don't know the city yet.

## What it does

- **Room in a share or studio/1-bed**, with a monthly budget slider
- **Must-haves:** en-suite, bills included, female-only household, parking
- **What matters:** buses and trams, shops, gyms, quiet (fewer students), fewer crime reports, train station, M1, distance to work
- **Work postcode:** ranks areas by distance to work and links to the public-transport route
- **Live map layers:** every bus stop, tram stop, supermarket, pharmacy and gym in Sheffield, plus street-level crime reports
- **One-tap live listings:** each area opens SpareRoom, OpenRent and Zoopla searches with your budget and filters
- **Shareable:** your settings are saved in the URL, so you can send someone your exact search

## Data sources

| Data | Source | Licence | Freshness |
|---|---|---|---|
| Bus stops, tram stops, shops, pharmacies, gyms | OpenStreetMap via the Overpass API | ODbL | Live (cached in your browser for 24 h) |
| Street-level crime | [data.police.uk](https://data.police.uk/docs/) | Open Government Licence v3 | Latest published month |
| Postcode lookup | [postcodes.io](https://postcodes.io) | OGL / free | Live |
| Map tiles | CARTO dark basemap, © OpenStreetMap contributors | | Live |
| Area notes and price ranges | `data/areas.json`, hand-compiled | MIT (this repo) | Nov 2026 snapshot |

**The price ranges are a rough guide, not live prices.** They were compiled in November 2026 from public listing snapshots and SpareRoom's Q3 2026 rental index. Always check the live listings. Crime counts cover a ~1.2 km² box around each area centre. Busy areas like the city centre always score worse, so compare similar areas.

This project does **not** scrape SpareRoom, Rightmove, Zoopla or OpenRent. Their terms don't allow it. Instead it builds search links that open their own sites.

## Run it locally

No build step and no API keys.

```bash
git clone https://github.com/nithinyadavg/sheffield-flat-finder.git
cd sheffield-flat-finder
python3 -m http.server 8000
# open http://localhost:8000
```

## Make one for your city

1. Fork the repo.
2. Edit `data/areas.json`: area names, postcode districts (outcodes), centre coordinates, price ranges and notes.
3. In `app.js`, change `CENTRE`, `BBOX`, `STATION` and `M1_JUNCTIONS` (your nearest motorway junctions).
4. Turn on GitHub Pages (Settings → Pages → deploy from `main`).

## Contributing

Corrections are very welcome, especially prices, areas we've missed, and local knowledge. Open an issue or a pull request that edits `data/areas.json`. Please say where your price information comes from.

## Tips for renting in Sheffield (England)

- Never pay a deposit before viewing in person or on a live video call.
- Landlords must check your **right to rent**: passport plus an eVisa share code.
- Deposits must be protected in a government scheme (capped at 5 weeks' rent for most lets).
- Since 1 May 2026 (Renters' Rights Act), most new private tenancies in England are rolling (periodic) rather than fixed-term.
- If you live alone, you get 25% off council tax. Check whether "bills included" covers council tax.

## Licence

MIT © 2026 Nithin Yadav Gopinath ([nithinyadavg](https://nithinyadavg.me)). Data from third parties stays under its own licence (see above).
