# Gridfinity Drawer Organizer

Plan, visualize, and export Gridfinity drawer organizer layouts for 3D printing. Uses community STL packs from MakerWorld — you download the STLs yourself, the tool handles everything else.

**What it does:**

1. Scans downloaded STL collections and generates normalized pack manifests
2. Computes optimal grid dimensions for your drawer
3. Matches items to purpose-built bins or open tubs from your catalog
4. Renders interactive HTML previews of the layout
5. Exports plate-arranged .3mf files ready for Bambu Studio
6. Generates PDF print checklists

Zero dependencies — pure Node.js (v18+).

## Quick Start

```sh
# 1. Download STL packs from MakerWorld (see Catalog below)
#    Put them in STLs/<collection-name>/

# 2. Register each pack (only needed once per collection)
node src/gridfinity-intake.js STLs/my-collection \
  --name "My Collection" \
  --source-url "https://makerworld.com/en/models/..." \
  --pack-id my-collection

# 3. Plan a drawer layout
node src/gridfinity-layout.js 500x400x80 --project kitchen

# 4. Place items
echo '{"drawer":{"width":500,"depth":400,"height":80},
  "items":[{"name":"knives","qty":1},{"name":"AA batteries","qty":1}],
  "reserved":[]}' | node src/gridfinity-fit.js --project kitchen --drawer 500x400x80

# 5. Preview
node src/gridfinity-render.js --project kitchen

# 6. Export for Bambu Studio
node src/gridfinity-export-3mf.js kitchen

# 7. Print checklist
node src/gridfinity-generate-pdf.js kitchen
```

## Pipeline

### Step 1 — Grid Analysis (`gridfinity-layout.js`)

Computes grid dimensions, available bin heights, baseplate tiling, and drawer placement options.

```sh
node src/gridfinity-layout.js <WxDxH in mm> [--project name]
```

Opens an HTML preview showing:
- Grid dimensions and remainder gaps
- Which bin heights fit (3U through max)
- Three drawer placement options (back-left, centered, back-right) with gap measurements
- Baseplate tiling requirements

### Step 2 — Item Placement (`gridfinity-fit.js`)

Matches items to bins from the catalog, places them on the grid, fills empty cells with open tubs.

```sh
echo '<input JSON>' | node src/gridfinity-fit.js --project name --drawer WxDxH
```

**Input JSON format:**

```json
{
  "drawer": {"width": 500, "depth": 400, "height": 80},
  "items": [
    {"name": "knives", "qty": 1},
    {"name": "AA batteries", "qty": 1},
    {"name": "pens", "qty": 1, "footprint": [1, 4]},
    {"name": "scissors", "qty": 1, "at": [0, 0]},
    {"name": "caliper", "qty": 1, "bin": "solo-bins-caliper"}
  ],
  "reserved": [
    {"x": 0, "y": 0, "w": 4, "h": 5, "label": "Notebook"}
  ]
}
```

**Item options:**
- `name` — fuzzy-matched against purpose-built bins in the catalog
- `bin` — use a specific bin ID (overrides fuzzy matching)
- `footprint` — request a specific grid footprint `[w, h]`
- `at` — pin to exact grid coordinates `[x, y]`
- `label` — custom display label
- `qty` — number of this item

### Step 3 — HTML Preview (`gridfinity-render.js`)

```sh
node src/gridfinity-render.js --project name
```

### Step 4 — 3MF Export (`gridfinity-export-3mf.js`)

Packs all STLs into plate-arranged .3mf files with Bambu Studio P1S print settings.

```sh
node src/gridfinity-export-3mf.js <project-name>
```

### Step 5 — PDF Checklist (`gridfinity-generate-pdf.js`)

```sh
node src/gridfinity-generate-pdf.js <project-name>
```

## Adding STL Packs

Download any Gridfinity bin collection from MakerWorld and register it:

```sh
# 1. Put STLs in STLs/<collection-name>/
# 2. Optionally add a pack-meta.json sidecar (see below)
# 3. Run intake
node src/gridfinity-intake.js STLs/<collection-name> \
  --name "Display Name" \
  --source-url "https://makerworld.com/en/models/..." \
  --pack-id slug-name
```

The intake tool:
- Parses filenames for grid dimensions (supports `WxLxH`, `WxL`, `DBTW` patterns)
- Measures each STL's bounding box to verify/derive dimensions
- Classifies bins as open-tub, purpose-built, compartmented, or baseplate
- Generates a pack manifest in `packs/<pack-id>.json`

### pack-meta.json

Optional sidecar file placed alongside the STLs for editorial metadata:

```json
{
  "name": "Display Name",
  "sourceUrl": "https://makerworld.com/...",
  "defaultType": "baseplate",
  "bins": {
    "Knives.stl": {"type": "purpose-built", "forItem": "knives", "category": "kitchen-utensils"},
    "2x3 Open.stl": {"type": "open-tub"}
  }
}
```

- `defaultType` — sets the type for all bins not listed individually
- `bins` — per-file overrides keyed by exact STL filename
- Fields: `type`, `forItem`, `category`, `notes`

## Included Packs

The `packs/` directory ships with 7 pre-built manifests (81 bins total). You still need to download the STLs yourself from the linked MakerWorld pages.

| Pack | Bins | Description | MakerWorld |
|------|------|-------------|------------|
| `dbtw-large-bins` | 18 | Open tubs, 1x5 through 5x6, 3U and 6U | [1044058](https://makerworld.com/en/models/1044058) |
| `kitchen-collection` | 13 | Utensil holders + open tubs | [876931](https://makerworld.com/en/models/876931) |
| `cable-organizer` | 3 | Short/long/thick cable holders | [883817](https://makerworld.com/en/models/883817) |
| `battery-trays` | 2 | AA and AAA battery trays | [797953](https://makerworld.com/en/models/797953) |
| `solo-bins` | 3 | Caliper, utility knife, bolt sizer | various |
| `multi-compartment` | 6 | 3x3 compartmented bins, 3U–8U | various |
| `simple-base` | 36 | Baseplates 1x1 through 6x6 | [700948](https://makerworld.com/en/models/700948) |

## Grid Rules

- **Grid unit:** 42mm
- **Base height:** 3.8mm
- **Height unit:** 7mm per U (e.g., 3U = 24.8mm total)
- **Baseplate height:** 5mm
- **Clearance:** 3mm above bins
- **Max height:** `floor((drawerHeight - baseplateHeight - clearance - baseHeight) / heightUnit)`

## Directory Structure

```
gridfinity/
├── src/                        # Pipeline tools
│   ├── gridfinity-intake.js    # STL collection scanner
│   ├── gridfinity-layout.js    # Grid analysis + preview
│   ├── gridfinity-fit.js       # Item placement engine
│   ├── gridfinity-render.js    # HTML layout preview
│   ├── gridfinity-export-3mf.js# Bambu Studio 3MF export
│   ├── gridfinity-generate-pdf.js # Print checklist
│   └── stl-utils.js            # STL parser + bounding box
├── packs/                      # Pack manifests (JSON)
├── STLs/                       # Your downloaded STLs (gitignored)
└── projects/                   # Generated project data (gitignored)
```

## License

MIT
