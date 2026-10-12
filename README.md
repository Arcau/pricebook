# Pricebook

A small, self-hosted, crowd-sourced grocery price book, built for Australia.

Scan a barcode, see the product, type the price you saw. Over time that builds an open
record of what things cost at which store, which is something Australia does not have:
the big supermarkets publish no open price data, and the existing open price databases
hold almost nothing for Australian stores.

**Status: early trial.** It is in use by a handful of people. Expect rough edges.

## How it works

- **Products** are looked up by barcode in [Open Food Facts](https://world.openfoodfacts.org/).
  If a barcode is unknown, the first person to scan it names it once.
- **Prices** are entered by people, against a store (chain, suburb, state) and a date,
  optionally marked as a special.
- **Typical price**: the median of the latest non-special price at each store.
- **Acceptance rule**: a product's first price is accepted as its baseline. After that a
  price counts straight away when it is between half and one and a half times the typical
  price (both limits can be changed). Anything outside that range is held, and stays out of
  the book and the export, until it has proof.
- **Proof** is a photo of the receipt (covers that person's prices for that store and day) or
  of the shelf price tag (covers one price). An admin confirms it. Optionally, a local vision
  model reads price tag photos and confirms a price when what it reads matches exactly.
- **Accounts**: the first account is the admin. Everyone else needs a single-use invite code.
- **Export**: every counted price can be downloaded as CSV, with no names in it.

## Running it

You need Docker and a reverse proxy that provides HTTPS (the camera scanner and the login
cookie both need it).

    git clone https://github.com/Arcau/pricebook.git && cd pricebook
    cp .env.example .env && chmod 600 .env      # then edit it
    mkdir -p data && sudo chown 1000:1000 data
    docker compose up -d --build

It listens on `127.0.0.1:3020`. Point your reverse proxy at that, open the site, and create
the first account straight away: whoever registers first becomes the admin.

The server is one file, `app/server.js`, and uses nothing beyond Node itself (its built-in
web server and SQLite). The web app in `app/public/` is plain HTML, CSS and JavaScript with
no build step. Data lives in `data/`: the database, receipt and price tag photos, and a daily
backup (14 kept).

## Hardening

The container runs read-only, as a non-root user, with every capability dropped, and the app
has no third-party dependencies. Two more things are worth doing when it faces the internet:

- **Fence the container off from your network.** By default a container can connect to
  anything its host can, including admin pages on your LAN. `deploy/egress-firewall.sh` adds
  host firewall rules so the Pricebook container can only answer its reverse proxy, reach the
  internet (for Open Food Facts) and, if you use it, your Ollama server.
- **Keep `data/` private** (`chmod 700 data`): it holds the database and the receipt photos.

An admin can switch an account off under More → People, which signs it out everywhere.

## Android app

`android/` holds a small Android app that wraps a Pricebook server and adds the phone's own
barcode scanner and camera. See [android/BUILD.md](android/BUILD.md). The site also works in
a browser and can be added to the home screen; in-page scanning needs a Chromium-based browser.

## Licences

- **Code**: [GNU Affero General Public License v3.0 or later](LICENSE). If you run a modified
  copy for other people, you must offer them your source; set `SOURCE_URL` so the app links to it.
- **Price data** contributed to an instance: [Open Database License 1.0](DATA-LICENSE-ODbL-1.0.txt).
  You are free to share and adapt it as long as you attribute it and keep derived databases
  under the same licence.
- **Product names and pictures** come from Open Food Facts, whose database is also under the
  ODbL and whose images are under CC BY-SA. Credit Open Food Facts when you reuse them.

## Contributing

Issues and pull requests are welcome. Please do not include real receipts, account details
or anything private in them. For a security problem, use GitHub's private vulnerability
reporting on this repository rather than a public issue.
