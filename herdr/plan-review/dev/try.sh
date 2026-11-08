#!/bin/sh
# Try the plan-review mod in the Herdr TEST window (~/.hrt, started with ~/.hrt/start.sh), on an
# isolated agent-plan-review store and port. Never touches ~/.config/herdr-app or ~/.agent-plan-review.
#   dev/try.sh [store]     build, install the mod into the test window, enable Herdr in the store,
#                          open a fake agent tab with the plan view beside it; prints the terminal
#   dev/try.sh --stop [store]   stop that store's server, uninstall the mod, drop its pointer files
# Then, as the agent (from any shell):
#   HC_TERMINAL_ID=<terminal> AGENT_PLAN_REVIEW_HOME=<store> AGENT_PLAN_REVIEW_PORT=4621 \
#     HERDR_APP_HOME=~/.hrt/app node dev/agent.mjs submit <cwd> <plan.md>
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
T="$HOME/.hrt/app"
stop=false
[ "${1:-}" = --stop ] && { stop=true; shift; }
store=${1:-${TMPDIR:-/tmp}/apr-herdr-try}
export AGENT_PLAN_REVIEW_HOME="$store" AGENT_PLAN_REVIEW_PORT=4621 HERDR_APP_HOME="$T"
cli="node $repo/dist/server/cli.js"

if $stop; then
  pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$store/server.json" 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  $cli herdr uninstall || true
  rm -f "$T/data/plan-review/"*.json
  echo "stopped (store kept: $store)"; exit 0
fi

(cd "$repo" && npm run -s build:server)
mkdir -p "$store"
$cli herdr enable
$cli herdr install
herdr-app status >/dev/null 2>&1 || { echo "start the test window first: ~/.hrt/start.sh" >&2; exit 1; }
agent=$HOME/.config/herdr-app/mods/plan-proto/flip/fake-agent.sh
term=$(herdr-app do tab.new --name "plan agent" --argv "[\"$agent\",\"Plan agent\",\"blocked\",\"Plan waits for your review\"]" | python3 -c 'import json,sys; print(json.load(sys.stdin)["terminal"])')
# A just-installed mod folder takes Herdr a moment to see.
i=0; until herdr-app do pane.split --direction right --mod plan-review >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 20 ] && { echo "Herdr did not load mods/plan-review (see ~/.hrt/app.log)" >&2; exit 1; }; sleep 0.5
done
echo "store: $store  port: 4621  agent terminal: $term"
