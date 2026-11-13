#!/bin/sh
# Ship the current commit to the Synology NAS and rebuild the wiki's container.
#
#   scripts/deploy.sh [ssh-host]      (default host: synology-livingimpact, from ~/.ssh/config)
#
# The compose file and .env live in /volume1/docker/aiwiki, the source in src/ next to them and
# the wiki's data in data/. Only src/ is replaced; the data and settings are left alone.
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

echo "Rebuilding on $HOST (several minutes)"
ssh "$HOST" "set -e
  cd $DIR
  export PATH=\$PATH:/usr/local/bin
  docker compose up -d --build app
  for i in \$(seq 1 60); do
    s=\$(docker inspect -f '{{.State.Health.Status}}' aiwiki_app)
    [ \"\$s\" = healthy ] && echo 'The wiki is up' && docker image prune -f >/dev/null && exit 0
    sleep 3
  done
  echo 'The wiki did not come up; recent logs:' >&2
  docker logs --tail 40 aiwiki_app >&2
  exit 1"
