#!/bin/sh
# Ship the current commit to the Synology NAS and rebuild the wiki's container.
#
#   scripts/deploy.sh [ssh-host]      (default host: synology-livingimpact, from ~/.ssh/config)
#
# The compose file and .env live in /volume1/docker/aiwiki, the source in src/ next to them and
# the wiki's data in data/. Only src/ is replaced; the data and settings are left alone.
#
# The new version is built while the old one keeps running. Before the switch, it waits for a
# moment when the assistant is not in use (scripts/wait-quiet.mjs): no chat reply running, none in
# the last few minutes, and no filing job working (new ones are held meanwhile). WAIT_MINUTES
# (default 30) caps the wait; past it the wiki is left running as it was.
set -e

HOST=${1:-synology-livingimpact}
DIR=/volume1/docker/aiwiki
SRC=$DIR/src
COMMIT=$(git rev-parse --short HEAD)

if ! git diff --quiet HEAD; then
  echo "Uncommitted changes; commit before deploying." >&2
  exit 1
fi

echo "Uploading $COMMIT to $HOST:$SRC"
git archive --format=tar HEAD | ssh "$HOST" "set -e
  rm -rf $SRC.new && mkdir -p $SRC.new
  tar -x -C $SRC.new
  echo $COMMIT > $SRC.new/DEPLOYED_COMMIT
  rm -rf $SRC && mv $SRC.new $SRC"

echo "Building on $HOST (several minutes)"
ssh "$HOST" "set -e; cd $DIR; export PATH=\$PATH:/usr/local/bin; docker compose build app"

echo "Waiting for the assistant to be free"
ssh "$HOST" "export PATH=\$PATH:/usr/local/bin
  [ \"\$(docker inspect -f '{{.State.Running}}' aiwiki_app 2>/dev/null)\" = true ] || exit 0
  docker exec -i -e WAIT_MINUTES=${WAIT_MINUTES:-30} aiwiki_app node --input-type=module -" < "$(dirname "$0")/wait-quiet.mjs"

echo "Restarting on $HOST"
ssh "$HOST" "set -e
  cd $DIR
  export PATH=\$PATH:/usr/local/bin
  docker compose up -d app
  for i in \$(seq 1 60); do
    s=\$(docker inspect -f '{{.State.Health.Status}}' aiwiki_app)
    [ \"\$s\" = healthy ] && echo 'The wiki is up' && docker image prune -f >/dev/null && exit 0
    sleep 3
  done
  echo 'The wiki did not come up; recent logs:' >&2
  docker logs --tail 40 aiwiki_app >&2
  exit 1"
