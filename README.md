# Cherry Blossom Watch

Cherry blossom forecasts for every public tree, plus a cultivar tier list. Region: Greater Victoria, Vancouver Island, Vancouver.

**Live dashboard: https://markandrewjenkins.github.io/cherry-blossom-watch/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Trees:** City of Vancouver *public-trees* (29.8k Prunus), City of Victoria *Tree Species* (5.5k) and the Township of Esquimalt tree map (953), mapped to 32 cultivars and six bloom groups. Areas without inventories show CC-licensed iNaturalist sightings.
- **Observed bloom dates:** Each year's median iNaturalist observation date per region and taxon, within the group's flowering window. Photos annotated as "no flowers" are excluded.
- **Weather:** ECCC daily climate, with station chains spliced after a monthly bias adjustment. Victoria runs from 1898 (Gonzales Heights → Gonzales CS).
- **Models:** Climatology, thermal time, chill-adjusted thermal time and a temperature-sensitivity regression, pooled across regions and selected by leave-one-year-out cross-validated MAE.
  - Japanese cherries borrow the best donor's temperature response, because their own index is too noisy to fit one.
- **Forecast:** An analog-weather ensemble from the last 30 seasons combined with the model's cross-validated residuals. The resulting 80% intervals cover 78–88% of outcomes in backtests.
- **Map modes:** colour trees by bloom chance (the default) or by cultivar tier (S–D, each tree icon lettered). Filter with a searchable checklist of individual cultivars, or with tier and group chips that tick or untick theirs. In the tier list, Somei-yoshino, Japan's reference hanami cherry, leads the S tier.

## Design

The page has a Classic design and a themed alternative, **Sakura.exe** (pastel win95 desktop / "after hours" vaporwave), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.blossom.fetch all
.venv/Scripts/python -m pipelines.blossom.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
