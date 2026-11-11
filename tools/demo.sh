#!/usr/bin/env bash
# Crea sesiones falsas con todos los estados para ver los sprites.
#   tools/demo.sh          crea las sesiones demo
#   tools/demo.sh --clean  las borra
set -euo pipefail
DIR="${XDG_STATE_HOME:-$HOME/.local/state}/iamigos/sessions"
mkdir -p "$DIR"

if [ "${1:-}" = "--clean" ]; then
  rm -f "$DIR"/demo-*.json
  exit 0
fi

now=$(date +%s)
i=0
for st in idle working permission asking compacting done asleep error; do
  since=$now
  [ "$st" = asleep ] && { since=$((now - 3600)); st_file=done; } || st_file=$st
  cat > "$DIR/demo-$st.json" <<EOF
{"v":1,"agent":"claude","id":"demo-$st","state":"$st_file","detail":"Bash","cwd":"/tmp/$st","project":"$st","pid":0,"started":$((now + i)),"since":$since,"updated":$now}
EOF
  i=$((i + 1))
done
# pid de un proceso que no existe → la extensión lo muestra como "cerrada"
cat > "$DIR/demo-closed.json" <<EOF
{"v":1,"agent":"opencode","id":"demo-closed","state":"working","detail":"","cwd":"/tmp/closed","project":"closed","pid":999999,"started":$((now + 99)),"since":$now,"updated":$now}
EOF
echo "Sesiones demo creadas en $DIR (pid 0 = siempre vivas). Bórralas con: $0 --clean"
