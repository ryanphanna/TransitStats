#!/bin/zsh
# Packs the V5 tuning job for Colab: the training code plus your exported trips and stops.
# Output: ml/lab/data/colab/ts-bundle.zip (gitignored; it holds trip data). Upload it
# with the Colab CLI (see ml/lab/README.md, Colab), or to My Drive/TransitStats/ for a browser run.
# Needs ml/trips.csv (ml/export_trips.py) and ml/lab/data/colab/stops.json.
set -e
cd "$(dirname "$0")/../.."
D=ml/lab/data/colab
[ -f ml/trips.csv ] && [ -f $D/stops.json ] || { echo "Run the export first (see ml/lab/README.md, Colab)"; exit 1; }
rm -f $D/ts-bundle.zip
# Keeps the repo layout: stop_canon.py reads ../js/shared/agency-aliases.js.
cp $D/stops.json ml/stops.json
zip -q $D/ts-bundle.zip ml/train_endstop.py ml/route_normalization.py ml/stop_canon.py ml/policies.json ml/trips.csv ml/stops.json js/shared/agency-aliases.js
rm ml/stops.json
echo "Wrote $D/ts-bundle.zip"
