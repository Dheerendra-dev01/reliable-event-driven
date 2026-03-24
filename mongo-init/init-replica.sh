#!/bin/bash
set -e

echo "[mongo-init] Waiting for mongo1 to be ready..."

until mongosh --host mongo1 --port 27017 --eval "db.adminCommand('ping')" --quiet; do
  echo "[mongo-init] mongo1 not ready yet, retrying in 2s..."
  sleep 2
done

echo "[mongo-init] mongo1 is ready. Waiting for mongo2..."

until mongosh --host mongo2 --port 27018 --eval "db.adminCommand('ping')" --quiet; do
  echo "[mongo-init] mongo2 not ready yet, retrying in 2s..."
  sleep 2
done

echo "[mongo-init] mongo2 is ready. Waiting for mongo3..."

until mongosh --host mongo3 --port 27019 --eval "db.adminCommand('ping')" --quiet; do
  echo "[mongo-init] mongo3 not ready yet, retrying in 2s..."
  sleep 2
done

echo "[mongo-init] All MongoDB nodes are ready. Initiating replica set..."

mongosh --host mongo1 --port 27017 --eval "
  const status = rs.status();
  if (status.ok === 1) {
    print('[mongo-init] Replica set already initialized, skipping.');
  } else {
    print('[mongo-init] Initializing replica set rs0...');
    rs.initiate({
      _id: 'rs0',
      members: [
        { _id: 0, host: 'mongo1:27017' },
        { _id: 1, host: 'mongo2:27018' },
        { _id: 2, host: 'mongo3:27019' }
      ]
    });
    print('[mongo-init] rs.initiate() called successfully.');
  }
" 2>/dev/null || mongosh --host mongo1 --port 27017 --eval "
  print('[mongo-init] Initializing replica set rs0 (first time)...');
  rs.initiate({
    _id: 'rs0',
    members: [
      { _id: 0, host: 'mongo1:27017' },
      { _id: 1, host: 'mongo2:27018' },
      { _id: 2, host: 'mongo3:27019' }
    ]
  });
  print('[mongo-init] rs.initiate() called successfully.');
"

echo "[mongo-init] Sleeping 10 seconds to allow primary election to complete..."
sleep 10

echo "[mongo-init] Verifying replica set status..."
mongosh --host mongo1 --port 27017 --eval "
  const status = rs.status();
  print('[mongo-init] Replica set state: ' + JSON.stringify(status.members.map(m => ({ name: m.name, stateStr: m.stateStr }))));
"

echo "[mongo-init] Replica set initialization complete."
